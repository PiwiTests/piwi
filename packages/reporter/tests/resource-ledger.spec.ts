import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestInfo } from '@playwright/test';
import {
  ResourceLedger,
  activeResourceLedger,
  leakFailureMessage,
  readLeakCheck,
  recordResourceCensus,
  startResourceLedger,
  stopResourceLedger,
  userSite,
  type ResourceCensus,
  type TestInfoLike,
} from '../src/internal/capture/resource-ledger.js';
import { piwiFixtures } from '../src/internal/capture/capture-fixtures.js';
import { ATTACHMENT_NAMES } from '../src/internal/capture/attachments.js';
import { applyOptionsToEnv, resolveOptions, PIWI_ENV_KEYS } from '../src/internal/config/env.js';

type Listener = Record<string, (...args: any[]) => any>;

/** A stand-in for Playwright's client: calls are reported to the listeners the way `_wrapApiCall` reports them. */
function fakePlaywright() {
  const listeners: Listener[] = [];
  const instrumentation = {
    addListener: (l: object) => void listeners.push(l as Listener),
    removeListener: (l: object) => void listeners.splice(listeners.indexOf(l as Listener), 1),
  };
  const notify = (hook: string, ...args: unknown[]) => Promise.all(listeners.map((l) => l[hook]?.(...args)));
  /** Run `body` as a reported API call named `apiName`, made from `file:line`. */
  async function apiCall<T>(apiName: string, body: () => Promise<T> | T, file = 'tests/cart.spec.ts', line = 7) {
    const zone = { apiName, frames: [{ file: path.resolve(file), line }] };
    for (const l of listeners) l.onApiCallBegin?.(zone);
    try {
      return await body();
    } finally {
      for (const l of listeners) l.onApiCallEnd?.(zone);
    }
  }

  class FakePage extends EventEmitter {
    closed = false;
    /** Calls made as internal ones, which Playwright never reports. */
    internal = false;
    _routes: unknown[] = [];
    _opener: FakePage | null = null;
    private current = 'about:blank';
    readonly frame = { url: () => this.current };
    constructor(readonly context: FakeContext) {
      super();
    }
    url() {
      return this.current;
    }
    mainFrame() {
      return this.frame;
    }
    goto(url: string) {
      this.current = url;
      this.emit('framenavigated', this.frame);
    }
    evaluate() {
      return this.internal ? Promise.resolve(2) : apiCall('page.evaluate', () => 2);
    }
    async close() {
      if (this.closed) return;
      this.closed = true;
      this.emit('close', this);
    }
  }

  class FakeContext extends EventEmitter {
    readonly all: FakePage[] = [];
    _routes: unknown[] = [];
    _ownerPage: FakePage | undefined;
    closed = false;
    constructor(readonly owner: FakeBrowser | null) {
      super();
    }
    browser() {
      return this.owner;
    }
    pages() {
      return this.all.filter((p) => !p.closed);
    }
    /** A page this context opens on its own, as a popup does. */
    popup(opener: FakePage) {
      const page = new FakePage(this);
      page._opener = opener;
      this.all.push(page);
      this.emit('page', page);
      return page;
    }
    newPage() {
      return apiCall('browserContext.newPage', () => {
        const page = new FakePage(this);
        this.all.push(page);
        this.emit('page', page);
        return page;
      });
    }
    async close() {
      if (this.closed) return;
      this.closed = true;
      for (const page of this.pages()) await page.close();
      this.emit('close', this);
    }
  }

  class FakeBrowser extends EventEmitter {
    readonly contexts: FakeContext[] = [];
    async newContext() {
      const context = new FakeContext(this);
      this.contexts.push(context);
      await notify('runAfterCreateBrowserContext', context);
      return context;
    }
    newPage() {
      return apiCall('browser.newPage', async () => {
        const context = await this.newContext();
        const page = await context.newPage();
        context._ownerPage = page;
        return page;
      });
    }
    async close() {
      for (const context of this.contexts) await context.close();
      this.emit('disconnected', this);
    }
  }

  const request = {
    async newContext() {
      const context = { dispose: vi.fn(async () => notify('runBeforeCloseRequestContext', context)) };
      await notify('runAfterCreateRequestContext', context);
      return context;
    },
  };

  const playwright = {
    _instrumentation: instrumentation,
    chromium: { launch: async () => new FakeBrowser() },
    request,
  };
  return { playwright, listeners, FakeBrowser, apiCall };
}

