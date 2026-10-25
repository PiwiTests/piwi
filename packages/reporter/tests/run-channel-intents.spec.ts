import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader, parseHandoffToEditor } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type RunIntent, type RunToHub } from '@piwitests/core/run-channel';
import { jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * Pick a locator and Record here started from outside the page, as Piwi Picker starts them through the editor's hub:
 * a real Playwright run through the built package, a fake editor service on the socket the run names (the run channel
 * and the record channel, as the editor names both), and a fake Send to editor endpoint. At a stop the pause bar shows,
 * the editor asks the worker to pick, then to record; the page plays the person's clicks in the picker, and the fake
 * editor refuses the recording. A headless stop refuses both. Without a display, Chromium runs the headed project
 * without a window (`--headless=new`); under `xvfb-run -a` it opens one.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-intents-${process.pid}`);
const REF = 'ed-1a2b3c4d';
const TOKEN = 'run-intents-token-0123456789';
const SEND_TOKEN = 'send-token-0123456789abcdef';
const WINDOWS = process.platform === 'linux' && !!process.env.DISPLAY;
/** How long the editor waits for the bar to show before it asks. */
const LOOK_MS = 400;

/**
 * A page of the app: it says when Piwi's pause bar shows, and plays a person's part in the element picker: the button
 * is picked, no parent is chosen, the first locator offered is confirmed.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>a</title><input><button data-testid="go">Go</button>
<script>
new MutationObserver(() => {
  const bar = document.getElementById('__piwi-pause-bar');
  if (!bar || bar.dataset.seen) return;
  bar.dataset.seen = '1';
  fetch('/bar', { method: 'POST', body: bar.children[0].textContent });
}).observe(document.documentElement, { childList: true, subtree: true });
setInterval(() => {
  if (document.getElementById('__piwi_picker_banner') && window.__piwiPickState === undefined) {
    window.__piwiPickedElement = document.querySelector('button');
    window.__piwiPickState = 'picked';
  }
  if (typeof window.__piwiAnchorCleanup === 'function' && window.__piwiAnchorState === undefined) {
    window.__piwiAnchorState = 'skipped';
  }
  const confirm = [...document.querySelectorAll('button')].some((b) => b.textContent.startsWith('Skip '));
  if (confirm && window.__piwiPickChoice === undefined) window.__piwiPickChoice = 0;
}, 100);
</script>`;

const HEADED_SPEC = (base: string) => `const { test } = require('../fixture.cjs');
test('picked from outside', async ({ page }) => {
  await page.goto('${base}/a');
  await page.locator('input').fill('one'); // bp
});
test('recorded from outside', async ({ page }) => {
  await page.goto('${base}/a');
  await page.locator('input').fill('two'); // bp
});
`;

const HEADLESS_SPEC = (base: string) => `const { test } = require('../fixture.cjs');
test('headless', async ({ page }) => {
  await page.goto('${base}/a');
  await page.locator('input').fill('three'); // bp
});
`;

/** Each test's steps, as the run's own reporter writes them. */
const STEPS_REPORTER = `const fs = require('node:fs');
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

interface DumpedStep {
  title: string;
  steps: DumpedStep[];
}

/** A worker's run connection, as the fake editor service holds it. */
interface Connection {
  socket: net.Socket;
  heard: RunToHub[];
  test: string | null;
}

type Stopped = Extract<RunToHub, { type: 'stopped' }>;
type IntentAnswered = { ok: boolean; message: string };

let server: FakeServer;
let hub: net.Server;
let folder = '';
const connections: Connection[] = [];
/** The record channel's hand-offs the editor heard, and the picks posted to its Send to editor endpoint. */
const handoffs: unknown[] = [];
const picks: unknown[] = [];
/** What the pause bar said each time it showed. */
const bars: string[] = [];
/** What the worker answered each intent, by test. */
const answered: Record<string, IntentAnswered[]> = {};
let tests: Array<{ title: string; status: string; errors: string[]; steps: DumpedStep[] }> = [];
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
/** Asks the worker to start an intent at a stop, and waits for its answer. */
async function intent(connection: Connection, what: RunIntent, stop: number): Promise<IntentAnswered> {
  const request = ++requests;
  send(connection, { type: 'request', request, what, stop });
  const answer = await waitFor(() =>
    connection.heard.find((m) => m.type === 'answer' && m.request === request && m.what === what),
  );
  return (answer as { value: IntentAnswered }).value;
}

/** The editor's side of each stop: what Piwi Picker asks through the hub. */
async function onStopped(connection: Connection, stop: Stopped): Promise<void> {
  const test = connection.test!;
  const said = (answered[test] ??= []);
  const barsBefore = bars.length;
  if (stop.bar) await waitFor(() => (bars.length > barsBefore ? true : undefined));
  await sleep(LOOK_MS);
  if (test === 'picked from outside') {
    said.push(await intent(connection, 'pick', stop.stop));
    await waitFor(() => (picks.length ? true : undefined));
    // The bar shows again once the pick is confirmed.
    await waitFor(() => (bars.length > barsBefore + 1 ? true : undefined));
    said.push(await intent(connection, 'pick', stop.stop + 1));
  } else if (test === 'recorded from outside') {
    said.push(await intent(connection, 'record', stop.stop));
    await waitFor(() => (bars.length > barsBefore + 1 ? true : undefined));
  } else {
    said.push(await intent(connection, 'pick', stop.stop));
    said.push(await intent(connection, 'record', stop.stop));
  }
  send(connection, { type: 'control', action: 'resume', stop: stop.stop });
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-intents-'));
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((socket) => {
    const connection: Connection = { socket, heard: [], test: null };
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
              // A hand-off from Record here: this editor takes no recording.
              handoffs.push(attach);
              socket.end(`${JSON.stringify({ type: 'refused', message: 'this editor records nothing.' })}\n`);
              return;
            }
            connections.push(connection);
          }
          const message = parseRunToHub(line);
          if (!message) return;
          connection.heard.push(message);
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
    if (url.pathname === '/bar') {
      bars.push(req.body);
      return res.end();
    }
    if (url.pathname === '/piwi/send') {
      picks.push({ authorization: req.headers.authorization, body: JSON.parse(req.body) });
      return jsonRes(res, 200, { inserted: true, file: null });
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });

  write('tests/headed.spec.cjs', HEADED_SPEC(server.url));
  write('tests/headless.spec.cjs', HEADLESS_SPEC(server.url));
  write(
    'fixture.cjs',
    `const { test: base } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
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
    {
      name: 'headed',
      testMatch: 'headed.spec.cjs',
      use: { headless: false, launchOptions: { args: ${WINDOWS ? '[]' : "['--headless=new']"} } },
    },
    { name: 'headless', testMatch: 'headless.spec.cjs', use: { headless: true }, dependencies: ['headed'] },
  ],
});
`,
  );
  const breakpoints = (spec: string, text: string) =>
    text
      .split('\n')
      .flatMap((line, i) => (line.endsWith('// bp') ? [`tests/${spec}:${i + 1}`] : []))
      .join(';');
  const channel = formatRecordChannel({ path: socketPath, token: TOKEN });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: channel,
    PIWI_RECORD_CHANNEL: channel,
    PIWI_EDITOR_SEND: `${server.url}/piwi/send#${SEND_TOKEN}`,
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
    PIWI_PAUSE_AT: [
      breakpoints('headed.spec.cjs', HEADED_SPEC(server.url)),
      breakpoints('headless.spec.cjs', HEADLESS_SPEC(server.url)),
    ].join(';'),
  };
  for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL']) delete env[name];
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 120_000 },
      (error, stdout, stderr) => {
        exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
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
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  for (const connection of connections) connection.socket.destroy();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

function allSteps(steps: DumpedStep[]): DumpedStep[] {
  return steps.flatMap((s) => [s, ...allSteps(s.steps)]);
}

describe('Pick and Record started from outside the page', () => {
  it('lets every test pass, and says which intents the worker takes as it attaches', () => {
    expect(exitCode, output).toBe(0);
    expect(tests.map((t) => [t.title, t.status])).toEqual([
      ['picked from outside', 'passed'],
      ['recorded from outside', 'passed'],
      ['headless', 'passed'],
    ]);
    expect(connections[0]!.heard[0]).toMatchObject({ type: 'run-attach', ref: REF, takes: ['pick', 'record'] });
  });

  it('picks in the test’s window as the bar’s Pick a locator does, the locator going to the editor', () => {
    expect(answered['picked from outside']).toEqual([
      { ok: true, message: "Pick an element in the test's window: the locator goes to the editor." },
      // An intent naming a stop the worker does not stand at.
      { ok: false, message: 'The test went on.' },
    ]);
    expect(picks).toEqual([
      {
        authorization: `Bearer ${SEND_TOKEN}`,
        body: { kind: 'locator', text: "getByTestId('go')", at: { file: 'tests/headed.spec.cjs', line: 4 } },
      },
    ]);
    expect(output).toContain("[piwi] Locator picked at tests/headed.spec.cjs:4: getByTestId('go')");
  });

  it('hands the page to the editor’s recorder as the bar’s Record here does, and shows the bar again after', () => {
    expect(answered['recorded from outside']).toEqual([
      { ok: true, message: "Recording in the test's window: the editor writes the steps above the stopped line." },
    ]);
    expect(handoffs).toEqual([
      expect.objectContaining({
        type: 'attach',
        token: TOKEN,
        file: path.join(fs.realpathSync(project), 'tests', 'headed.spec.cjs'),
        line: 8,
        reason: 'breakpoint',
      }),
    ]);
    expect(output).toContain('[piwi] Nothing was recorded: this editor records nothing.');
  });

  it('refuses both at a stop no pause bar shows', () => {
    const refusal = (name: string) =>
      `${name} needs the pause bar in the test's window, and this stop shows none: run the test headed.`;
    expect(answered.headless).toEqual([
      { ok: false, message: refusal('Pick a locator') },
      { ok: false, message: refusal('Record here') },
    ]);
  });

  it('shows none of its own calls among the test’s steps', () => {
    for (const result of tests) {
      const titles = allSteps(result.steps).map((s) => s.title);
      expect(titles, result.title).not.toContainEqual(
        expect.stringMatching(/Bring to front|Pause on next|Evaluate|Wait for function|Screenshot|Piwi capture/i),
      );
    }
  });
});
