import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader, parseHandoffToEditor } from '@piwitests/core/ide-recorder';
import {
  parseRunToHub,
  type BindAnswer,
  type HubToRun,
  type RefLocatorAnswer,
  type RunEvent,
  type RunToHub,
  type SnapshotAnswer,
} from '@piwitests/core/run-channel';
import { startServer, type FakeServer } from './_helpers.js';

/**
 * What an agent asks of a stopped page, in a real Playwright run through the built package: a fake editor service on
 * the socket the run names follows the run as its events, and at the stop reads the page's ARIA snapshot in AI mode,
 * ranks an element's locators by its ref (the project's test id attribute first), clicks it and fills a field as
 * trusted input, and shares the browser with Playwright's own tools, which a second client joins. Nothing it does is a
 * step of the test, a password's value never leaves the worker, and the shared browser is let go as the test ends.
 * Headless Chromium.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-agent-${process.pid}`);
const REF = 'ed-a9e47a9e';
const TOKEN = 'run-agent-token-0123456789';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const requireHere = createRequire(import.meta.url);

const PAGE = `<!doctype html><meta charset="utf-8"><title>Shop</title>
<h1>Shop</h1>
<button onclick="document.querySelector('h1').textContent = 'Clicked'">Go</button>
<button data-qa="pay">Pay</button>
<label>Coupon <input id="coupon"></label>
<label>Password <input type="password" id="pw" value="hunter2-secret"></label>
<p>session ${JWT}</p>
<script>console.error('the page logs an error'); fetch('/broken');</script>`;

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('stopped for an agent', async ({ page }) => {
  await page.goto('${base}/shop');
  await expect(page.locator('h1')).toBeVisible(); // bp
  await expect(page.locator('h1')).toHaveText('Clicked');
  await expect(page.locator('#coupon')).toHaveValue('WELCOME10');
});
`;

const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const step = (s) => ({ title: s.title, steps: s.steps.map(step) });
    this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message), steps: result.steps.map(step) });
  }
  onStdOut(chunk) { process.stdout.write(chunk); }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface Connection {
  socket: net.Socket;
  heard: RunToHub[];
}

let server: FakeServer;
let hub: net.Server;
let folder = '';
let connection: Connection | null = null;
let exitCode: number | null = null;
let output = '';
let tests: Array<{
  title: string;
  status: string;
  errors: string[];
  steps: Array<{ title: string; steps: unknown[] }>;
}> = [];
/** What the fake editor read at the stop, in order. */
const read: {
  snapshot?: SnapshotAnswer;
  depth?: SnapshotAnswer;
  go?: RefLocatorAnswer;
  pay?: RefLocatorAnswer;
  password?: RefLocatorAnswer;
  clicked?: RefLocatorAnswer;
  after?: SnapshotAnswer;
  filled?: RefLocatorAnswer;
  wrong?: RefLocatorAnswer;
  stale?: RefLocatorAnswer;
  refused?: unknown;
  bound?: BindAnswer;
  joined?: { contexts: number; url: string | null } | { error: string };
  unbound?: BindAnswer;
} = {};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(get: () => T | undefined | false, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(20);
  }
}

let requests = 0;
async function ask<T>(c: Connection, message: Record<string, unknown> & { what: string }): Promise<T> {
  const request = ++requests;
  c.socket.write(`${JSON.stringify({ type: 'request', request, ...message })}\n`);
  const answer = await waitFor(() => c.heard.find((m) => m.type === 'answer' && m.request === request));
  return (answer as unknown as { value: T }).value;
}

/** The ref of the first line of a snapshot that holds `text`. */
function refOf(snapshot: string, text: string): string {
  const line = snapshot.split('\n').find((l) => l.includes(text));
  const ref = /\[ref=(e\d+)\]/.exec(line ?? '')?.[1];
  if (!ref) throw new Error(`no ref for ${text} in:\n${snapshot}`);
  return ref;
}

