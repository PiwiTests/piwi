import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { MAX_FILMSTRIP } from '@piwitests/core/live-layers';
import { parseRunToHub, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { playwrightAtLeast, startServer, type FakeServer, withoutCi } from './_helpers.js';

/**
 * The layers of a worker's lane view, in a real Playwright run through the built package: a fake editor service on the
 * socket the run names watches the worker's lane and asks for every layer, as a lane view of the Runs window does.
 * It hears the call a click waits in from Playwright's in-process instrumentation in a run Piwi may pause, the page's
 * console error, uncaught error, failed request, a request pending long and the backend's logged error, the test's API
 * call, the page's text from the trace with its password and card number hidden, and the test's filmstrip from the
 * trace, sent again as asked again. A second project whose trace is off has its text taken as asked. Nothing goes
 * once the lane view is off.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-layers-${process.pid}`);
const REF = 'ed-1a7e1a7e';
const TOKEN = 'run-layers-token-0123456789';
const SECRET = 'S3cr3t!Pw';
const CARD = '4111 1111 1111 1111';
const requireHere = createRequire(import.meta.url);
/** The trace writes ARIA snapshots from Playwright 1.64 on. */
const TRACE_ARIA = playwrightAtLeast('1.64');

/** A checkout: a password, a card number, and Pay enabled 2.5 s after Check is clicked. */
const SHOP = `<!doctype html><meta charset="utf-8"><title>shop</title>
<style>body { margin: 0; padding: 20px; font: 16px sans-serif }</style>
<label>Password <input type="password"></label>
<label>Card number <input autocomplete="cc-number"></label>
<button onclick="setTimeout(() => { document.getElementById('pay').disabled = false; }, 2500)">Check</button>
<button id="pay" disabled>Pay</button>`;

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('checkout', async ({ page, request }) => {
  await page.goto('${base}/shop');
  await page.getByLabel('Password').fill('${SECRET}');
  await page.getByLabel('Card number').fill('${CARD}');
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByRole('button', { name: 'Pay' }).click();
  await page.evaluate(() => {
    console.error('cart broke');
    setTimeout(() => { throw new Error('boom in page'); });
    void fetch('/api/missing');
    void fetch('/api/checkout', { method: 'POST' });
  });
  await page.waitForTimeout(7500);
  expect((await request.get('${base}/api/items')).status()).toBe(200);
  await page.waitForTimeout(1500);
});
`;

const PLAIN_SPEC = (base: string) => `const { test } = require('../fixture.cjs');
test('plain', async ({ page }) => {
  await page.goto('${base}/shop');
  await page.getByLabel('Password').fill('${SECRET}');
  await page.waitForTimeout(2500);
  await page.evaluate(() => console.error('after the view'));
  await page.waitForTimeout(800);
});
`;

const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) { this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message) }); }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

type Heard = { at: number; message: RunToHub };
type Layer = Extract<RunToHub, { type: 'lane-layer' }>;

let server: FakeServer;
let hub: net.Server;
let folder = '';
const heard: Heard[] = [];
let socket: net.Socket | null = null;
const ids: Record<string, string> = {};
let tests: Array<{ title: string; status: string; errors: string[] }> = [];
let output = '';
/** When the lane's filmstrip was asked again, and when the lane view went off. */
let askedAgainAt = Infinity;
let offAt = Infinity;
let textAnswer: unknown = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (message: HubToRun | Record<string, unknown>) => socket!.write(`${JSON.stringify(message)}\n`);
const layers = (layer?: Layer['layer'], test?: string): Array<{ at: number; message: Layer }> =>
  heard.filter(
    ({ message: m }) =>
      m.type === 'lane-layer' && (layer === undefined || m.layer === layer) && (test === undefined || m.test === test),
  ) as Array<{ at: number; message: Layer }>;

let requests = 0;
async function ask(message: Record<string, unknown> & { what: string }): Promise<unknown> {
  const request = ++requests;
  send({ type: 'request', request, ...message });
  for (let i = 0; i < 500; i++) {
    const answer = heard.find(({ message: m }) => m.type === 'answer' && m.request === request);
    if (answer) return (answer.message as { value: unknown }).value;
    await sleep(20);
  }
  throw new Error('no answer');
}

/** The editor's side: the lane view with every layer, the filmstrip asked again, then the text, then the view off. */
async function onMessage(message: RunToHub): Promise<void> {
  if (message.type === 'run-attach') {
    const on = ask({ what: 'view-lane', on: true });
    send({ type: 'layers', layers: ['calls', 'events', 'text', 'filmstrip'] });
    await on;
    return;
  }
  if (message.type !== 'test-begin') return;
  const title = message.title[message.title.length - 1]!;
  ids[title] = message.testId;
  if (title === 'checkout') {
    await sleep(9000);
    askedAgainAt = Date.now();
    send({ type: 'layers', layers: ['calls', 'events', 'text', 'filmstrip'] });
    return;
  }
  // The plain project's test: its text as asked, then the lane view off.
  await sleep(1200);
  textAnswer = await ask({ what: 'text' });
  await sleep(800);
  await ask({ what: 'view-lane', on: false });
  offAt = Date.now();
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-layers-'));
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((connection) => {
    socket = connection;
    connection.setEncoding('utf8');
    connection.on('error', () => connection.destroy());
    connection.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunToHub(line);
          if (!message) return;
          heard.push({ at: Date.now(), message });
          void onMessage(message).catch(() => undefined);
        },
        () => connection.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));
  server = await startServer((req, res) => {
    const route = new URL(req.url, 'http://x').pathname;
    if (route === '/api/missing') {
      const logs = gzipSync(JSON.stringify([{ level: 'Error', message: 'NullReferenceException in CartService' }]));
      res.writeHead(500, { 'content-type': 'application/json', 'x-piwi-logs': logs.toString('base64') });
      return res.end('{}');
    }
    if (route === '/api/checkout') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }, 6500);
      return;
    }
    if (route === '/api/items') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('[]');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(SHOP);
  });
  write('tests/shop.spec.cjs', SPEC(server.url));
  write('tests/plain.spec.cjs', PLAIN_SPEC(server.url));
  write(
    'fixture.cjs',
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  write('results-reporter.cjs', RESULTS_REPORTER);
  const trace = TRACE_ARIA ? `{ mode: 'on', snapshots: { aria: true } }` : `'on'`;
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 30000,
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  projects: [
    { name: 'traced', testMatch: 'shop.spec.cjs', use: { headless: true, trace: ${trace} } },
    { name: 'plain', testMatch: 'plain.spec.cjs', use: { headless: true, trace: 'off' }, dependencies: ['traced'] },
  ],
});
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
  };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_EDITOR_SEND', 'PIWI_RECORD_CHANNEL', 'PIWI_PAUSE_AT']) {
    delete env[name];
  }
  withoutCi(env);
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [requireHere.resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 120_000 },
      (_error, stdout, stderr) => {
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'results.json');
  tests = fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [];
}, 150_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  socket?.destroy();
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

describe('the layers of a worker’s lane view', () => {
  it('lets every test pass, and says it sends layers as it attaches', () => {
    expect(
      tests.map((t) => [t.title, t.status]),
      output,
    ).toEqual([
      ['checkout', 'passed'],
      ['plain', 'passed'],
    ]);
    const attach = heard.find(({ message: m }) => m.type === 'run-attach')?.message;
    expect(attach).toMatchObject({ features: expect.arrayContaining(['layers']) });
  });

  it('tells why a click waits, from the in-process instrumentation of a run Piwi may pause', () => {
    const logs = layers('calls', ids.checkout).map(
      ({ message }) => (message as Extract<Layer, { layer: 'calls' }>).log,
    );
    const waiting = logs.find(
      (log) => log.call.title.includes("'Pay'") && log.status === 'running' && log.target?.enabled === false,
    );
    expect(waiting, JSON.stringify(logs.map((log) => [log.call.title, log.status]))).toBeDefined();
    expect(waiting!.lines.join('\n')).toMatch(/not enabled/);
    expect(waiting!.target).toMatchObject({ count: 1, enabled: false });
    expect(waiting!.call.file).toBe('tests/shop.spec.cjs');
    // The calls after it follow.
    expect(logs.slice(logs.indexOf(waiting!)).some((log) => !log.call.title.includes("'Pay'"))).toBe(true);
  });

  it('tells the page’s errors, its failed and long-pending requests, the backend’s error and the API call', () => {
    const events = layers('events', ids.checkout).map(
      ({ message }) => (message as Extract<Layer, { layer: 'events' }>).event,
    );
    expect(events).toContainEqual({ kind: 'console', text: 'cart broke' });
    expect(events.some((e) => e.kind === 'page-error' && e.text.includes('boom in page'))).toBe(true);
    expect(events.some((e) => e.kind === 'request-failed' && e.status === 500 && e.url.endsWith('/api/missing'))).toBe(
      true,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'backend',
        method: 'GET',
        status: 500,
        level: 'error',
        text: 'NullReferenceException in CartService',
      }),
    );
    const pending = events.filter((e) => e.kind === 'request-pending' && e.url.endsWith('/api/checkout'));
    expect(pending.length).toBeGreaterThanOrEqual(2);
    expect(pending[0]).toMatchObject({ method: 'POST', done: false });
    expect((pending[0] as { ms: number }).ms).toBeGreaterThanOrEqual(5000);
    expect(pending[pending.length - 1]).toMatchObject({ done: true });
    expect(
      events.some((e) => e.kind === 'api' && e.method === 'GET' && e.status === 200 && e.url.endsWith('/api/items')),
    ).toBe(true);
  });

  it.runIf(TRACE_ARIA)('sends the page’s text as the trace writes it, its password and card number hidden', () => {
    const texts = layers('text', ids.checkout).flatMap(({ message }) => ('text' in message ? [message.text] : []));
    const traced = texts.find((text) => text.source === 'trace' && text.text.includes('textbox "Password"'));
    expect(traced, JSON.stringify(texts)).toBeDefined();
    expect(traced!.text).toContain('textbox "Password": <hidden>');
    expect(traced!.text).toContain('textbox "Card number": <hidden>');
    expect(traced!.call).toBeTruthy();
  });

  it('takes the page’s text as asked where the trace writes none, its password hidden', () => {
    expect(textAnswer).toEqual({ ok: true, message: "The page's text is on its way." });
    const texts = layers('text', ids.plain).flatMap(({ message }) => ('text' in message ? [message.text] : []));
    expect(texts.length, JSON.stringify(layers('text', ids.plain))).toBeGreaterThan(0);
    expect(texts[0]).toMatchObject({ source: 'snapshot', call: null });
    expect(texts[0]!.text).toMatch(/textbox "Password"(?: \[[^\]]*\])*: <hidden>/);
    expect(texts[0]!.text).not.toContain(SECRET);
  });

  it('sends the test’s filmstrip from its trace, one image a call, and all of it again as asked again', () => {
    const thumbs = layers('filmstrip', ids.checkout).map(({ at, message }) => ({
      at,
      ...(message as Extract<Layer, { layer: 'filmstrip' }>),
    }));
    const first = thumbs.filter(({ at }) => at < askedAgainAt);
    expect(first.length, JSON.stringify(thumbs.map((t) => t.thumb.title))).toBeGreaterThanOrEqual(3);
    expect(first.length).toBeLessThanOrEqual(MAX_FILMSTRIP);
    expect(new Set(first.map(({ thumb }) => thumb.call)).size).toBe(first.length);
    expect(first.some(({ thumb }) => thumb.title.includes("'Check'"))).toBe(true);
    expect(first.every(({ data }) => Buffer.from(data, 'base64')[0] === 0xff)).toBe(true);
    const again = thumbs.filter(({ at }) => at >= askedAgainAt).map(({ thumb }) => thumb.call);
    expect(again).toEqual(expect.arrayContaining(first.map(({ thumb }) => thumb.call)));
    expect(layers('filmstrip', ids.plain)).toEqual([]);
  });

  it('never sends a secret the test typed, and nothing once the lane view is off', () => {
    const said = JSON.stringify(layers());
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain(CARD);
    expect(offAt).toBeLessThan(Infinity);
    expect(layers().filter(({ at }) => at > offAt + 200)).toEqual([]);
  });
});
