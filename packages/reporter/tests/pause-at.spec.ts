import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installPickerOverlay,
  pauseAnswered,
  showPauseBar,
  showPickerChoices,
  takePauseState,
} from '@piwitests/picker-dom';
import {
  assertionLabel,
  parsePauseAt,
  pauseHere,
  pausePlace,
  pauseSkipReason,
  pickPayload,
  postPickToEditor,
  rearmedTimeout,
  resetPauseLogs,
  type PausePoint,
} from '../src/internal/capture/pause-at.js';
import { piwiFixtures, probeElementAttrs, CAPTURED_ATTRS_ARG } from '../src/internal/capture/capture-fixtures.js';
import { ATTACHMENT_NAMES } from '../src/internal/capture/attachments.js';
import type { LocatorSnapshot } from '../src/internal/capture/locator-healing.js';
import { jsonRes, startServer } from './_helpers.js';

const PROBE = { fn: probeElementAttrs, arg: CAPTURED_ATTRS_ARG };

describe('parsePauseAt', () => {
  const cwd = path.resolve('/work/shop');

  it('matches a call site on a listed line, whatever its column', () => {
    const set = parsePauseAt('tests/login.spec.ts:42; tests/pages/checkout.page.ts:9', cwd);
    expect(set.size).toBe(2);
    expect(set.matches('tests/login.spec.ts:42:5')).toBe(true);
    expect(set.matches('tests/login.spec.ts:42:17')).toBe(true);
    expect(set.matches('tests/pages/checkout.page.ts:9:21')).toBe(true);
    expect(set.matches('tests/login.spec.ts:43:5')).toBe(false);
    expect(set.matches('tests/other.spec.ts:42:5')).toBe(false);
    expect(set.matches(null)).toBe(false);
  });

  it('reads absolute paths, backslashes and ./ the way call sites are written', () => {
    const set = parsePauseAt(
      `${path.join(cwd, 'tests', 'login.spec.ts')}:42;./tests/a.spec.ts:3;tests\\b.spec.ts:4;../shared/c.ts:5`,
      cwd,
    );
    expect(set.matches('tests/login.spec.ts:42:1')).toBe(true);
    expect(set.matches('tests/a.spec.ts:3:1')).toBe(true);
    expect(set.matches('tests/b.spec.ts:4:1')).toBe(true);
    expect(set.matches('../shared/c.ts:5:1')).toBe(true);
  });

  it('reads a path holding a comma', () => {
    const set = parsePauseAt('tests/a,b.spec.ts:7;tests/c.spec.ts:2', cwd);
    expect(set.size).toBe(2);
    expect(set.matches('tests/a,b.spec.ts:7:3')).toBe(true);
    expect(set.matches('tests/c.spec.ts:2:3')).toBe(true);
  });

  it('is empty for an unset value and skips an entry without a line, saying so once', () => {
    resetPauseLogs();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(parsePauseAt(undefined, cwd).size).toBe(0);
      expect(parsePauseAt(' ', cwd).size).toBe(0);
      expect(parsePauseAt('tests/a.spec.ts;tests/b.spec.ts:0;:4;', cwd).size).toBe(0);
      expect(parsePauseAt('tests/a.spec.ts;tests/c.spec.ts:1', cwd).size).toBe(1);
      expect(log.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
        '[piwi] PIWI_PAUSE_AT: ignoring "tests/a.spec.ts": expected file:line',
        '[piwi] PIWI_PAUSE_AT: ignoring "tests/b.spec.ts:0": expected file:line',
        '[piwi] PIWI_PAUSE_AT: ignoring ":4": expected file:line',
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('the pause gate', () => {
  it('pauses a headed local run only', () => {
    expect(pauseSkipReason({ ci: undefined, headless: false })).toBeNull();
    expect(pauseSkipReason({ ci: 'false', headless: false })).toBeNull();
    expect(pauseSkipReason({ ci: 'true', headless: false })).toMatch(/running under CI/);
    expect(pauseSkipReason({ ci: undefined, headless: true })).toMatch(/headless/);
    expect(pauseSkipReason({ ci: undefined, headless: undefined })).toMatch(/headless/);
  });
});

describe('what the pause says', () => {
  it('gives the test back the time it had left once the pause ends', () => {
    expect(rearmedTimeout(30_000, 12_345)).toBe(42_345);
    expect(rearmedTimeout(0, 12_345)).toBe(0);
    expect(rearmedTimeout(30_000, -5)).toBe(30_000);
  });

  it('names the place, the assertion and the pick’s line', () => {
    expect(pausePlace('tests/login.spec.ts:42:5')).toBe('login.spec.ts:42');
    expect(assertionLabel('to.be.visible', false)).toBe('toBeVisible');
    expect(assertionLabel('to.have.text', true)).toBe('not.toHaveText');
    expect(pickPayload("getByRole('button')", 'tests/login.spec.ts:42:5')).toEqual({
      kind: 'locator',
      text: "getByRole('button')",
      at: { file: 'tests/login.spec.ts', line: 42 },
    });
    expect(pickPayload("getByRole('button')", '../shared/a.ts:3:1')).toEqual({
      kind: 'locator',
      text: "getByRole('button')",
    });
  });

  it('names no line for a call site outside the run’s folder, Windows-style absolute included', () => {
    for (const location of [
      'C:/work/shop/tests/a.spec.ts:3:1',
      'C:\\work\\shop\\a.spec.ts:3:1',
      '/work/a.spec.ts:3:1',
    ]) {
      expect(pickPayload("getByRole('button')", location)).toEqual({ kind: 'locator', text: "getByRole('button')" });
    }
  });
});

describe('postPickToEditor', () => {
  beforeEach(() => resetPauseLogs());

  it('posts the pick with the pairing token', async () => {
    const bodies: unknown[] = [];
    const server = await startServer((req, res) => {
      bodies.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(req.body) });
      jsonRes(res, 200, { inserted: true });
    });
    try {
      const token = 'abcdefghijklmnop_1234';
      const sent = await postPickToEditor(
        `${server.url}/piwi/send#${token}`,
        pickPayload('getByText("Pay")', 'tests/a.spec.ts:3:1'),
      );
      expect(sent).toBe(true);
      expect(bodies).toEqual([
        {
          url: '/piwi/send',
          auth: `Bearer ${token}`,
          body: { kind: 'locator', text: 'getByText("Pay")', at: { file: 'tests/a.spec.ts', line: 3 } },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('logs a refused post once and never throws', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const refuse = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
      const address = 'http://127.0.0.1:47211/piwi/send#abcdefghijklmnop_1234';
      const payload = pickPayload('getByText("Pay")', 'tests/a.spec.ts:3:1');
      expect(await postPickToEditor(address, payload, refuse)).toBe(false);
      const broken = vi.fn(async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch;
      expect(await postPickToEditor(address, payload, broken)).toBe(false);
      expect(await postPickToEditor('not a pairing', payload, broken)).toBe(false);
      expect(await postPickToEditor(undefined, payload, broken)).toBe(false);
      expect(log.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([
        '[piwi] Could not send the picked locator to the editor: the editor answered 401.',
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

/**
 * A page whose pause bar answers `answers` in turn, recording what it was shown. With `pick`, the element picker
 * picks an element the probe reads as `pick` and the first locator offered is confirmed; the overlay's own reads and
 * cleanups run on Node's `globalThis`.
 */
function fakePausePage(
  answers: Array<string | null>,
  opts: { breakAt?: number; navigateAt?: number; pick?: Record<string, unknown> } = {},
) {
  const shown: unknown[] = [];
  let takes = 0;
  let navigated = false;
  const g = globalThis as Record<string, unknown>;
  const page = {
    evaluate: vi.fn(async (fn: unknown, arg?: unknown) => {
      if (fn === showPauseBar) shown.push(arg);
      else if (fn === takePauseState) {
        if (opts.breakAt !== undefined && takes === opts.breakAt) throw new Error('Target page has been closed');
        if (opts.navigateAt === takes && !navigated) {
          navigated = true;
          throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
        }
        return takes < answers.length ? answers[takes++] : 'resume';
      } else if (fn === installPickerOverlay) g.__piwiPickState = opts.pick ? 'picked' : 'skipped';
      else if (fn === showPickerChoices) g.__piwiPickChoice = 0;
      else if (typeof fn === 'function' && String(fn).includes('__piwi')) return (fn as (a: unknown) => unknown)(arg);
      return null;
    }),
    evaluateHandle: vi.fn(async () => ({ evaluate: async () => opts.pick, dispose: async () => {} })),
    waitForFunction: vi.fn(async (_predicate: unknown) => {}),
    waitForLoadState: vi.fn(async () => {}),
    isClosed: () => opts.breakAt !== undefined && takes >= opts.breakAt,
  };
  return { page, shown };
}

function fakeTestInfo(timeout = 30_000, retry = 0) {
  const info = { timeout, retry, setTimeout: vi.fn((t: number) => (info.timeout = t)) };
  return info;
}

const POINT: PausePoint = {
  location: 'tests/login.spec.ts:42:5',
  action: 'click',
  locator: "getByRole('button', { name: 'Pay' })",
  target: null,
};

describe('pauseHere', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it('highlights the element, shows the bar, and gives the timeout back on Resume', async () => {
    const { page, shown } = fakePausePage(['resume']);
    const info = fakeTestInfo(30_000, 1);
    const hide = vi.fn(async () => {});
    const target = { highlight: vi.fn(async () => ({ dispose: hide })) };
    const choice = await pauseHere(page as never, info as never, { ...POINT, target }, PROBE, () => {});
    expect(choice).toBe('resume');
    expect(target.highlight).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
    expect(shown).toEqual([
      {
        place: 'login.spec.ts:42',
        attempt: 2,
        action: 'click',
        locator: "getByRole('button', { name: 'Pay' })",
        record: false,
      },
    ]);
    expect(info.setTimeout.mock.calls[0]).toEqual([0]);
    const rearmed = info.setTimeout.mock.calls[1]![0] as number;
    expect(rearmed).toBeGreaterThanOrEqual(30_000);
    expect(rearmed).toBeLessThan(31_000);
  });

  it('shows the bar again after a pick, and after a navigation took it away', async () => {
    const { page, shown } = fakePausePage([null, 'pick', 'step']);
    const info = fakeTestInfo();
    const picks: unknown[] = [];
    const choice = await pauseHere(page as never, info as never, POINT, PROBE, (p) => void picks.push(p));
    expect(choice).toBe('step');
    expect(shown).toHaveLength(3);
    expect(page.waitForFunction.mock.calls.filter((c) => c[0] === pauseAnswered)).toHaveLength(3);
    // The fake page has no picker to answer: the pick yields nothing, and the pause goes on.
    expect(picks).toEqual([]);
  });

  it('shows the bar again when a navigation lands as it is read, and resumes once the page closed', async () => {
    const { page, shown } = fakePausePage(['step'], { navigateAt: 0 });
    expect(await pauseHere(page as never, fakeTestInfo() as never, POINT, PROBE, () => {})).toBe('step');
    expect(shown).toHaveLength(2);
    expect(page.waitForLoadState).toHaveBeenCalledOnce();
    const closed = fakePausePage(['step'], { breakAt: 0 });
    expect(await pauseHere(closed.page as never, fakeTestInfo() as never, POINT, PROBE, () => {})).toBe('resume');
  });

  it('offers Record here when the editor can record, and shows the bar again once the recording ended', async () => {
    const { page, shown } = fakePausePage(['record', 'resume']);
    const recorded = vi.fn(async () => {});
    const choice = await pauseHere(page as never, fakeTestInfo() as never, POINT, PROBE, () => {}, recorded);
    expect(choice).toBe('resume');
    expect(recorded).toHaveBeenCalledOnce();
    expect(shown).toEqual([expect.objectContaining({ record: true }), expect.objectContaining({ record: true })]);
  });

  it('resumes when the page breaks, and leaves no timeout when the test had none', async () => {
    const { page } = fakePausePage([], { breakAt: 0 });
    const info = fakeTestInfo(0);
    expect(await pauseHere(page as never, info as never, POINT, PROBE, () => {})).toBe('resume');
    expect(info.setTimeout.mock.calls).toEqual([[0], [0]]);
  });
});

/** The 1-based line this function is called from, in this file. */
function thisLine(): number {
  const frame = new Error().stack!.split('\n')[2]!;
  return Number(/:(\d+):\d+\)?$/.exec(frame)![1]);
}

describe('breakpoints in the capture fixtures', () => {
  const env = { ...process.env };
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    delete process.env.CI;
    resetPauseLogs();
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...env };
    log.mockRestore();
  });

  const here = path.relative(process.cwd(), __filename).split(path.sep).join('/');

  /** Run `body` through the real fixtures on a fake page whose pause bar answers `answers` in turn. */
  async function runWithBreakpoints(
    pauseAt: (line: number) => string,
    answers: string[],
    body: (page: Record<string, (...a: unknown[]) => any>, line: () => number) => Promise<void>,
    headless: unknown = false,
    pick?: Record<string, unknown>,
  ) {
    const { page: pausePage, shown } = fakePausePage(answers, { pick });
    const clicks: string[] = [];
    const fakeLocator = {
      click: vi.fn(async () => void clicks.push('click')),
      highlight: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ({
        tagName: 'div',
        attributes: {},
        textContent: 'Pay',
        center: { x: 1, y: 1 },
        hasLabel: false,
        selectorCounts: {},
      })),
      _expect: vi.fn(async () => ({ matches: true })),
    };
    const factory = () => fakeLocator;
    const fakePage = {
      getByRole: factory,
      getByTestId: factory,
      getByText: factory,
      getByLabel: factory,
      getByPlaceholder: factory,
      getByAltText: factory,
      getByTitle: factory,
      locator: factory,
      on: () => {},
      pause: vi.fn(async () => void clicks.push('playwright pause')),
      evaluate: pausePage.evaluate,
      evaluateHandle: pausePage.evaluateHandle,
      waitForFunction: pausePage.waitForFunction,
    };
    const attached: LocatorSnapshot[] = [];
    const testInfo = {
      status: 'passed',
      retry: 0,
      timeout: 30_000,
      setTimeout: vi.fn(),
      project: { use: { headless } },
      attach: vi.fn(async (name: string, b: { body: Buffer }) => {
        if (name === ATTACHMENT_NAMES.locators) attached.push(...JSON.parse(String(b.body)));
      }),
      annotations: [],
    };
    const pageFixture = piwiFixtures.page as unknown as (
      args: { page: unknown },
      use: (page: typeof fakePage) => Promise<void>,
    ) => Promise<void>;
    const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
      (args: object, use: () => Promise<void>, info: unknown) => Promise<void>,
    ];
    let line = 0;
    const lineOf = () => line;
    process.env.PIWI_PAUSE_AT = pauseAt(0);
    await captureFixture(
      {},
      () =>
        pageFixture({ page: fakePage }, async (page) => {
          await body(page as never, lineOf);
        }),
      testInfo,
    );
    line = 0;
    return { shown, clicks, attached, fakeLocator };
  }

  it('pauses before the action on a breakpoint’s line, and not on another', async () => {
    const start = thisLine();
    const { shown, clicks } = await runWithBreakpoints(
      () => `${here}:${start + 5}`,
      ['resume'],
      async (page) => {
        await page.getByText!('Pay').click();
        await page.getByText!('Pay').click();
        await page.getByText!('Pay').click();
      },
    );
    expect(shown).toHaveLength(1);
    expect((shown[0] as { place: string }).place).toBe(`pause-at.spec.ts:${start + 5}`);
    expect(clicks).toEqual(['click', 'click', 'click']);
  });

  it('pauses at every action after Step, and at none after Finish', async () => {
    const start = thisLine();
    const stepped = await runWithBreakpoints(
      () => `${here}:${start + 5}`,
      ['step', 'resume'],
      async (page) => {
        await page.getByText!('Pay').click();
        await page.getByText!('Pay').click();
        await page.getByText!('Pay').click();
      },
    );
    expect(stepped.shown.map((s) => (s as { place: string }).place)).toEqual([
      `pause-at.spec.ts:${start + 5}`,
      `pause-at.spec.ts:${start + 6}`,
    ]);

    const again = thisLine();
    const finished = await runWithBreakpoints(
      () => `${here}:${again + 6};${here}:${again + 7}`,
      ['finish'],
      async (page) => {
        for (let i = 0; i < 2; i++) {
          await page.getByText!('Pay').click();
          await page.getByText!('Pay').click();
        }
      },
    );
    expect(finished.shown).toHaveLength(1);
  });

  it('pauses before an assertion, named by its matcher', async () => {
    const start = thisLine();
    const { shown } = await runWithBreakpoints(
      () => `${here}:${start + 6}`,
      ['resume'],
      async (page) => {
        const locator = page.getByText!('Pay') as { _expect: (...a: unknown[]) => Promise<unknown> };
        await locator._expect('to.be.visible', { isNot: false, timeout: 5000 });
      },
    );
    expect(shown).toEqual([expect.objectContaining({ place: `pause-at.spec.ts:${start + 6}`, action: 'toBeVisible' })]);
  });

  it('folds a locator picked while paused into the call site’s snapshot, and posts it to the editor', async () => {
    const posts: unknown[] = [];
    const editor = await startServer((req, res) => {
      posts.push(JSON.parse(req.body));
      jsonRes(res, 200, { inserted: true });
    });
    process.env.PIWI_EDITOR_SEND = `${editor.url}/piwi/send#abcdefghijklmnop_1234`;
    const pick = {
      tagName: 'button',
      attributes: { 'data-testid': 'pay-now' },
      textContent: 'Pay now',
      center: { x: 1, y: 1 },
      hasLabel: false,
      labelText: null,
      selectorCounts: { testId: 1 },
    };
    try {
      const start = thisLine();
      const { attached, clicks } = await runWithBreakpoints(
        () => `${here}:${start + 5}`,
        ['pick', 'resume'],
        async (page) => {
          await page.getByText!('Pay').click();
        },
        false,
        pick,
      );
      expect(clicks).toEqual(['click']);
      expect(attached).toHaveLength(1);
      expect(attached[0]!.location).toMatch(new RegExp(`^${here.replace(/\./g, '\\.')}:${start + 5}:\\d+$`));
      expect(attached[0]!.used.method).toBe('getByText');
      expect(attached[0]!.element?.attributes['data-testid']).toBe('pay-now');
      expect(attached[0]!.alternatives[0]).toMatchObject({ locator: "getByTestId('pay-now')", pickedByUser: true });
      expect(posts).toEqual([{ kind: 'locator', text: "getByTestId('pay-now')", at: { file: here, line: start + 5 } }]);
      expect(log.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(
        `[piwi] Locator picked at ${here}:${start + 5}: getByTestId('pay-now')`,
      );
    } finally {
      await editor.close();
    }
  });

  it('pauses at page.pause() with Piwi’s bar in a run the editor started, with Record here', async () => {
    process.env.PIWI_RECORD_CHANNEL = `/tmp/piwi-no-such.sock#${'t'.repeat(20)}`;
    const start = thisLine();
    const { shown, clicks } = await runWithBreakpoints(
      () => '',
      ['step', 'resume'],
      async (page) => {
        await page.pause!();
        await page.getByText!('Pay').click();
      },
    );
    expect(shown).toEqual([
      expect.objectContaining({ place: `pause-at.spec.ts:${start + 5}`, action: 'page.pause()', record: true }),
      // Step pauses at the next action.
      expect.objectContaining({ place: `pause-at.spec.ts:${start + 6}`, action: 'click', record: true }),
    ]);
    expect(clicks).toEqual(['click']);
  });

  it('leaves page.pause() to Playwright in a run no editor started, or a headless one', async () => {
    delete process.env.PIWI_RECORD_CHANNEL;
    const unpaired = await runWithBreakpoints(
      () => '',
      [],
      async (page) => {
        await page.pause!();
      },
    );
    expect(unpaired.shown).toEqual([]);
    expect(unpaired.clicks).toEqual(['playwright pause']);
    process.env.PIWI_RECORD_CHANNEL = `/tmp/piwi-no-such.sock#${'t'.repeat(20)}`;
    const headless = await runWithBreakpoints(
      () => '',
      [],
      async (page) => {
        await page.pause!();
      },
      true,
    );
    expect(headless.clicks).toEqual(['playwright pause']);
  });

  it('never pauses a headless run, and says why once', async () => {
    const start = thisLine();
    const { shown, clicks } = await runWithBreakpoints(
      () => `${here}:${start + 5}`,
      [],
      async (page) => {
        await page.getByText!('Pay').click();
      },
      true,
    );
    expect(shown).toEqual([]);
    expect(clicks).toEqual(['click']);
    expect(
      log.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes('PIWI_PAUSE_AT')),
    ).toEqual([
      '[piwi] PIWI_PAUSE_AT is set but breakpoints are skipped: the browser is headless — re-run with --headed (or set use: { headless: false })',
    ]);
  });
});
