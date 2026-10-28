import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader, parseHandoffToEditor } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * Code from a stop, the worker's part, in real Playwright runs through the built package under a fake editor service:
 * the text bodies an interactive run keeps and the one handed over to mock, a locator counted and outlined on the
 * stopped page, a region picked with its ARIA snapshot (its `toMatchAriaSnapshot` run against the page) or refused,
 * a check handed to the editor's check panel, and a failure held at its line, headed and headless, once the test and
 * its hooks are done, where Pick replaces the failing locator and Resume lets the test end as it failed, the evidence
 * being what the test left at the failure, its error's credentials hidden. Under CI, without a run connection, and
 * for an editor that does not say it shows a held failure, a failure is not held. Without a display, Chromium runs the
 * headed project without a window (`--headless=new`); under `xvfb-run -a` it opens one.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-code-${process.pid}`);
const REF = 'ed-5e6f7a8b';
const TOKEN = 'run-code-token-0123456789ab';
const SEND_TOKEN = 'send-token-code-0123456789';
const WINDOWS = process.platform === 'linux' && !!process.env.DISPLAY;
const MARKER = 'KEPT-BODY-MARKER';
/** How long the editor waits for the bar to show before it asks. */
const LOOK_MS = 300;

/**
 * A page of the app: `/k` fetches its answers one after another, then says so in its title; `/h` asks every 100 ms
 * whether its failure is held, and once it is, fetches again and logs an error. Every page says when the pause bar
 * shows, and plays a person's part in the element picker, picking the region on `/r` and `/big` and the button
 * elsewhere. The region holds a password field with its value, one in a shadow root, a one-time code's field and a link
 * with a token; on `/big`, text past what a region's snapshot may hold.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>a</title>
<section aria-label="Order summary"><h2>Order summary</h2><p>Total 72</p>
<label>Password <input type="password" value="hunter2-secret"></label>
<label>Code <input autocomplete="one-time-code" value="246810"></label>
<x-secret></x-secret>
<a href="/reset?token=RESET-SECRET-42">Forgot?</a></section>
<button data-testid="go">Go</button>
<script>
customElements.define('x-secret', class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = '<label>Shadow <input type="password" value="shadow-secret"></label>';
  }
});
if (location.pathname === '/big') document.querySelector('section p').textContent = 'many words '.repeat(105 * 1024);
const PICK = location.pathname === '/r' || location.pathname === '/big' ? 'section' : 'button';
new MutationObserver(() => {
  if (document.querySelector('x-pw-glass') && !window.__glassSaid) {
    window.__glassSaid = true;
    fetch('/glass', { method: 'POST', body: location.pathname });
  }
  const bar = document.getElementById('__piwi-pause-bar');
  if (!bar || bar.dataset.seen) return;
  bar.dataset.seen = '1';
  fetch('/bar', { method: 'POST', body: bar.children[0].textContent });
}).observe(document.documentElement, { childList: true, subtree: true });
setInterval(() => {
  if (document.getElementById('__piwi_picker_banner') && window.__piwiPickState === undefined) {
    window.__piwiPickedElement = document.querySelector(PICK);
    window.__piwiPickState = 'picked';
  }
  if (typeof window.__piwiAnchorCleanup === 'function' && window.__piwiAnchorState === undefined) {
    window.__piwiAnchorState = 'skipped';
  }
  const confirm = [...document.querySelectorAll('button')].some((b) => b.textContent.startsWith('Skip '));
  if (confirm && window.__piwiPickChoice === undefined) window.__piwiPickChoice = 0;
}, 100);
if (location.pathname === '/k') {
  (async () => {
    for (const url of ['/api/cart', '/api/big', '/img.png', '/api/text?token=abc123secret']) await (await fetch(url)).arrayBuffer();
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/xhr');
      xhr.onloadend = resolve;
      xhr.send('{}');
    });
    document.title = 'done';
  })();
}
if (location.pathname === '/h') {
  const poll = setInterval(async () => {
    if ((await (await fetch('/api/poll')).text()) !== 'held') return;
    clearInterval(poll);
    console.error('logged during the hold');
    await fetch('/api/during-hold');
  }, 100);
}
</script>`;

