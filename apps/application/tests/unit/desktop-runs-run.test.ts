/**
 * A real Playwright run under the desktop build's hub, through the built reporter: the environment the desktop shell
 * gives a run it starts (`PIWI_RUN_CHANNEL` from the server, `PIWI_RUN_REF`, `PIWI_ORIGIN_REF` naming a failure
 * cluster, `PIWI_EDITOR_SEND` naming where its picks go), and Piwi Picker on the hub with the desktop token. The run
 * stops at `page.pause()`, is paused from outside, stepped, clicked through the live view and picked on its image, and
 * a failure is held at its line while the window shows the run. Then the window alone steers a run: it pauses it,
 * watches its live view, picks on its image, the locator coming to it to copy, mocks a request the page made, the code
 * coming to it to copy, and clicks the page through the view. Then an agent steers a run through the run tools `/mcp`
 * serves: it pauses it, reads the page's snapshot, clicks the button by its ref and has the step made into code, which
 * comes to the window to copy and back to the agent. Headless, as the shell runs a reproduction. Skipped when the
 * reporter is not built (`npm run reporter:build`) or Chromium is not installed.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  parseHubMessage,
  type HubAnswer,
  type HubMessage,
  type HubStop,
  type HubWorker,
} from '@piwitests/core/run-hub';
import { parseSendPayload } from '@piwitests/core/editor-send';
import { DesktopRuns } from '../../server/utils/desktop-runs';
import { desktopPicksToken } from '../../server/utils/desktop-access';
import type { DesktopRunEvent } from '#shared/desktop-runs';

const requireHere = createRequire(import.meta.url);
const reporter = path.resolve(import.meta.dirname, '../../../../packages/reporter/dist/index.js');
const project = path.join(import.meta.dirname, `.desktop-runs-${process.pid}`);
const TOKEN = `pd_${'5e'.repeat(32)}`;
const ORIGIN = `chrome-extension://${'c'.repeat(32)}`;
const REF = 'desktop-1';
const chromium = (() => {
  try {
    const { chromium: browser } = requireHere('@playwright/test') as { chromium: { executablePath(): string } };
    return fs.existsSync(browser.executablePath());
  } catch {
    return false;
  }
})();
const runnable = fs.existsSync(reporter) && chromium;

/**
 * The page: a button at a place a click and a pick on the image name, the heading it changes, and the cart it fetches,
 * whose response an interactive run keeps for Mock a request.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>Shop</title>
<style>body { margin: 0; font: 16px sans-serif } h1 { margin: 20px } #go { position: absolute; left: 100px; top: 100px; width: 120px; height: 40px }</style>
<h1>Shop</h1><button id="go" onclick="document.querySelector('h1').textContent = 'Clicked'">Go</button>
<p id="cart"></p><script>fetch('/api/cart').then((r) => r.json()).then((c) => { document.getElementById('cart').textContent = c.items.length + ' items'; });</script>`;

const CART = JSON.stringify({ items: [{ name: 'Mug', price: 12 }] });

/** A test the window alone steers: it waits for a click on Go, which the window plays through the live view. */
const WINDOW_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('steered from the window', async ({ page }) => {
  await page.goto('${base}');
  await expect(page.locator('#cart')).toHaveText('1 items');
  for (let i = 0; i < 800; i++) {
    if ((await page.locator('h1').textContent()) === 'Clicked') return;
    await page.waitForTimeout(25);
  }
  throw new Error('nobody clicked');
});
`;

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('paused in its page', async ({ page }) => {
  await page.goto('${base}');
  await page.pause();
});
test('paused from outside', async ({ page }) => {
  await page.goto('${base}');
  for (let i = 0; i < 400; i++) {
    if ((await page.locator('h1').textContent()) === 'Clicked') return;
    await page.waitForTimeout(25);
  }
  throw new Error('nobody clicked');
});
test('fails at its line', async ({ page }) => {
  await page.goto('${base}');
  await expect(page.locator('h1')).toHaveText('Never', { timeout: 300 });
});
`;

const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) { this.tests.push({ title: test.title, status: result.status }); }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

