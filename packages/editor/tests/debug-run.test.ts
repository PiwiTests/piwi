/**
 * A run that debugs one test from a failure (**Debug in my editor**, `RunTestsArgs.debug`), through the service: the
 * command it builds (the test found by its title, headed, one worker, the failing line in its breakpoints), the
 * failing line kept through the client's breakpoints until a fake worker stops there once, the failure's suggested
 * locator asked of a stub instance and outlined at that stop, the caret's count leaving that outline as it is on the
 * stopped line, and what is refused.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { checkedDebugRun, debugArgs, debugTest } from '../src/debug-run';
import type { LocatorAtCaretResult, RunCommand } from '../src/protocol';
import { FakeWorker, service, waitFor, writeRunWorkspace, type Service } from './run-fixtures';

const SPEC = [
  "import { test } from '@playwright/test';",
  "import { CartPage } from './pages/cart.page';",
  '',
  "test.describe('cart', () => {",
  "  test('adds a mug', async ({ page }) => {",
  '    await new CartPage(page).add();',
  '  });',
  '',
  "  test('removes a mug', async ({ page }) => {",
  "    await page.goto('/cart');",
  '  });',
  '});',
  '',
  "test('removes a mug', async ({ page }) => {});",
  '',
].join('\n');

const PAGE_OBJECT = [
  "import type { Page } from '@playwright/test';",
  '',
  'export class CartPage {',
  '  constructor(private readonly page: Page) {}',
  '',
  '  async add() {',
  "    await this.page.getByRole('button', { name: 'Add' }).click();",
  '  }',
  '}',
  '',
].join('\n');

const SUGGESTED = "getByTestId('add-to-cart')";

describe('the debug run’s pure half', () => {
  test('finds the test by its describe blocks’ titles and its own, else by its own alone when it is the only one', () => {
    expect(debugTest(SPEC, 'tests/cart.spec.ts', 'cart › adds a mug')).toMatchObject({ line: 4, title: 'adds a mug' });
    expect(debugTest(SPEC, 'tests/cart.spec.ts', 'adds a mug')).toMatchObject({ line: 4 });
    expect(debugTest(SPEC, 'tests/cart.spec.ts', 'cart › removes a mug')).toMatchObject({ line: 8 });
    expect(debugTest(SPEC, 'tests/cart.spec.ts', 'removes a mug')).toMatchObject({ line: 13 });
    expect(debugTest(SPEC, 'tests/cart.spec.ts', 'pays')).toBe(
      'No test of tests/cart.spec.ts is titled “pays” as it is saved, so Piwi runs nothing: the test may have been renamed or moved since the run.',
    );
    // Two describe blocks hold a test of that title, and a dashboard that knows no block names neither.
    const twice = `${SPEC}\ntest.describe('basket', () => {\n  test('adds a mug', async () => {});\n});\n`;
    expect(debugTest(twice, 'tests/cart.spec.ts', 'adds a mug')).toBe(
      '2 tests of tests/cart.spec.ts are titled “adds a mug”, so Piwi runs none of them: run the one to debug yourself.',
    );
    expect(debugTest(twice, 'tests/cart.spec.ts', 'basket › adds a mug')).toMatchObject({ line: 16 });
  });

  test('runs the test alone, in its project when one is named, with one worker', () => {
    expect(debugArgs('tests/cart.spec.ts:5', 'chromium')).toEqual([
      'tests/cart.spec.ts:5',
      '--project=chromium',
      '--workers=1',
    ]);
    expect(debugArgs('tests/cart.spec.ts:5', null)).toEqual(['tests/cart.spec.ts:5', '--workers=1']);
  });

  test('checks each field a client sends, and refuses text a message could read as markup', () => {
    const stop = { uri: 'file:///w/tests/cart.spec.ts', line: 4 };
    expect(checkedDebugRun({ stop, title: 'cart › adds a mug', project: '', execution: 7 })).toEqual({
      stop,
      title: 'cart › adds a mug',
      project: null,
      execution: 7,
    });
    expect(checkedDebugRun({ stop: { uri: stop.uri, line: -1 }, title: 'a' })).toBe(
      'The failing line to stop at is missing.',
    );
    expect(checkedDebugRun({ stop: { uri: stop.uri, line: 1.5 }, title: 'a' })).toBe(
      'The failing line to stop at is missing.',
    );
    for (const title of [
      '',
      '[x](command:workbench.action.terminal.new)',
      'a\nb',
      '<img src=x>',
      'a`b',
      'x'.repeat(1001),
    ]) {
      expect(checkedDebugRun({ stop, title })).toBe(
        "The test's title is not one Piwi takes: text alone, of 1,000 characters at most.",
      );
    }
    expect(checkedDebugRun({ stop, title: 'a', project: 'chromium\u0007' })).toMatch(/^The Playwright project/);
    expect(checkedDebugRun({ stop, title: 'a', project: 3 })).toMatch(/^The Playwright project/);
    for (const execution of [0, -2, 1.5, '7']) {
      expect(checkedDebugRun({ stop, title: 'a', execution })).toBe('The failed execution is not an id Piwi takes.');
    }
  });
});

describe('a debug run through the service', () => {
  let dir = '';
  let svc: Service;
  let instance: http.Server;
  const healings: number[] = [];
  /** Whether the service reached the instance: its context then reads the healings from it. */
  let reached = false;
  const uri = (file: string) => pathToFileURL(path.join(dir, file)).href;

  beforeAll(async () => {
    instance = http.createServer((req, res) => {
      reached = true;
      res.setHeader('Content-Type', 'application/json');
      const healing = /^\/api\/test-run-cases\/(\d+)\/locator-healing/.exec(req.url ?? '');
      if (healing) {
        healings.push(Number(healing[1]));
        const recommended =
          healing[1] === '900' ? { locator: SUGGESTED, method: 'getByTestId', args: {}, score: 100 } : null;
        return res.end(JSON.stringify({ recommendation: recommended ? { recommended } : null }));
      }
      if (req.url === '/api/projects/menu') return res.end(JSON.stringify({ items: [{ id: 7, name: 'Acme Mugs' }] }));
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-debug-run-')));
    writeRunWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'tests/cart.spec.ts'), SPEC);
    fs.writeFileSync(path.join(dir, 'tests/pages/cart.page.ts'), PAGE_OBJECT);
    svc = await service(dir, true, {
      env: { PIWI_DASHBOARD_URL: url, PIWI_PROJECT_NAME: 'Acme Mugs', PIWI_DESKTOP_CONFIG: '/nonexistent' },
    });
    await waitFor(() => (reached ? true : undefined));
  });

  afterAll(async () => {
    svc?.stop();
    await new Promise((resolve) => instance.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The debug command of the cart test, stopping at the page object's click (0-based line 6), with `debug` and `extra`
   * over the fields, once the run channel opens.
   */
  async function debugCommand(extra: object = {}, debug: object = {}): Promise<RunCommand> {
    for (;;) {
      const run = (await svc.client.sendRequest('piwi/runArgs', {
        uri: uri('tests/cart.spec.ts'),
        testIds: [],
        debug: {
          stop: { uri: uri('tests/pages/cart.page.ts'), line: 6 },
          title: 'cart › adds a mug',
          project: 'chromium',
          execution: 900,
          ...debug,
        },
        ...extra,
      })) as RunCommand;
      if (run.env?.PIWI_RUN_CHANNEL) return run;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** A worker of `run` on its run channel, attached, counting locators, running the cart test. */
  function workerOf(run: RunCommand): FakeWorker {
    const [channelPath, token] = run.env!.PIWI_RUN_CHANNEL!.split('#') as [string, string];
    const worker = new FakeWorker(channelPath, dir).attach(token, run.ref!, 0, ['pick', 'record', 'locator']);
    worker.begin();
    return worker;
  }

  test('runs the test headed with one worker, stops once at the failing line, and outlines the suggested locator', async () => {
    const own = { uri: uri('tests/cart.spec.ts'), line: 9 };
    const run = await debugCommand({ breakpoints: [own] });
    expect(run.args).toEqual(['tests/cart.spec.ts:5', '--project=chromium', '--workers=1', '--headed']);
    expect(run.command).toBe('npx playwright test tests/cart.spec.ts:5 --project=chromium --workers=1 --headed');
    expect(run.env?.PIWI_PAUSE_AT).toBe('tests/cart.spec.ts:10;tests/pages/cart.page.ts:7');

    const worker = workerOf(run);
    try {
      // The editor's breakpoints change before the stop: the failing line stays among the run's.
      const moved = { uri: uri('tests/cart.spec.ts'), line: 10 };
      await svc.client.sendNotification('piwi/setRunBreakpoints', { ref: run.ref, places: [moved] });
      expect(await worker.next('breakpoints')).toEqual({
        type: 'breakpoints',
        places: [
          { file: 'tests/cart.spec.ts', line: 11 },
          { file: 'tests/pages/cart.page.ts', line: 7 },
        ],
      });

      // The stop at the failing line: the run's breakpoints lose it, and the suggested locator is counted there.
      worker.stopAt(1, 7, true);
      expect(await worker.next('breakpoints', 1)).toEqual({
        type: 'breakpoints',
        places: [{ file: 'tests/cart.spec.ts', line: 11 }],
      });
      const asked = await worker.next('request');
      expect(asked).toEqual({
        type: 'request',
        request: expect.any(Number),
        what: 'locator',
        stop: 1,
        locator: SUGGESTED,
      });
      worker.send({
        type: 'answer',
        request: asked.request,
        what: 'locator',
        value: { ok: true, message: '1 element matches.', count: 1 },
      });
      const told = await waitFor(() => svc.notices.find((n) => n.message.startsWith("Piwi's suggested locator")));
      expect(told).toEqual({
        root: dir,
        severity: 'information',
        message: `Piwi's suggested locator: ${SUGGESTED} (outlined on the page). 1 element matches.`,
      });

      // The caret on the stopped line says what is outlined, and asks the worker for nothing.
      const since = svc.latest(run.ref!)!.workers[0]!.stop!.since;
      const caret = (params: object) =>
        svc.client.sendRequest('piwi/locatorAtCaret', {
          ref: run.ref,
          since,
          ...params,
        }) as Promise<LocatorAtCaretResult>;
      expect(await caret({ uri: uri('tests/pages/cart.page.ts'), line: 6 })).toEqual({
        ok: true,
        message: `suggested locator ${SUGGESTED} (outlined on the page)`,
        locator: SUGGESTED,
        count: null,
      });
      expect(worker.heard.filter((m) => m.type === 'request')).toHaveLength(1);
      // Elsewhere, the caret's own count takes the outline's place; back on the line, the line's locator is counted.
      const leaving = caret({ uri: null, line: null });
      const down = await worker.next('request', 1);
      expect(down).toMatchObject({ what: 'locator', locator: null });
      worker.send({
        type: 'answer',
        request: down.request,
        what: 'locator',
        value: { ok: true, message: 'The outline is gone.', count: null },
      });
      await leaving;
      const back = caret({ uri: uri('tests/pages/cart.page.ts'), line: 6 });
      const own = await worker.next('request', 2);
      expect(own).toMatchObject({ what: 'locator', locator: "getByRole('button', { name: 'Add' })" });
      worker.send({
        type: 'answer',
        request: own.request,
        what: 'locator',
        value: { ok: true, message: 'No element matches.', count: 0 },
      });
      expect(await back).toMatchObject({ ok: true, count: 0 });

      // A later stop on the same line is a breakpoint's no longer: no suggested locator is asked for again.
      worker.send({ type: 'running', stop: 1 });
      worker.stopAt(2, 7, true);
      await waitFor(() => (svc.latest(run.ref!)?.workers[0]?.stop?.since !== since ? true : undefined));
      await new Promise((r) => setTimeout(r, 100));
      expect(worker.heard.filter((m) => m.type === 'request')).toHaveLength(3);
      expect(worker.heard.filter((m) => m.type === 'breakpoints')).toHaveLength(2);
    } finally {
      worker.socket.destroy();
    }
  });

  test('only stops when the instance has no suggested locator, and says when it matches nothing', async () => {
    // A failure with no suggestion, in every project: the stop comes, and no count is asked.
    const plain = await debugCommand({}, { project: null, execution: 901 });
    expect(plain.args).toEqual(['tests/cart.spec.ts:5', '--workers=1', '--headed']);
    const worker = workerOf(plain);
    try {
      worker.stopAt(1, 7, true);
      await worker.next('breakpoints');
      await waitFor(() => (healings.includes(901) ? true : undefined));
      await new Promise((r) => setTimeout(r, 100));
      expect(worker.heard.filter((m) => m.type === 'request')).toEqual([]);
    } finally {
      worker.socket.destroy();
    }

    // A suggestion the stopped page does not hold: said, nothing outlined, the caret's count its own.
    const missed = await debugCommand();
    const other = workerOf(missed);
    try {
      other.stopAt(1, 7, true);
      const asked = await other.next('request');
      other.send({
        type: 'answer',
        request: asked.request,
        what: 'locator',
        value: { ok: true, message: 'No element matches.', count: 0 },
      });
      await waitFor(() =>
        svc.notices.find(
          (n) => n.message === `Piwi's suggested locator, ${SUGGESTED}, matches nothing on the stopped page.`,
        ),
      );
      const since = svc.latest(missed.ref!)!.workers[0]!.stop!.since;
      const counting = svc.client.sendRequest('piwi/locatorAtCaret', {
        ref: missed.ref,
        since,
        uri: uri('tests/pages/cart.page.ts'),
        line: 6,
      }) as Promise<LocatorAtCaretResult>;
      const own = await other.next('request', 1);
      expect(own).toMatchObject({ locator: "getByRole('button', { name: 'Add' })" });
      other.send({
        type: 'answer',
        request: own.request,
        what: 'locator',
        value: { ok: true, message: '1 element matches.', count: 1 },
      });
      expect(await counting).toMatchObject({ count: 1 });
    } finally {
      other.socket.destroy();
    }
  });

  test('refuses a test the spec does not hold, a file outside the config’s folder and text that is not plain', async () => {
    const ask = (debug: object, spec = 'tests/cart.spec.ts') =>
      svc.client.sendRequest('piwi/runArgs', { uri: uri(spec), testIds: [], debug }) as Promise<RunCommand | null>;
    const stop = { uri: uri('tests/pages/cart.page.ts'), line: 6 };
    const before = svc.notices.length;
    expect(await ask({ stop, title: 'cart › pays' })).toBeNull();
    expect(
      await ask({
        stop: { uri: pathToFileURL(path.join(os.tmpdir(), 'elsewhere.ts')).href, line: 1 },
        title: 'adds a mug',
      }),
    ).toBeNull();
    expect(await ask({ stop, title: 'adds a mug' }, 'tests/pages/cart.page.ts')).toBeNull();
    expect(await ask({ stop, title: '[run](command:workbench.action.terminal.new)' })).toBeNull();
    expect(await ask({ stop, title: 'adds a mug', project: 'chromium$(touch x)' })).toBeNull();
    await waitFor(() => (svc.notices.length >= before + 5 ? true : undefined));
    expect(svc.notices.slice(before).map((n) => [n.severity, n.message])).toEqual([
      [
        'warning',
        'No test of tests/cart.spec.ts is titled “cart › pays” as it is saved, so Piwi runs nothing: the test may have been renamed or moved since the run.',
      ],
      ['warning', 'The test to debug and its failing line must be files under the Playwright config’s folder.'],
      ['warning', 'The test to debug and its failing line must be files under the Playwright config’s folder.'],
      ['warning', "The test's title is not one Piwi takes: text alone, of 1,000 characters at most."],
      ['warning', 'The Playwright project “chromium$(touch x)” cannot be passed on a command line.'],
    ]);
  });
});