const HEADED_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('keeps the text bodies', async ({ page }) => {
  await page.goto('${base}/k');
  await expect(page).toHaveTitle('done');
  await page.keyboard.press('Tab'); // bp
  test.info().annotations.push({ type: 'glass', description: String(await page.evaluate(() => document.querySelectorAll('x-pw-glass').length)) });
});
test('keeps nothing of the test before', async ({ page }) => {
  await page.goto('${base}/a');
  await page.keyboard.press('Tab'); // bp
});
test('asserts a region', async ({ page }) => {
  await page.goto('${base}/r');
  await page.keyboard.press('Tab'); // bp
});
test('asserts a region too long', async ({ page }) => {
  await page.goto('${base}/big');
  await page.keyboard.press('Tab'); // bp
});
test('checks an element', async ({ page }) => {
  await page.goto('${base}/a');
  await page.keyboard.press('Tab'); // bp
});
test('takes every outline down', async ({ page }) => {
  await page.goto('${base}/a');
  const before = await page.screenshot();
  await expect(page.getByTestId('go')).toBeVisible(); // bp
  const after = await page.screenshot();
  test.info().annotations.push({ type: 'same', description: String(before.equals(after)) });
});
test('fails headed', async ({ page }) => {
  await page.goto('${base}/a');
  await expect(page.getByRole('button', { name: 'Missing' })).toBeVisible({ timeout: 300 }); // fails
});
`;

const HEADLESS_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('fails headless', async ({ page }) => {
  await page.goto('${base}/k');
  await expect(page).toHaveTitle('done');
  await expect(page.getByRole('button', { name: 'Missing' })).toBeVisible({ timeout: 300 }); // fails
});
test('fails, its page acting during the hold', async ({ page }) => {
  await page.goto('${base}/h');
  await page.waitForResponse('**/api/poll');
  await expect(page.getByRole('button', { name: 'Missing' })).toBeVisible({ timeout: 300 }); // fails
});
test('fails at an address with a credential', async ({ page }) => {
  await page.goto('${base}/a');
  await page.goto('http://127.0.0.1:1/reset?token=s3cr3t-reset-value&user=jane'); // fails
});
`;

/** The check Assert a region writes, run against the page the region was picked on. */
const CHECK_SPEC = (base: string, locator: string, snapshot: string) => `const { test, expect } = require('../fixture.cjs');
test('matches the region', async ({ page }) => {
  await page.goto('${base}/r');
  await expect(page.${locator}).toMatchAriaSnapshot(${JSON.stringify(snapshot)});
});
`;