async function onStopped(c: Connection, stop: Extract<RunToHub, { type: 'stopped' }>): Promise<void> {
  const at = { stop: stop.stop };
  try {
    read.snapshot = await ask<SnapshotAnswer>(c, { what: 'snapshot', ...at, depth: null, image: true });
    read.depth = await ask<SnapshotAnswer>(c, { what: 'snapshot', ...at, depth: 1, image: false });
    const snapshot = read.snapshot.snapshot ?? '';
    read.go = await ask(c, { what: 'ref-locator', ...at, ref: refOf(snapshot, 'button "Go"') });
    read.pay = await ask(c, { what: 'ref-locator', ...at, ref: refOf(snapshot, 'button "Pay"') });
    read.password = await ask(c, { what: 'ref-locator', ...at, ref: refOf(snapshot, 'textbox "Password"') });
    read.clicked = await ask(c, {
      what: 'act',
      ...at,
      ref: refOf(snapshot, 'button "Go"'),
      action: 'click',
      value: null,
    });
    read.after = await ask<SnapshotAnswer>(c, { what: 'snapshot', ...at, depth: null, image: false });
    read.filled = await ask(c, {
      what: 'act',
      ...at,
      ref: refOf(snapshot, 'textbox "Coupon"'),
      action: 'fill',
      value: 'WELCOME10',
    });
    read.wrong = await ask(c, {
      what: 'act',
      ...at,
      ref: refOf(snapshot, 'button "Pay"'),
      action: 'fill',
      value: 'x',
    });
    read.stale = await ask(c, { what: 'act', ...at, ref: 'e999', action: 'click', value: null });
    read.refused = await ask(c, { what: 'act', stop: stop.stop + 1, ref: 'e1', action: 'click', value: null });
    read.bound = await ask<BindAnswer>(c, { what: 'bind', ...at, on: true });
    try {
      const { chromium } = requireHere('@playwright/test') as {
        chromium: {
          connect(
            endpoint: string,
            options: { timeout: number },
          ): Promise<{
            contexts(): Array<{ pages(): Array<{ url(): string }> }>;
            close(): Promise<void>;
          }>;
        };
      };
      const browser = await chromium.connect(read.bound.endpoint!, { timeout: 10_000 });
      const contexts = browser.contexts();
      read.joined = { contexts: contexts.length, url: contexts[0]?.pages()[0]?.url() ?? null };
      await browser.close();
    } catch (error) {
      read.joined = { error: String(error) };
    }
  } catch (error) {
    read.refused = { gaveUp: String(error) };
  }
  c.socket.write(`${JSON.stringify({ type: 'control', action: 'resume', stop: stop.stop } satisfies HubToRun)}\n`);
}