let server: http.Server;
let picks: http.Server;
let runs: DesktopRuns;
let picker: WebSocket;
const messages: HubMessage[] = [];
let ids = 0;

async function waitFor<T>(read: () => T | undefined | false | null, ms = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A command of Piwi Picker's, and the hub's answer to it. */
async function command(message: Record<string, unknown>): Promise<HubAnswer> {
  const id = ++ids;
  picker.send(JSON.stringify({ ...message, id }));
  return waitFor(() => messages.find((m): m is HubAnswer => m.type === 'answer' && m.id === id));
}

/** The run's worker as Piwi Picker last heard it. */
function worker(): HubWorker | undefined {
  return messages
    .filter((m): m is Extract<HubMessage, { type: 'session' }> => m.type === 'session' && m.session.ref === REF)
    .pop()?.session.workers[0];
}

/** The next stop of the run, other than the one `after` names. */
function stopAfter(after: string | null): Promise<HubStop> {
  return waitFor(() => {
    const stop = worker()?.stop;
    return stop && stop.since !== after ? stop : undefined;
  });
}

const at = (stop: HubStop) => ({ ref: REF, worker: worker()!.worker, since: stop.since });

beforeAll(async () => {
  if (!runnable) return;
  server = http.createServer((req, res) => {
    if (req.url === '/api/cart') return void res.writeHead(200, { 'content-type': 'application/json' }).end(CART);
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(project, 'tests', 'shop.spec.cjs'), SPEC(base));
  fs.writeFileSync(path.join(project, 'tests', 'window.spec.cjs'), WINDOW_SPEC(base));
  fs.writeFileSync(
    path.join(project, 'tests', 'agent.spec.cjs'),
    WINDOW_SPEC(base).replace('steered from the window', 'steered by an agent'),
  );
  fs.writeFileSync(
    path.join(project, 'fixture.cjs'),
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(reporter)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  fs.writeFileSync(path.join(project, 'results-reporter.cjs'), RESULTS_REPORTER);
  fs.writeFileSync(
    path.join(project, 'playwright.config.cjs'),
    `module.exports = { testDir: './tests', outputDir: './test-results', timeout: 10000, workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]], use: { headless: true, viewport: { width: 800, height: 600 } } };
`,
  );
  runs = await DesktopRuns.start({
    token: TOKEN,
    version: '0.62.0',
    links: () => [{ id: 1, path: fs.realpathSync(project) }],
  });
  const [hub] = runs.live();
  picker = new WebSocket(hub!.url, { origin: ORIGIN });
  picker.on('message', (data) => {
    const message = parseHubMessage(String(data));
    if (message) messages.push(message);
  });
  await new Promise((resolve) => picker.on('open', resolve));
  picker.send(JSON.stringify({ type: 'hello', token: hub!.token }));
  await waitFor(() => messages.find((m) => m.type === 'welcome'));
});

afterAll(async () => {
  picker?.close();
  runs?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
  await new Promise((resolve) => (picks ? picks.close(resolve) : resolve(null)));
  fs.rmSync(project, { recursive: true, force: true });
});

/**
 * The server's route for the runs' picks (`POST /api/desktop/runs/picks`), as the reporter reaches it through
 * `PIWI_EDITOR_SEND`: Send to editor's body, with the token minted for that route alone, passed to the windows. Its
 * address, which never holds the desktop token.
 */
async function picksRoute(): Promise<string> {
  picks = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${desktopPicksToken()}`) return void res.writeHead(401).end();
      const payload = parseSendPayload(JSON.parse(body || 'null'));
      if ('error' in payload || payload.kind !== 'locator') return void res.writeHead(400).end();
      runs.picked({ locator: payload.text, file: payload.at?.file ?? null, line: payload.at?.line ?? null });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => picks.listen(0, '127.0.0.1', resolve));
  const address = runs.picksAddress((picks.address() as AddressInfo).port)!;
  expect(address).not.toContain(TOKEN);
  return address;
}

/** Runs Playwright on one spec of the project, in the environment the desktop shell gives a run. */
function runPlaywright(spec: string, extra: NodeJS.ProcessEnv): { exited: Promise<number | null>; output(): string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: runs.runChannel!,
    PIWI_RUN_REF: REF,
    PIWI_ORIGIN: 'reproduce',
    PIWI_ORIGIN_REF: '42',
    PIWI_DESKTOP_CONFIG: path.join(project, 'no-desktop.json'),
    ...extra,
  };
  for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PAUSE_AT']) delete env[name];
  if (!extra.PIWI_EDITOR_SEND) delete env.PIWI_EDITOR_SEND;
  let output = '';
  const exited = new Promise<number | null>((resolve) => {
    const child = execFile(
      process.execPath,
      [requireHere.resolve('@playwright/test/cli'), 'test', spec],
      { cwd: project, env, timeout: 90_000 },
      () => {},
    );
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    child.on('exit', (code) => resolve(code));
  });
  return { exited, output: () => output };
}

describe.skipIf(!runnable)('a run the desktop shell starts', () => {
  it('stops at page.pause() and at a failure, steered from Piwi Picker with the desktop token', async () => {
    expect((await command({ type: 'subscribe' })).ok).toBe(true);
    // The window shows the run live: its failure waits at the failing line.
    const window: DesktopRunEvent[] = [];
    const opened = await runs.openWindow({ send: (e) => void window.push(e), buffered: () => 0, close: () => {} });
    expect(await runs.command({ viewer: opened!.viewer, type: 'show', id: 1, ref: REF, on: true })).toMatchObject({
      ok: true,
    });

    const { exited, output } = runPlaywright('tests/shop.spec.cjs', {});

    try {
      // page.pause() in a headless run: the image of the stop, its live view and a pick on the image.
      const paused = await stopAfter(null);
      expect(paused).toMatchObject({ reason: 'page-pause', bar: false });
      expect(paused.uri).toBe(pathToFileURL(path.join(fs.realpathSync(project), 'tests', 'shop.spec.cjs')).href);
      expect(paused.line).toBe(3);
      const image = await command({ type: 'pausedPage', ref: REF, worker: worker()!.worker });
      expect(image).toMatchObject({ ok: true, image: { mime: 'image/jpeg', width: 800, height: 600 } });
      expect(Buffer.from(image.image!.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(await command({ type: 'view', ...at(paused), on: true })).toMatchObject({ ok: true });
      const frame = await waitFor(() => messages.find((m) => m.type === 'frame'));
      expect(frame).toMatchObject({ ref: REF, since: paused.since, width: 800, height: 600 });
      const picked = await command({ type: 'pick-at', ...at(paused), x: 160, y: 120 });
      expect(picked).toMatchObject({ ok: true, locator: "getByRole('button', { name: 'Go' })" });
      // The window, which does not watch the stop, gets none of its frames.
      expect(window.some((e) => e.type === 'frame')).toBe(false);
      expect(await command({ type: 'runControl', ...at(paused), action: 'resume' })).toMatchObject({ ok: true });

      // Paused from outside while it acts, stepped, then clicked through the view.
      await waitFor(() => worker()?.test?.title.at(-1) === 'paused from outside' && worker()?.state === 'running');
      expect(await command({ type: 'runControl', ref: REF, worker: null, action: 'pause' })).toMatchObject({
        ok: true,
      });
      const pausing = await stopAfter(paused.since);
      expect(pausing.reason).toBe('pause');
      expect(await command({ type: 'runControl', ...at(pausing), action: 'step' })).toMatchObject({ ok: true });
      const stepped = await stopAfter(pausing.since);
      expect(stepped.reason).toBe('step');
      expect(await command({ type: 'view', ...at(stepped), on: true })).toMatchObject({ ok: true });
      const clicked = await command({
        type: 'input',
        ...at(stepped),
        events: [
          { type: 'mouse', action: 'move', x: 160, y: 120 },
          { type: 'mouse', action: 'click', x: 160, y: 120, button: 'left', clickCount: 1 },
        ],
      });
      expect(clicked).toMatchObject({ ok: true });
      expect(await command({ type: 'runControl', ...at(stepped), action: 'resume' })).toMatchObject({ ok: true });

      // A failure, held at its line while the window shows the run, with its error.
      const failed = await stopAfter(stepped.since);
      expect(failed).toMatchObject({ reason: 'failure', bar: false });
      expect(failed.error).toMatch(/toHaveText/);
      expect(await command({ type: 'runControl', ...at(failed), action: 'resume' })).toMatchObject({ ok: true });

      expect(await exited).toBe(1);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${output()}`);
    } finally {
      opened?.close();
    }
    const results = JSON.parse(fs.readFileSync(path.join(project, 'results.json'), 'utf8')) as Array<{
      title: string;
      status: string;
    }>;
    expect(results).toEqual([
      { title: 'paused in its page', status: 'passed' },
      { title: 'paused from outside', status: 'passed' },
      { title: 'fails at its line', status: 'failed' },
    ]);
    // The window heard the run as Piwi Picker did.
    expect(window.some((e) => e.type === 'session' && e.session.ref === REF)).toBe(true);
  }, 120_000);

  it('is paused, watched, picked on its image and mocked from the window alone, its code there to copy', async () => {
    picker.close();
    const events: DesktopRunEvent[] = [];
    const opened = (await runs.openWindow({ send: (e) => void events.push(e), buffered: () => 0, close: () => {} }))!;
    let id = 0;
    const send = (body: Record<string, unknown>) => runs.command({ viewer: opened.viewer, id: ++id, ...body });
    const lastWorker = () =>
      events
        .filter(
          (e): e is Extract<DesktopRunEvent, { type: 'session' }> => e.type === 'session' && e.session.ref === REF,
        )
        .pop()?.session.workers[0];
    expect(await send({ type: 'show', ref: REF, on: true })).toMatchObject({ ok: true });

    const { exited, output } = runPlaywright('tests/window.spec.cjs', { PIWI_EDITOR_SEND: await picksRoute() });
    try {
      // Paused from the window while the test waits for its click.
      await waitFor(
        () => lastWorker()?.test?.title.at(-1) === 'steered from the window' && lastWorker()?.state === 'running',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await send({ type: 'runControl', ref: REF, worker: null, action: 'pause', since: null })).toMatchObject({
        ok: true,
      });
      const stop = await waitFor(() => (lastWorker()?.state === 'stopped' ? lastWorker()?.stop : undefined));
      expect(stop).toMatchObject({ reason: 'pause', bar: false });
      // Headless: the input and Assert a region wait for the window to watch the stop.
      expect(stop.intents).toEqual(['mock', 'view', 'pick-at', 'end']);
      const at = { ref: REF, worker: lastWorker()!.worker, since: stop.since };

      // Watched live: its frames come to the window, which may now play input there.
      expect(await send({ type: 'view', ...at, on: true })).toMatchObject({ ok: true });
      const frame = await waitFor(() => events.find((e) => e.type === 'frame'));
      expect(frame).toMatchObject({ ref: REF, since: stop.since, width: 800, height: 600 });
      await waitFor(() => lastWorker()?.stop?.intents?.includes('input'));
      expect(lastWorker()!.stop!.intents).toEqual(expect.arrayContaining(['assert-region', 'input', 'pick-at']));

      // Picked on its image: the locator comes to the window, to copy, and the answer says so.
      const picked = await send({ type: 'pick-at', ...at, x: 160, y: 120 });
      expect(picked).toMatchObject({
        ok: true,
        locator: "getByRole('button', { name: 'Go' })",
        message: "getByRole('button', { name: 'Go' }): copy it in the desktop app's window.",
      });
      const pick = await waitFor(() => events.find((e) => e.type === 'pick'));
      expect(pick).toMatchObject({
        type: 'pick',
        pick: { locator: "getByRole('button', { name: 'Go' })", file: 'tests/window.spec.cjs' },
      });

      // Mock a request: the cart the page fetched, made into a route to copy in the window.
      const listed = await send({ type: 'requests', ...at });
      const cart = listed?.requests?.find((r) => r.url.endsWith('/api/cart'));
      expect(cart).toMatchObject({ method: 'GET', status: 200 });
      const mocked = await send({ type: 'mock', ...at, request: cart!.id });
      expect(mocked).toMatchObject({
        ok: true,
        message: expect.stringMatching(/copy it in the desktop app's window\./),
      });
      const made = await waitFor(() => events.find((e) => e.type === 'stop-code'));
      if (made.type !== 'stop-code') throw new Error('no code');
      expect(made.code).toMatchObject({ ref: REF, action: 'mock', since: stop.since });
      expect(made.code.code).toContain('page.route(');
      expect(made.code.code).toContain('Mug');

      // Clicked through the view: the test sees the click once it goes on.
      expect(
        await send({
          type: 'input',
          ...at,
          events: [
            { type: 'mouse', action: 'move', x: 160, y: 120 },
            { type: 'mouse', action: 'click', x: 160, y: 120, button: 'left', clickCount: 1 },
          ],
        }),
      ).toMatchObject({ ok: true });
      expect(await send({ type: 'runControl', ...at, action: 'resume' })).toMatchObject({ ok: true });
      expect(await exited).toBe(0);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${output()}`);
    } finally {
      opened.close();
    }
  }, 120_000);
  it('is paused, read, clicked by a ref and made into code by an agent, the code there to copy', async () => {
    const events: DesktopRunEvent[] = [];
    const opened = (await runs.openWindow({ send: (e) => void events.push(e), buffered: () => 0, close: () => {} }))!;
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await runs.agent.call(name, args);
      const [piwi, ...rest] = result.content as Array<{ type: string; text?: string }>;
      return {
        piwi: JSON.parse(piwi!.text!) as Record<string, any>,
        page: rest.find((c) => c.type === 'text')?.text ?? null,
      };
    };
    const lastWorker = () =>
      events
        .filter(
          (e): e is Extract<DesktopRunEvent, { type: 'session' }> => e.type === 'session' && e.session.ref === REF,
        )
        .pop()?.session.workers[0];

    const { exited, output } = runPlaywright('tests/agent.spec.cjs', {});
    try {
      await waitFor(
        () => lastWorker()?.test?.title.at(-1) === 'steered by an agent' && lastWorker()?.state === 'running',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Paused by the agent: the answer brings the stop and the page's snapshot in AI mode, apart.
      const paused = await tool('run_control', { run: REF, action: 'pause', wait: 20 });
      expect(paused.piwi).toMatchObject({ ok: true, stop: { reason: 'pause', by: 'agent' } });
      expect(paused.page).toMatch(/^<<<page-content [0-9a-f]{12}>>> Untrusted: /);
      const target = /button "Go" \[ref=(e\d+)\]/.exec(paused.page ?? '')?.[1];
      expect(target, paused.page ?? '').toBeTruthy();
      const since = paused.piwi.stop.stop as string;

      // Clicked by its ref, as trusted input: the page changes, and the answer says how.
      const clicked = await tool('page_act', { run: REF, stop: since, target, action: 'click' });
      expect(clicked.piwi, clicked.piwi.message).toMatchObject({ ok: true, steps: 1 });
      expect(clicked.page).toContain('heading "Clicked"');

      // The step made into code: to the window to copy, and back to the agent.
      const written = await tool('code_write', { run: REF, stop: since, kind: 'steps' });
      expect(written.piwi, written.piwi.message).toMatchObject({ ok: true, steps: 1 });
      expect(written.page).toContain("await page.getByRole('button', { name: 'Go' }).click();");
      const made = await waitFor(() => events.find((e) => e.type === 'stop-code' && e.code.action === 'steps'));
      if (made.type !== 'stop-code') throw new Error('no code');
      // Indented as the stopped line, in the test's loop.
      expect(made.code.code).toBe("    await page.getByRole('button', { name: 'Go' }).click();");
      expect(made.code.uri).toBe(pathToFileURL(path.join(fs.realpathSync(project), 'tests', 'agent.spec.cjs')).href);

      // Resumed: the test sees the click and passes.
      expect((await tool('run_control', { run: REF, action: 'resume', stop: since, wait: 0 })).piwi.ok).toBe(true);
      expect(await exited).toBe(0);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${output()}`);
    } finally {
      opened.close();
    }
  }, 120_000);
});