/** Tests whose failure comes while the test goes on: a soft one, then a test timeout. */
const LATE_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('fails softly, closes a popup, then times out', async ({ page, context }) => {
  await page.goto('${base}/a');
  await expect.soft(page.getByRole('button', { name: 'Missing' })).toBeVisible({ timeout: 200 }); // soft
  const popup = await context.newPage();
  await popup.goto('${base}/a');
  await popup.close();
  await page.getByRole('button', { name: 'Never' }).click();
});
test('times out in a click', async ({ page }) => {
  await page.goto('${base}/a');
  await page.getByRole('button', { name: 'Never' }).click(); // cut short
});
`;

/** Each test's steps, annotations and attachments, as the run's own reporter writes them. */
const STEPS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const step = (s) => ({ title: s.title, steps: s.steps.map(step) });
    this.tests.push({
      title: test.title,
      status: result.status,
      duration: result.duration,
      annotations: test.annotations.concat(result.annotations ?? []),
      attachments: result.attachments.map((a) => ({ name: a.name, body: a.body ? a.body.toString('utf8') : (a.path && fs.existsSync(a.path) ? fs.readFileSync(a.path, 'latin1') : '') })),
      steps: result.steps.map(step),
    });
  }
  onStdOut(chunk) { process.stdout.write(chunk); }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface DumpedStep {
  title: string;
  steps: DumpedStep[];
}

interface DumpedTest {
  title: string;
  status: string;
  duration: number;
  annotations: Array<{ type: string; description?: string }>;
  attachments: Array<{ name: string; body: string }>;
  steps: DumpedStep[];
}

/** A worker's run connection, as the fake editor service holds it. */
interface Connection {
  socket: net.Socket;
  heard: RunToHub[];
  /** When each message was heard, in ms. */
  times: number[];
  test: string | null;
}

type Stopped = Extract<RunToHub, { type: 'stopped' }>;

let server: FakeServer;
let hub: net.Server;
let folder = '';
let socketPath = '';
const connections: Connection[] = [];
/** The record channel's hand-offs the editor heard, and the picks posted to its Send to editor endpoint. */
const handoffs: unknown[] = [];
const picks: Array<{ body: unknown }> = [];
/** What the pause bar said each time it showed, and the pages an outline was drawn in. */
const bars: string[] = [];
const outlined: string[] = [];
/** What the worker answered, and what it sent, by test. */
const heard: Record<string, unknown[]> = {};
/** The stops each test made, by test. */
const stops: Record<string, Stopped[]> = {};
/** Whether the fake editor says it shows a held failure, as one that predates the hold does not. */
let showsFailures = true;
/** Whether the page of the failure held is told so, and whether it acted then. */
let held = false;
let actedDuringHold = false;
let tests: DumpedTest[] = [];
let exitCode: number | null = null;
let output = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined, ms = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(20);
  }
}

function send(connection: Connection, message: HubToRun): void {
  connection.socket.write(`${JSON.stringify(message)}\n`);
}

let requests = 0;
/** Asks the worker at a stop, and waits for its answer's value. */
async function ask(connection: Connection, message: Record<string, unknown>): Promise<unknown> {
  const request = ++requests;
  send(connection, { type: 'request', request, ...message } as HubToRun);
  const answer = await waitFor(() => connection.heard.find((m) => m.type === 'answer' && m.request === request));
  return (answer as { value: unknown }).value;
}

/** The editor's side of each stop. */
async function onStopped(connection: Connection, stop: Stopped): Promise<void> {
  const test = connection.test!;
  (stops[test] ??= []).push(stop);
  const said = (heard[test] ??= []);
  const barsBefore = bars.length;
  if (stop.bar) await waitFor(() => (bars.length > barsBefore ? true : undefined));
  await sleep(LOOK_MS);
  const at = { stop: stop.stop };
  switch (test) {
    case 'keeps the text bodies': {
      const listed = (await ask(connection, { what: 'requests', ...at })) as { requests: Array<{ id: number }> };
      said.push(listed);
      said.push(await ask(connection, { what: 'mock', ...at, id: listed.requests[0]?.id ?? 1 }));
      said.push(await ask(connection, { what: 'mock', ...at, id: 99 }));
      said.push(await ask(connection, { what: 'locator', ...at, locator: "getByRole('button', { name: 'Go' })" }));
      said.push(await ask(connection, { what: 'locator', ...at, locator: "getByText('Nowhere')" }));
      said.push(await ask(connection, { what: 'locator', ...at, locator: 'getByRole(' }));
      // The outline of the first one, drawn again: the test going on takes it down.
      said.push(await ask(connection, { what: 'locator', ...at, locator: "getByTestId('go')" }));
      break;
    }
    case 'takes every outline down':
      // Two asked at once, as the caret moves from line to line.
      said.push(
        ...(await Promise.all([
          ask(connection, { what: 'locator', ...at, locator: "getByRole('button', { name: 'Go' })" }),
          ask(connection, { what: 'locator', ...at, locator: "getByTestId('go')" }),
        ])),
      );
      break;
    case 'keeps nothing of the test before':
      said.push(await ask(connection, { what: 'requests', ...at }));
      break;
    case 'asserts a region':
    case 'asserts a region too long':
      said.push(await ask(connection, { what: 'assert-region', ...at }));
      said.push(await waitFor(() => connection.heard.find((m) => m.type === 'region' && m.stop === stop.stop)));
      await waitFor(() => (bars.length > barsBefore + 1 ? true : undefined));
      break;
    case 'checks an element':
      said.push(await ask(connection, { what: 'assert', ...at }));
      await waitFor(() => (handoffs.length ? true : undefined));
      await waitFor(() => (bars.length > barsBefore + 1 ? true : undefined));
      break;
    case 'fails headed':
      said.push(await ask(connection, { what: 'pick', ...at }));
      await waitFor(() => (picks.length ? true : undefined));
      await waitFor(() => (bars.length > barsBefore + 1 ? true : undefined));
      break;
    case 'fails headless':
      said.push(await ask(connection, { what: 'assert', ...at }));
      said.push(await ask(connection, { what: 'requests', ...at }));
      said.push(await ask(connection, { what: 'locator', ...at, locator: "getByTestId('go')" }));
      break;
    case 'fails, its page acting during the hold':
      held = true;
      await waitFor(() => (actedDuringHold ? true : undefined));
      break;
  }
  send(connection, { type: 'control', action: 'resume', stop: stop.stop });
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** Runs the project's Playwright with `env`, and reads what its reporter wrote. */
function run(
  env: NodeJS.ProcessEnv,
  args: string[] = [],
  timeout = 120_000,
): Promise<{ code: number; output: string; tests: DumpedTest[] }> {
  const results = path.join(project, 'results.json');
  fs.rmSync(results, { force: true });
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test', ...args],
      { cwd: project, env, timeout, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          output: `${stdout}\n${stderr}`,
          tests: fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [],
        });
      },
    );
  });
}

let baseEnv: NodeJS.ProcessEnv = {};
const channel = () => formatRecordChannel({ path: socketPath, token: TOKEN });

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-code-'));
  socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((socket) => {
    const connection: Connection = { socket, heard: [], times: [], test: null };
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    let first = true;
    socket.on(
      'data',
      lineReader(
        (line) => {
          if (first) {
            first = false;
            const attach = parseHandoffToEditor(line);
            if (attach?.type === 'attach') {
              handoffs.push(attach);
              socket.end(`${JSON.stringify({ type: 'refused', message: 'this editor takes no check.' })}\n`);
              return;
            }
            connections.push(connection);
          }
          const message = parseRunToHub(line);
          if (!message) return;
          // As the editor service answers a worker that holds a failure only for an editor that shows one.
          if (message.type === 'run-attach' && message.holds && showsFailures) {
            send(connection, { type: 'attached', holds: message.holds });
          }
          connection.heard.push(message);
          connection.times.push(Date.now());
          if (message.type === 'test-begin') connection.test = message.title[message.title.length - 1]!;
          if (message.type === 'stopped') void onStopped(connection, message);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));

  server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    switch (url.pathname) {
      case '/bar':
        bars.push(req.body);
        return res.end();
      case '/glass':
        outlined.push(req.body);
        return res.end();
      case '/piwi/send':
        picks.push({ body: JSON.parse(req.body) });
        return jsonRes(res, 200, { inserted: true, file: null });
      case '/api/cart':
        return jsonRes(res, 200, { marker: MARKER, items: [] });
      case '/api/big':
        return jsonRes(res, 200, { big: 'x'.repeat(300 * 1024) });
      case '/img.png':
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      case '/api/text':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('hello');
      case '/api/xhr':
        return jsonRes(res, 201, { saved: true });
      case '/api/poll':
        return res.end(held ? 'held' : 'no');
      case '/api/during-hold':
        actedDuringHold = true;
        return jsonRes(res, 200, { during: 'hold' });
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });

  write('tests/headed.spec.cjs', HEADED_SPEC(server.url));
  write('tests/headless.spec.cjs', HEADLESS_SPEC(server.url));
  write('tests/late.spec.cjs', LATE_SPEC(server.url));
  write(
    'fixture.cjs',
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  write('steps-reporter.cjs', STEPS_REPORTER);
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 5000,
  workers: 1,
  reporter: [['./steps-reporter.cjs', { outputFile: 'results.json' }]],
  projects: [
    { name: 'check', testMatch: 'check.spec.cjs', use: { headless: true } },
    {
      name: 'headed',
      testMatch: 'headed.spec.cjs',
      use: { headless: false, launchOptions: { args: ${WINDOWS ? '[]' : "['--headless=new']"} } },
    },
    { name: 'headless', testMatch: 'headless.spec.cjs', use: { headless: true } },
    { name: 'late', testMatch: 'late.spec.cjs', use: { headless: true } },
  ],
});
`,
  );
  const breakpoints = HEADED_SPEC(server.url)
    .split('\n')
    .flatMap((line, i) => (line.endsWith('// bp') ? [`tests/headed.spec.cjs:${i + 1}`] : []))
    .join(';');
  baseEnv = { ...process.env, PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: REF };
  for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL']) delete baseEnv[name];
  const ran = await run(
    {
      ...baseEnv,
      PIWI_RUN_CHANNEL: channel(),
      PIWI_RECORD_CHANNEL: channel(),
      PIWI_EDITOR_SEND: `${server.url}/piwi/send#${SEND_TOKEN}`,
      PIWI_PAUSE_AT: breakpoints,
    },
    ['--project=headed', '--project=headless'],
  );
  exitCode = ran.code;
  output = ran.output;
  tests = ran.tests;
}, 180_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  for (const connection of connections) connection.socket.destroy();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