/** A test info Playwright would hold, with what it is running. */
function info(
  id: string,
  runnable: { type?: string; fixture?: { title: string; location?: { file: string; line: number }; slot?: unknown } } = {},
  suite: string[] = [],
): TestInfoLike {
  return {
    testId: id,
    title: `title ${id}`,
    file: path.resolve('tests/cart.spec.ts'),
    titlePath: ['cart.spec.ts', ...suite, `title ${id}`],
    _timeoutManager: { _running: { runnable } },
  };
}

function ledgerFor(fake: ReturnType<typeof fakePlaywright>, options: { leakCheck?: 'report' | 'fail' | 'close'; resultsFile?: string } = {}) {
  let current: TestInfoLike | null = null;
  const ledger = new ResourceLedger(
    fake.playwright,
    3,
    options.leakCheck ?? 'report',
    options.resultsFile ?? null,
    () => current,
  );
  return {
    ledger,
    running: (value: TestInfoLike | null) => {
      current = value;
    },
  };
}

afterEach(() => {
  stopResourceLedger();
  delete process.env[PIWI_ENV_KEYS.captureResources];
  delete process.env[PIWI_ENV_KEYS.leakCheck];
});

describe('ResourceLedger', () => {
  it('installs only on a Playwright that reports its calls', () => {
    expect(new ResourceLedger({}, 0, 'report', null, () => null).install()).toBe(false);
    const fake = fakePlaywright();
    expect(ledgerFor(fake).ledger.install()).toBe(true);
    expect(fake.listeners).toHaveLength(1);
  });

  it('records where each object was opened, by what Playwright was running', async () => {
    const fake = fakePlaywright();
    const { ledger, running } = ledgerFor(fake);
    ledger.install();
    running(info('t1', { type: 'beforeAll' }, ['block']));
    const browser = await fake.playwright.chromium.launch();
    const context = await browser.newContext();
    running(info('t1', { type: 'test', fixture: { title: 'shared', location: { file: path.resolve('tests/fixtures.ts'), line: 9 }, slot: {} } }));
    await (await browser.newContext()).newPage();
    running(null);
    await browser.newContext();

    const { census } = await ledger.testEnded(info('t1'));
    expect(census.born.map((b) => [b.id, b.kind, b.phase, b.parent])).toEqual([
      [1, 'browser', 'beforeAll', null],
      [2, 'context', 'beforeAll', 1],
      [3, 'context', 'test', 1],
      [4, 'page', 'test', 3],
      [5, 'context', 'worker', 1],
    ]);
    expect(census.born[0]!.test).toEqual({ id: 't1', file: 'tests/cart.spec.ts', suite: ['block'] });
    expect(census.born[0]!.site).toMatch(/^tests\/resource-ledger\.spec\.ts:\d+$/);
    expect(census.born[2]!.fixture).toEqual({ title: 'shared', location: 'tests/fixtures.ts:9', worker: true });
    expect(census.born[3]!.site).toBe('tests/cart.spec.ts:7');
    expect(context).toBeDefined();
  });

  it("names a popup's opener and the call that opened it", async () => {
    const fake = fakePlaywright();
    const { ledger, running } = ledgerFor(fake);
    ledger.install();
    running(info('t1'));
    const browser = await fake.playwright.chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await fake.apiCall('locator.click', () => context.popup(page as never), 'tests/cart.spec.ts', 21);

    const { census } = await ledger.testEnded(info('t1'));
    const popup = census.born.find((b) => b.id === 4)!;
    expect(popup).toMatchObject({ kind: 'page', opener: 3, trigger: 'locator.click', site: 'tests/cart.spec.ts:21' });
    expect(census.born.find((b) => b.id === 3)).not.toHaveProperty('opener');
  });

  it('marks a page used when it loads something or runs a reported call, never on its own reads', async () => {
    const fake = fakePlaywright();
    const { ledger, running } = ledgerFor(fake);
    ledger.install();
    running(info('t1'));
    const browser = await fake.playwright.chromium.launch();
    const context = await browser.newContext();
    const [blank, loaded, navigated, evaluated, quiet] = await Promise.all(
      Array.from({ length: 5 }, () => context.newPage()),
    );
    blank!.goto('about:blank');
    loaded!.emit('load');
    navigated!.goto('https://shop.test/cart');
    await evaluated!.evaluate();
    // An internal call reaches no listener, as Piwi's own reads do not.
    quiet!.internal = true;
    await quiet!.evaluate();

    const { census } = await ledger.testEnded(info('t1'));
    const used = Object.fromEntries(census.open.filter((o) => o.used !== undefined).map((o) => [o.id, o.used]));
    expect(used).toEqual({ 3: false, 4: true, 5: true, 6: true, 7: false });
    expect(census.open.find((o) => o.id === 5)?.url).toBe('https://shop.test/cart');
  });

  it('takes a census per test: what was born and closed since the last one, and what is open', async () => {
    const fake = fakePlaywright();
    const { ledger, running } = ledgerFor(fake);
    ledger.install();
    running(info('t1'));
    ledger.testStarted(info('t1'));
    const browser = await fake.playwright.chromium.launch();
    const context = await browser.newContext();
    await context.newPage();
    const first = await ledger.testEnded(info('t1'));
    expect(first.census).toMatchObject({ v: 1, worker: 3, test: { id: 't1', title: 'title t1' } });
    expect(first.census.born).toHaveLength(3);
    expect(first.census.handles).toEqual({ start: expect.any(Object), end: expect.any(Object) });

    running(info('t2'));
    ledger.testStarted(info('t2'));
    await context.close();
    const second = await ledger.testEnded(info('t2'));
    expect(second.census.born).toEqual([]);
    expect(second.census.closed.map((c) => [c.id, c.used])).toEqual([
      [3, false],
      [2, undefined],
    ]);
    expect(second.census.open.map((o) => o.id)).toEqual([1]);
  });

  it('counts what was open when a test started, and what it left open', async () => {
    const fake = fakePlaywright();
    const { ledger, running } = ledgerFor(fake);
    ledger.install();
    running(info('t1'));
    ledger.testStarted(info('t1'));
    const browser = await fake.playwright.chromium.launch();
    await (await browser.newContext()).newPage();
    const first = await ledger.testEnded(info('t1'));
    expect(first.census).toMatchObject({ openAtStart: { contexts: 0, pages: 0 }, leftOpen: 1 });

    running(info('t2'));
    ledger.testStarted(info('t2'));
    const second = await ledger.testEnded(info('t2'));
    expect(second.census).toMatchObject({ openAtStart: { contexts: 1, pages: 1 }, leftOpen: 0 });
  });

  it('lists what the test itself left open, folding pages into their context and browser', async () => {
    const fake = fakePlaywright();
    const { ledger, running } = ledgerFor(fake);
    ledger.install();
    running(info('t1', { type: 'test', fixture: { title: 'browser', slot: {} } }));
    const browser = await fake.playwright.chromium.launch();
    running(info('t1', { type: 'test', fixture: { title: 'context' } }));
    await browser.newContext();
    running(info('t1', { type: 'beforeAll' }));
    await browser.newContext();
    running(info('t1'));
    const context = await browser.newContext();
    await context.newPage();
    await browser.newPage();
    const launched = await fake.playwright.chromium.launch();
    await launched.newPage();

    const { leaks } = await ledger.testEnded(info('t1'));
    expect(leaks.map((l) => [l.kind, l.pages])).toEqual([
      ['browser', 1],
      ['context', 1],
      ['page', 0],
    ]);
  });

  it('closes what the test left open under PIWI_LEAK_CHECK=close, and says so', async () => {
    const fake = fakePlaywright();
    const { ledger, running } = ledgerFor(fake, { leakCheck: 'close' });
    ledger.install();
    running(info('t1', { type: 'test', fixture: { title: 'browser', slot: {} } }));
    const browser = await fake.playwright.chromium.launch();
    running(info('t1'));
    const context = await browser.newContext();
    await context.newPage();
    const api = await fake.playwright.request.newContext();

    running(info('t1', { type: 'test', fixture: { title: 'piwiCapture' } }));
    const { census } = await ledger.testEnded(info('t1'));
    expect((context as unknown as { closed: boolean }).closed).toBe(true);
    expect(api.dispose).toHaveBeenCalled();
    expect(census.closed.filter((c) => c.byPiwi).map((c) => c.id).sort()).toEqual([2, 4]);
    expect(census.open.map((o) => o.id)).toEqual([1]);
  });

  it('leaves alone what a failed test left open, its worker shutting down right after it', async () => {
    const fake = fakePlaywright();
    const { ledger, running } = ledgerFor(fake, { leakCheck: 'close' });
    ledger.install();
    running(info('t1'));
    const browser = await fake.playwright.chromium.launch();
    const context = await browser.newContext();

    const { census, leaks } = await ledger.testEnded({ ...info('t1'), status: 'failed', expectedStatus: 'passed' });
    expect(leaks).toEqual([]);
    expect((context as unknown as { closed: boolean }).closed).toBe(false);
    expect(census.test).toMatchObject({ id: 't1', failed: true });
    const expected = await ledger.testEnded({ ...info('t2'), status: 'failed', expectedStatus: 'failed' });
    expect(expected.census.test).not.toHaveProperty('failed');
  });

  it("adds the test's metrics and the open pages' main thread to its census", async () => {
    const fake = fakePlaywright();
    const metrics = { start: vi.fn(), end: vi.fn(() => ({ worker: { cpuMs: 12 } })), dispose: vi.fn() };
    const pages = { read: vi.fn(async () => ({ cpuMs: 30, heapMb: 1, nodes: 5, listeners: 2 })) };
    const ledger = new ResourceLedger(fake.playwright, 0, 'report', null, () => null, Date.now, {
      metrics: metrics as never,
      pages: pages as never,
    });
    ledger.install();
    ledger.testStarted(info('t1'));
    const browser = await fake.playwright.chromium.launch();
    await (await browser.newContext()).newPage();

    const { census } = await ledger.testEnded(info('t1'));
    expect(metrics.start).toHaveBeenCalled();
    expect(census.metrics).toEqual({ worker: { cpuMs: 12 } });
    expect(census.open.find((o) => o.id === 3)?.main).toEqual({ cpuMs: 30, heapMb: 1, nodes: 5, listeners: 2 });
    ledger.workerEnded();
    expect(metrics.dispose).toHaveBeenCalled();
  });

  it('appends its shutdown census to the results file and stops listening', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-ledger-')), 'results.jsonl');
    const fake = fakePlaywright();
    const { ledger } = ledgerFor(fake, { resultsFile: file });
    ledger.install();
    const browser = await fake.playwright.chromium.launch();
    await browser.newContext();
    ledger.workerEnded();
    const census = JSON.parse(fs.readFileSync(file, 'utf8').trim()) as ResourceCensus;
    expect(census.test).toBeNull();
    expect(census.open.map((o) => o.id)).toEqual([1, 2]);
    expect(fake.listeners).toHaveLength(0);
  });
});