const events = () => (connection?.heard ?? []).flatMap((m) => (m.type === 'event' ? [m.event] : [])) as RunEvent[];

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-agent-'));
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    let first = true;
    const own: Connection = { socket, heard: [] };
    socket.on(
      'data',
      lineReader(
        (line) => {
          if (first) {
            first = false;
            if (parseHandoffToEditor(line)?.type === 'attach') return void socket.end();
            connection = own;
            // The agent follows the run from its start.
            socket.write(`${JSON.stringify({ type: 'events', on: true } satisfies HubToRun)}\n`);
          }
          const message = parseRunToHub(line);
          if (!message) return;
          own.heard.push(message);
          if (message.type === 'stopped') void onStopped(own, message);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));
  server = await startServer((req, res) => {
    if (req.url === '/broken') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('broken');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  const spec = SPEC(server.url);
  fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(project, 'tests', 'agent.spec.cjs'), spec);
  fs.writeFileSync(
    path.join(project, 'fixture.cjs'),
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  fs.writeFileSync(path.join(project, 'results-reporter.cjs'), RESULTS_REPORTER);
  fs.writeFileSync(
    path.join(project, 'playwright.config.cjs'),
    `module.exports = { testDir: './tests', outputDir: './test-results', timeout: 15000, workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  use: { headless: true, testIdAttribute: 'data-qa', viewport: { width: 800, height: 600 } } };
`,
  );
  const line = spec.split('\n').findIndex((l) => l.endsWith('// bp')) + 1;
  const channel = formatRecordChannel({ path: socketPath, token: TOKEN });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: channel,
    PIWI_RECORD_CHANNEL: channel,
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
    PIWI_PAUSE_AT: `tests/agent.spec.cjs:${line}`,
  };
  for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_EDITOR_SEND']) delete env[name];
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [requireHere.resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 90_000 },
      (error, stdout, stderr) => {
        exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'results.json');
  tests = fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [];
}, 120_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  connection?.socket.destroy();
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

/** Every step title of a test, nested ones included. */
const titles = (steps: Array<{ title: string; steps: unknown[] }>): string[] =>
  steps.flatMap((s) => [s.title, ...titles(s.steps as Array<{ title: string; steps: unknown[] }>)]);

describe('a stopped page, for an agent', () => {
  it('lets the test pass on what the agent did, and says it takes what an agent asks as it attaches', () => {
    expect(exitCode, output).toBe(0);
    expect(tests.map((t) => [t.title, t.status, t.errors])).toEqual([['stopped for an agent', 'passed', []]]);
    expect(connection!.heard[0]).toMatchObject({
      type: 'run-attach',
      takes: expect.arrayContaining(['agent', 'events', 'bind']),
    });
  });

  it('reads the ARIA snapshot in AI mode with refs, to a depth, with an image, its credentials hidden', () => {
    expect(read.snapshot).toMatchObject({ ok: true, title: 'Shop', cut: false, image: { mime: 'image/jpeg' } });
    expect(read.snapshot!.url).toBe(`${server.url}/shop`);
    const snapshot = read.snapshot!.snapshot!;
    expect(snapshot).toMatch(/button "Go" \[ref=e\d+\]/);
    expect(snapshot).toMatch(/textbox "Coupon" \[ref=e\d+\]/);
    expect(snapshot).not.toContain(JWT);
    expect(snapshot).not.toContain('hunter2-secret');
    expect(read.depth!.snapshot!.length).toBeLessThan(snapshot.length);
  });

  it('ranks an element by its ref as Pick does, the project’s test id attribute first, and never sends a password', () => {
    expect(read.go).toMatchObject({
      ok: true,
      element: { tagName: 'button', role: 'button', name: 'Go', secret: false },
    });
    expect(read.go!.locators[0]).toMatchObject({ locator: "getByRole('button', { name: 'Go' })", unique: true });
    expect(read.pay!.locators[0]).toMatchObject({ locator: "getByTestId('pay')", unique: true });
    expect(read.pay!.element!.testId).toBe('pay');
    expect(read.password!.element).toMatchObject({ secret: true, value: null });
    expect(JSON.stringify(read.password)).not.toContain('hunter2-secret');
  });

  it('acts by a ref as trusted input, the page changing under it, none of it a step of the test', () => {
    expect(read.clicked).toMatchObject({ ok: true, element: { name: 'Go' } });
    expect(read.clicked!.message).toMatch(/^Clicked e\d+\.$/);
    expect(read.after!.snapshot).toContain('heading "Clicked"');
    expect(read.filled).toMatchObject({ ok: true });
    // Playwright's call log quotes the element's HTML, the page's text: only its error's first line comes back.
    expect(read.wrong).toMatchObject({ ok: false });
    expect(read.wrong!.message).toMatch(/^Filled e\d+ failed: /);
    expect(read.wrong!.message).not.toMatch(/\n|Call log|<button/);
    expect(read.stale).toMatchObject({ ok: false, element: null });
    expect(read.stale!.message).toContain('No element of the stopped page has the ref e999');
    expect(read.refused).toMatchObject({ ok: false, message: 'The test went on.' });
    const steps = titles(tests[0]!.steps);
    expect(
      steps.some((t) => /^(Click|Fill|Aria snapshot|Bind|Get by ref|Piwi capture)/i.test(t)),
      steps.join('\n'),
    ).toBe(false);
  });

  it('shares the browser with Playwright tools on request, which a second client joins at the stop', () => {
    expect(read.bound).toMatchObject({ ok: true, name: `piwi-${REF}-w0` });
    expect(read.bound!.message).toContain('any process of yours can drive it');
    expect(read.joined).toMatchObject({ contexts: 1, url: `${server.url}/shop` });
  });

  it('tells what the test does: its calls and their places, the navigation, the console error and failed request', () => {
    const told = events();
    const calls = told.filter((e): e is Extract<RunEvent, { kind: 'call' }> => e.kind === 'call');
    expect(calls.find((c) => c.title.startsWith('page.goto') || c.title.startsWith('Navigate'))).toMatchObject({
      ok: true,
      place: { file: 'tests/agent.spec.cjs', line: 3 },
    });
    expect(calls.some((c) => c.place?.line === 5)).toBe(true);
    expect(calls.every((c) => !/Piwi capture/.test(c.title))).toBe(true);
    expect(told).toContainEqual({ kind: 'navigation', url: `${server.url}/shop` });
    expect(told).toContainEqual({ kind: 'console', level: 'error', text: 'the page logs an error' });
    expect(told).toContainEqual(
      expect.objectContaining({ kind: 'request-failed', method: 'GET', url: `${server.url}/broken`, status: 500 }),
    );
  });
});