function allSteps(steps: DumpedStep[]): DumpedStep[] {
  return steps.flatMap((s) => [s, ...allSteps(s.steps)]);
}

const lineOf = (spec: string, marker: string) => spec.split('\n').findIndex((line) => line.endsWith(marker)) + 1;

describe('code from a stop, the worker’s part', () => {
  it('lets the tests end as they would, the failures as failures, and says what the worker takes', () => {
    expect(exitCode, output).toBe(1);
    expect(tests.map((t) => [t.title, t.status])).toEqual([
      ['keeps the text bodies', 'passed'],
      ['keeps nothing of the test before', 'passed'],
      ['asserts a region', 'passed'],
      ['asserts a region too long', 'passed'],
      ['checks an element', 'passed'],
      ['takes every outline down', 'passed'],
      ['fails headed', 'failed'],
      ['fails headless', 'failed'],
      ['fails, its page acting during the hold', 'failed'],
      ['fails at an address with a credential', 'failed'],
    ]);
    expect(connections[0]!.heard[0]).toMatchObject({
      type: 'run-attach',
      takes: ['pick', 'record', 'assert', 'assert-region', 'requests', 'mock', 'locator', 'view', 'input', 'input-clicks', 'pick-at', 'agent', 'events', 'bind', 'end', 'share'],
      holds: ['failure'],
    });
  });

  it('keeps the text bodies of the fetch and XHR answers alone, 256 KB each at most, and hands over the one asked', () => {
    const [listed, mock, gone] = heard['keeps the text bodies']!;
    expect(listed).toEqual({
      ok: true,
      message: 'The test kept 3 responses.',
      requests: [
        {
          id: 1,
          method: 'GET',
          url: `${server.url}/api/cart`,
          status: 200,
          type: 'application/json',
          size: expect.any(Number),
          time: expect.any(Number),
        },
        // A credential in a URL is hidden; a body sent in chunks says no size.
        {
          id: 2,
          method: 'GET',
          url: `${server.url}/api/text?token=<hidden>`,
          status: 200,
          type: 'text/plain',
          size: null,
          time: expect.any(Number),
        },
        {
          id: 3,
          method: 'POST',
          url: `${server.url}/api/xhr`,
          status: 201,
          type: 'application/json',
          size: expect.any(Number),
          time: expect.any(Number),
        },
      ],
    });
    expect(mock).toEqual({
      ok: true,
      message: `GET ${server.url}/api/cart`,
      response: {
        method: 'GET',
        url: `${server.url}/api/cart`,
        status: 200,
        type: 'application/json',
        body: JSON.stringify({ marker: MARKER, items: [] }),
      },
    });
    expect(gone).toEqual({
      ok: false,
      message: 'The test kept no such response: it keeps the latest 50.',
      response: null,
    });
    // A new test keeps its own.
    expect(heard['keeps nothing of the test before']).toEqual([
      {
        ok: true,
        message: 'The test kept no response yet: Piwi keeps the text answers of its fetch and XHR requests.',
        requests: [],
      },
    ]);
  });

  it('never puts a kept body in an attachment', () => {
    for (const result of tests) {
      for (const attachment of result.attachments) expect(attachment.body, attachment.name).not.toContain(MARKER);
    }
  });

  it('counts a locator on the stopped page, outlines its matches and takes the outline down as the test goes on', () => {
    const [, , , one, none, broken, again] = heard['keeps the text bodies']!;
    expect(one).toEqual({ ok: true, message: '1 element matches.', count: 1 });
    expect(none).toEqual({ ok: true, message: 'No element matches.', count: 0 });
    expect(broken).toEqual({ ok: false, message: 'getByRole( is not a locator Piwi can build.', count: null });
    expect(again).toEqual({ ok: true, message: '1 element matches.', count: 1 });
    // Drawn in the page while it stood stopped, gone once the test went on.
    expect(outlined).toContain('/k');
    const glass = tests[0]!.annotations.find((a) => a.type === 'glass');
    expect(glass?.description).toBe('0');
  });

  it('takes the outlines of two locators counted at once down, the page as it was before the stop', () => {
    expect(heard['takes every outline down']).toEqual([
      { ok: true, message: '1 element matches.', count: 1 },
      { ok: true, message: '1 element matches.', count: 1 },
    ]);
    const result = tests.find((t) => t.title === 'takes every outline down')!;
    expect(result.annotations.find((a) => a.type === 'same')?.description).toBe('true');
  });

  it('picks a region in the test’s window and sends its ARIA snapshot', () => {
    const [started, region] = heard['asserts a region']!;
    expect(started).toEqual({
      ok: true,
      message: "Pick the region in the test's window: the editor writes its ARIA snapshot above the stopped line.",
    });
    expect(region).toEqual({
      type: 'region',
      stop: stops['asserts a region']![0]!.stop,
      locator: "getByRole('region', { name: 'Order summary' })",
      snapshot: expect.stringContaining('- heading "Order summary" [level=2]'),
    });
    // Neither a secret nor a link's token goes to the editor: the fields and the link are written without them, a
    // password in a shadow root and a one-time code included.
    const { snapshot } = region as { snapshot: string };
    expect(snapshot).toContain('- textbox "Password"\n');
    expect(snapshot).toContain('- textbox "Code"\n');
    expect(snapshot).toContain('- textbox "Shadow"\n');
    expect(snapshot).toMatch(/- link "Forgot\?"$/m);
    for (const secret of ['hunter2-secret', '246810', 'shadow-secret', 'RESET-SECRET-42']) {
      expect(snapshot).not.toContain(secret);
    }
  });

  it('sends a region’s snapshot whose toMatchAriaSnapshot passes against the page it was picked on', async () => {
    const [, region] = heard['asserts a region']!;
    const { locator, snapshot } = region as { locator: string; snapshot: string };
    write('tests/check.spec.cjs', CHECK_SPEC(server.url, locator, snapshot));
    const checked = await run(baseEnv, ['--project=check'], 60_000);
    expect(checked.tests.map((t) => [t.title, t.status]), checked.output).toEqual([['matches the region', 'passed']]);
  }, 90_000);

  it('says why a region picked brings no snapshot, at its stop', () => {
    const [started, region] = heard['asserts a region too long']!;
    expect(started).toMatchObject({ ok: true });
    expect(region).toEqual({
      type: 'region',
      stop: stops['asserts a region too long']![0]!.stop,
      refused: "The ARIA snapshot of getByRole('region', { name: 'Order summary' }) is longer than 1048576 characters: pick a smaller region.",
    });
  });

  it('hands the page to the editor’s check panel through a hand-off in its check mode', () => {
    expect(heard['checks an element']).toEqual([
      {
        ok: true,
        message: "Check an element in the test's window: the editor writes the check above the stopped line.",
      },
    ]);
    expect(handoffs).toEqual([
      expect.objectContaining({
        type: 'attach',
        token: TOKEN,
        line:
          HEADED_SPEC(server.url)
            .split('\n')
            .findIndex((l) => l.includes("'checks an element'")) + 3,
        reason: 'breakpoint',
        mode: 'check',
        stop: { ref: REF, worker: expect.any(Number), stop: stops['checks an element']![0]!.stop },
      }),
    ]);
    expect(output).toContain('[piwi] Nothing was checked: this editor takes no check.');
  });

  it('holds a failure at its line, the bar saying so, where Pick replaces the failing locator', () => {
    const line = lineOf(HEADED_SPEC(server.url), '// fails');
    expect(stops['fails headed']).toEqual([
      {
        type: 'stopped',
        stop: expect.any(Number),
        reason: 'failure',
        title: expect.stringMatching(/^Failed: .*toBeVisible/),
        place: { file: 'tests/headed.spec.cjs', line, column: expect.any(Number) },
        locator: "getByRole('button', { name: 'Missing' })",
        bar: true,
        // The error as plain text, without the runner's `Error: ` nor its ANSI codes.
        error: 'expect(locator).toBeVisible() failed',
      },
    ]);
    expect(bars).toContain(`Failed at headed.spec.cjs:${line}`);
    expect(heard['fails headed']).toEqual([
      { ok: true, message: "Pick an element in the test's window: the locator goes to the editor." },
    ]);
    expect(picks).toEqual([
      { body: { kind: 'locator', text: "getByTestId('go')", at: { file: 'tests/headed.spec.cjs', line } } },
    ]);
  });

  it('holds a headless failure for the editor, which can count and list there but not check', () => {
    const line = lineOf(HEADLESS_SPEC(server.url), '// fails');
    expect(stops['fails headless']).toEqual([
      expect.objectContaining({
        reason: 'failure',
        place: expect.objectContaining({ line }),
        bar: false,
        error: 'expect(locator).toBeVisible() failed',
      }),
    ]);
    const [check, listed, counted] = heard['fails headless']!;
    expect(check).toEqual({
      ok: false,
      message: "Assert needs the pause bar in the test's window, and this stop shows none: run the test headed.",
    });
    expect(listed).toMatchObject({ ok: true, message: 'The test kept 3 responses.' });
    expect(counted).toEqual({ ok: true, message: '1 element matches.', count: 1 });
  });

  it('hides the credentials of the URL a failure names in its title and its error', () => {
    const [stop] = stops['fails at an address with a credential']!;
    expect(stop).toMatchObject({ reason: 'failure', bar: false });
    for (const text of [stop!.title, stop!.error!]) {
      expect(text).toContain('/reset?token=<hidden>&user=jane');
      expect(text).not.toContain('s3cr3t-reset-value');
    }
  });

  it('keeps the evidence of a failure held as it was when the hold began', () => {
    const result = tests.find((t) => t.title === 'fails, its page acting during the hold')!;
    expect(actedDuringHold).toBe(true);
    const network = result.attachments.find((a) => a.name === 'piwi-network')!;
    expect(network.body).toContain('/api/poll');
    expect(network.body).not.toContain('/api/during-hold');
    const consoleEntries = result.attachments.find((a) => a.name === 'piwi-console')?.body ?? '';
    expect(consoleEntries).not.toContain('logged during the hold');
  });

  it('holds a failure once its test ended, the test timeout as it was, at the call a test timeout cut short', async () => {
    const before = connections.length;
    const late = await run(
      { ...baseEnv, PIWI_RUN_CHANNEL: channel(), PIWI_RECORD_CHANNEL: channel() },
      ['--project=late'],
      60_000,
    );
    expect(late.tests.map((t) => t.title)).toEqual([
      'fails softly, closes a popup, then times out',
      'times out in a click',
    ]);
    for (const result of late.tests) {
      expect(['failed', 'timedOut'], result.title).toContain(result.status);
      // The test timeout of 5 s still ends the test: the hold neither lifts it nor comes before.
      expect(result.duration, result.title).toBeLessThan(8000);
    }
    const heardLate = connections.slice(before).flatMap((c) => c.heard.map((m, i) => ({ m, at: c.times[i]! })));
    const held = heardLate.flatMap(({ m }) => (m.type === 'stopped' ? [m] : []));
    expect(held.map((m) => [m.reason, m.place.line])).toEqual([
      ['failure', lineOf(LATE_SPEC(server.url), '// soft')],
      ['failure', lineOf(LATE_SPEC(server.url), '// cut short')],
    ]);
    // Each names the error it stopped at, the soft assertion's and the test timeout's.
    expect(held.map((m) => m.error)).toEqual([
      'expect(locator).toBeVisible() failed',
      expect.stringMatching(/timeout/i),
    ]);
    // Each one held once its test ended, after its test timeout of 5 s.
    for (const stop of held) {
      const at = heardLate.find(({ m }) => m === stop)!.at;
      const begun = heardLate.filter(({ m, at: t }) => m.type === 'test-begin' && t < at).pop()!.at;
      expect(at - begun).toBeGreaterThanOrEqual(5000);
    }
  }, 90_000);

  it('shows none of its own calls among the test’s steps', () => {
    for (const result of tests) {
      // The test that compares the page before and after its stop takes its own two screenshots.
      const own = result.title === 'takes every outline down' ? 2 : 0;
      const titles = allSteps(result.steps).map((s) => s.title);
      expect(
        titles.filter((t) => /Screenshot/i.test(t)),
        result.title,
      ).toHaveLength(own);
      expect(titles, result.title).not.toContainEqual(
        expect.stringMatching(
          /Bring to front|Pause on next|Wait for function|Highlight|Aria snapshot|Count|Piwi capture|Response body/i,
        ),
      );
    }
    // Reading a region's password fields is no step either.
    const region = allSteps(tests.find((t) => t.title === 'asserts a region')!.steps).map((s) => s.title);
    expect(region).not.toContainEqual(expect.stringMatching(/Evaluate/i));
  });

  it('holds no failure for an editor that does not say it shows one, as one that predates the hold', async () => {
    const before = connections.length;
    showsFailures = false;
    try {
      const old = await run({ ...baseEnv, PIWI_RUN_CHANNEL: channel() }, [
        '--project=headless',
        '--grep',
        'fails headless',
      ]);
      expect(old.tests.map((t) => [t.title, t.status])).toEqual([['fails headless', 'failed']]);
    } finally {
      showsFailures = true;
    }
    const connection = connections[before]!;
    expect(connection.heard[0]).toMatchObject({ type: 'run-attach', holds: ['failure'] });
    expect(connection.heard.filter((m) => m.type === 'stopped')).toEqual([]);
  }, 120_000);

  it('holds no failure under CI, nor without a run connection', async () => {
    const before = connections.length;
    const ci = await run({ ...baseEnv, CI: '1', PIWI_RUN_CHANNEL: channel() }, [
      '--project=headless',
      '--grep',
      'fails headless',
    ]);
    expect(ci.tests.map((t) => [t.title, t.status])).toEqual([['fails headless', 'failed']]);
    const ciConnection = connections[before]!;
    expect(ciConnection.heard).toContainEqual(
      expect.objectContaining({ type: 'test-begin', cannotPause: expect.stringContaining('CI') }),
    );
    expect(ciConnection.heard.filter((m) => m.type === 'stopped')).toEqual([]);

    const plain = await run(baseEnv, ['--project=headless', '--grep', 'fails headless']);
    expect(plain.tests.map((t) => [t.title, t.status])).toEqual([['fails headless', 'failed']]);
    expect(connections.length).toBe(before + 1);
  }, 120_000);
});