describe('userSite', () => {
  it('returns the first frame of the test code, relative to the working directory', () => {
    const stack = [
      'Error',
      `    at ResourceLedger.track (${path.resolve('src/internal/capture/resource-ledger.ts')}:10:5)`,
      `    at Object.<anonymous> (${path.resolve('node_modules/playwright-core/lib/coreBundle.js')}:1:1)`,
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
      `    at async Context.<anonymous> (${path.resolve('tests/cart.spec.ts')}:18:21)`,
    ].join('\n');
    expect(userSite(stack)).toBe('tests/cart.spec.ts:18');
    expect(userSite('Error\n    at node:internal/timers:485:7')).toBeNull();
  });
});

describe('leakFailureMessage', () => {
  it('names each object and the line that opened it', () => {
    expect(
      leakFailureMessage([
        { id: 1, kind: 'context', site: 'tests/cart.spec.ts:4', pages: 1, implicit: false },
        { id: 2, kind: 'page', site: 'tests/cart.spec.ts:24', pages: 0, implicit: false, trigger: 'locator.click' },
      ]),
    ).toBe(
      [
        'Piwi: this test left 2 objects open:',
        '  - a context opened at tests/cart.spec.ts:4, with 1 page',
        '  - a popup opened by locator.click at tests/cart.spec.ts:24',
        'Close each before the test ends (await using, close() or dispose()), or set PIWI_LEAK_CHECK=report to only list them.',
      ].join('\n'),
    );
  });
});

describe('options', () => {
  it('reads the leak check mode, anything unknown being report', () => {
    expect(readLeakCheck('fail')).toBe('fail');
    expect(readLeakCheck('close')).toBe('close');
    expect(readLeakCheck('loud')).toBe('report');
    expect(readLeakCheck(undefined)).toBe('report');
  });

  it('takes captureResources and leakCheck from the environment and bridges explicit values to the workers', () => {
    process.env[PIWI_ENV_KEYS.captureResources] = 'false';
    process.env[PIWI_ENV_KEYS.leakCheck] = 'fail';
    expect(resolveOptions({})).toMatchObject({ captureResources: false, leakCheck: 'fail' });
    delete process.env[PIWI_ENV_KEYS.captureResources];
    delete process.env[PIWI_ENV_KEYS.leakCheck];
    expect(resolveOptions({})).toMatchObject({ captureResources: true, leakCheck: 'report' });

    applyOptionsToEnv({});
    expect(process.env[PIWI_ENV_KEYS.captureResources]).toBeUndefined();
    expect(process.env[PIWI_ENV_KEYS.leakCheck]).toBeUndefined();
    applyOptionsToEnv({ captureResources: false, leakCheck: 'close' });
    expect(process.env[PIWI_ENV_KEYS.captureResources]).toBe('false');
    expect(process.env[PIWI_ENV_KEYS.leakCheck]).toBe('close');
  });
});

describe('the worker ledger and the capture fixture', () => {
  const testInfo = (attach: ReturnType<typeof vi.fn>) =>
    ({
      testId: 't1',
      title: 'title t1',
      file: path.resolve('tests/cart.spec.ts'),
      titlePath: ['cart.spec.ts', 'title t1'],
      status: 'passed',
      expectedStatus: 'passed',
      annotations: [],
      attach,
    }) as unknown as TestInfo;

  it('starts once per worker, unless PIWI_CAPTURE_RESOURCES=false', () => {
    process.env[PIWI_ENV_KEYS.captureResources] = 'false';
    expect(startResourceLedger(fakePlaywright().playwright, 0)).toBeNull();
    delete process.env[PIWI_ENV_KEYS.captureResources];
    const ledger = startResourceLedger(fakePlaywright().playwright, 0);
    expect(ledger).not.toBeNull();
    expect(startResourceLedger(fakePlaywright().playwright, 0)).toBe(ledger);
    expect(stopResourceLedger()).toMatchObject({ test: null });
    expect(activeResourceLedger()).toBeNull();
  });

  it('attaches each test census, and fails a test that leaked under PIWI_LEAK_CHECK=fail', async () => {
    process.env[PIWI_ENV_KEYS.leakCheck] = 'fail';
    const fake = fakePlaywright();
    const ledger = startResourceLedger(fake.playwright, 0)!;
    const attach = vi.fn(async (_name: string, _body: { body: Buffer }) => {});
    ledger.testStarted(testInfo(attach) as unknown as TestInfoLike);
    const browser = await fake.playwright.chromium.launch();
    await browser.newContext();

    await expect(recordResourceCensus(testInfo(attach))).rejects.toThrow(/^Piwi: this test left one object open:/);
    expect(attach).toHaveBeenCalledWith(ATTACHMENT_NAMES.resources, expect.objectContaining({ contentType: 'application/json' }));
    const census = JSON.parse(String(attach.mock.calls[0]![1].body)) as ResourceCensus;
    expect(census.born.map((b) => b.kind)).toEqual(['browser', 'context']);
  });

  it('runs the census at the end of every test through piwiCapture, and registers the worker fixture', async () => {
    const [workerFixture, workerOptions] = piwiFixtures.piwiResources as unknown as [unknown, object];
    expect(typeof workerFixture).toBe('function');
    expect(workerOptions).toEqual({ scope: 'worker', auto: true });

    startResourceLedger(fakePlaywright().playwright, 0);
    const attach = vi.fn(async () => {});
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, info: unknown) => Promise<void>,
    ];
    await captureFixture({}, async () => {}, testInfo(attach));
    expect(attach.mock.calls.map((call) => (call as unknown[])[0])).toContain(ATTACHMENT_NAMES.resources);
  });
});
