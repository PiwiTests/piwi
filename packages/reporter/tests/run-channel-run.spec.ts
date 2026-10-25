import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type PausedImage, type RunToHub } from '@piwitests/core/run-channel';
import { startServer, type FakeServer } from './_helpers.js';
import { readPauses, withoutPausedTime } from '../src/internal/collect/paused-steps.js';

/**
 * A real Playwright run steered over the run channel, through the built package: a fake editor service listens on
 * the socket the run's environment names (`PIWI_RUN_CHANNEL`), hears each worker's tests and stops, and answers them
 * as a person would from the editor: Pause, Step, Run to a line, Resume, Finish, new breakpoints, an image of the
 * stopped page, and its connection closed under a stop. One project is headed, where Piwi's pause bar shows and races
 * the editor (without a display, Chromium runs it without a window, `--headless=new`); the other is headless, where
 * only the editor can answer.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
// Inside the package, so the suite resolves the same @playwright/test as the built reporter.
const project = path.join(pkgRoot, 'tests', `.run-channel-${process.pid}`);
/** The tests' timeout, and how long the editor holds the headless stop: longer than it. */
const TIMEOUT_MS = 3000;
const HOLD_MS = 4000;
/** How long the editor takes to answer a stop the bar shows: the bar is up by then. */
const LOOK_MS = 400;
const REF = 'ed-0badc0de';
const TOKEN = 'run-channel-token-0123456789';
const WINDOWS = process.platform === 'linux' && !!process.env.DISPLAY;

/** A page of the app: it says when Piwi's pause bar shows, and clicks the button its `bar` query names. */
const PAGE = (title: string) => `<!doctype html><title>${title}</title><input><button>Go</button>
<script>
new MutationObserver(() => {
  const bar = document.getElementById('__piwi-pause-bar');
  if (!bar || bar.dataset.seen) return;
  bar.dataset.seen = '1';
  fetch('/bar', { method: 'POST', body: bar.children[0].textContent });
  const answer = new URLSearchParams(location.search).get('bar');
  if (answer) setTimeout(() => [...bar.querySelectorAll('button')].find((b) => b.textContent === answer).click(), 200);
}).observe(document.documentElement, { childList: true, subtree: true });
</script>`;

/**
 * The specs the run executes, the headed project's and the headless one's. `// bp` marks a line of `PIWI_PAUSE_AT`,
 * `// new-bp` the line the editor sets as the run's only breakpoint during the run, and the other markers where the
 * editor's controls stop the test.
 */
const HEADED_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('steered', async ({ page }) => {
  await page.goto('${base}/a');
  await fetch('${base}/ready?for=pause');
  await page.locator('input').fill('one'); // pause-here
  await page.getByRole('button').click(); // step-here
  await page.keyboard.press('Tab');
  await expect(page.locator('input')).toHaveValue('one');
  await page.locator('input').fill('two'); // run-to
  await expect(page.locator('#__piwi-pause-bar')).toHaveCount(0);
});
test('bar first', async ({ page }) => {
  await page.goto('${base}/a?bar=Resume');
  await page.locator('input').fill('x'); // bp
});
test('finish', async ({ page }) => {
  await page.goto('${base}/a');
  await page.locator('input').fill('a'); // bp
  await page.locator('input').fill('b'); // bp
});
test('next first call', async ({ page }) => {
  await page.goto('${base}/b'); // first-call
});
test('moved breakpoints', async ({ page }) => {
  await page.goto('${base}/a');
  await fetch('${base}/ready?for=breakpoints');
  await page.locator('input').fill('c'); // bp
  await page.getByRole('button').click(); // new-bp
});
`;

const HEADLESS_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('headless', async ({ page }) => {
  await page.goto('${base}/b');
  await page.locator('input').fill('h'); // bp
  await expect(page.locator('input')).toHaveValue('h');
});
test('connection closes', async ({ page }) => {
  await page.goto('${base}/b');
  await page.locator('input').fill('z'); // bp
  await page.getByRole('button').click();
});
test('a process it starts', async () => {
  const { execFileSync } = require('node:child_process');
  const seen = execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.PIWI_RUN_CHANNEL ?? "none")']);
  expect(seen.toString()).toBe('none');
});
`;

/** Each test's result, as the run's own reporter writes it: its steps with their places and times, and the output. */
const STEPS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const step = (s) => ({ title: s.title, category: s.category, startTime: s.startTime.getTime(), duration: s.duration, steps: s.steps.map(step) });
    const found = result.attachments.find((a) => a.name === 'piwi-pauses');
    const pauses = found?.body?.toString('utf8') ?? null;
    this.tests.push({ title: test.title, project: test.parent.project().name, status: result.status, duration: result.duration, errors: result.errors.map((e) => e.message), steps: result.steps.map(step), pauses });
  }
  onStdOut(chunk) { process.stdout.write(chunk); }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface DumpedStep {
  title: string;
  category: string;
  startTime: number;
  duration: number;
  steps: DumpedStep[];
}

interface DumpedTest {
  title: string;
  project: string;
  status: string;
  duration: number;
  errors: string[];
  steps: DumpedStep[];
  pauses: string | null;
}

/** A worker's run connection, as the fake editor service holds it. */
interface Connection {
  socket: net.Socket;
  heard: RunToHub[];
  /** The test it runs, by title. */
  test: string | null;
  /** What the editor sent it. */
  sent: HubToRun[];
}

type Stopped = Extract<RunToHub, { type: 'stopped' }>;

let server: FakeServer;
let hub: net.Server;
let folder = '';
const connections: Connection[] = [];
/** The images the editor received, by the test they were asked in. */
const images: Record<string, PausedImage | null> = {};
/** What the pause bar said each time it showed, in order. */
const bars: string[] = [];
let tests: DumpedTest[] = [];
/** The lines of each marker, by spec and marker: `headed bp`. */
const lines: Record<string, number[]> = {};
/** The `nth` line of a spec's marker. */
const mark = (spec: 'headed' | 'headless', marker: string, nth = 0): number => lines[`${spec} ${marker}`]![nth]!;
let exitCode: number | null = null;
let output = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function send(connection: Connection, message: HubToRun): void {
  connection.sent.push(message);
  connection.socket.write(`${JSON.stringify(message)}\n`);
}

/** The editor's side of each test, at each stop. */
async function onStopped(connection: Connection, stop: Stopped): Promise<void> {
  const test = connection.test;
  let request = 0;
  const image = async () => {
    const asked = ++request;
    send(connection, { type: 'request', request: asked, what: 'image' });
    for (;;) {
      const answer = connection.heard.find((m) => m.type === 'answer' && m.request === asked);
      if (answer?.type === 'answer' && answer.what === 'image') return answer.value;
      await sleep(20);
    }
  };
  if (test === 'steered') {
    await sleep(LOOK_MS);
    if (stop.reason === 'pause') return send(connection, { type: 'control', action: 'step', stop: stop.stop });
    if (stop.reason === 'step') {
      const place = { file: 'tests/headed.spec.cjs', line: mark('headed', 'run-to') };
      return send(connection, { type: 'run-to', stop: stop.stop, place });
    }
    images.steered = await image();
    return send(connection, { type: 'control', action: 'resume', stop: stop.stop });
  }
  if (test === 'finish') return send(connection, { type: 'control', action: 'finish', stop: stop.stop });
  if (test === 'next first call' || test === 'moved breakpoints') {
    return send(connection, { type: 'control', action: 'resume', stop: stop.stop });
  }
  if (test === 'headless') {
    const started = Date.now();
    images.headless = await image();
    await sleep(HOLD_MS - (Date.now() - started));
    return send(connection, { type: 'control', action: 'resume', stop: stop.stop });
  }
  if (test === 'connection closes') connection.socket.destroy();
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-channel-'));
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((socket) => {
    const connection: Connection = { socket, heard: [], test: null, sent: [] };
    connections.push(connection);
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunToHub(line);
          if (!message) return;
          connection.heard.push(message);
          if (message.type === 'test-begin') connection.test = message.title[message.title.length - 1]!;
          if (message.type === 'stopped') void onStopped(connection, message);
          // A pause asked between tests: the next test stops at its first call.
          if (message.type === 'test-end' && connection.test === 'finish') {
            send(connection, { type: 'control', action: 'pause' });
          }
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
    if (url.pathname === '/ready') {
      const connection = connections.find(
        (c) => c.test === (url.searchParams.get('for') === 'pause' ? 'steered' : 'moved breakpoints'),
      );
      if (connection && url.searchParams.get('for') === 'pause') send(connection, { type: 'control', action: 'pause' });
      if (connection && url.searchParams.get('for') === 'breakpoints') {
        send(connection, {
          type: 'breakpoints',
          places: [{ file: 'tests/headed.spec.cjs', line: mark('headed', 'new-bp') }],
        });
      }
      setTimeout(() => res.end(), 300);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE(url.pathname === '/b' ? 'b' : 'a'));
  });

  const specs = { headed: HEADED_SPEC(server.url), headless: HEADLESS_SPEC(server.url) };
  for (const [name, spec] of Object.entries(specs)) {
    spec.split('\n').forEach((line, i) => {
      const marker = /\/\/ ([\w-]+)$/.exec(line)?.[1];
      if (marker) (lines[`${name} ${marker}`] ??= []).push(i + 1);
    });
    write(`tests/${name}.spec.cjs`, spec);
  }
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
  timeout: ${TIMEOUT_MS},
  workers: 1,
  reporter: [['./steps-reporter.cjs', { outputFile: 'results.json' }]],
  projects: [
    {
      name: 'headed',
      testMatch: 'headed.spec.cjs',
      use: { headless: false, launchOptions: { args: ${WINDOWS ? '[]' : "['--headless=new']"} } },
    },
    // After the headed project: the environment its worker leaves is the one Playwright hands this one.
    { name: 'headless', testMatch: 'headless.spec.cjs', use: { headless: true }, dependencies: ['headed'] },
  ],
});
`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
    PIWI_PAUSE_AT: ['headed', 'headless']
      .flatMap((name) => (lines[`${name} bp`] ?? []).map((line) => `tests/${name}.spec.cjs:${line}`))
      .join(';'),
  };
  for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_RECORD_CHANNEL', 'PIWI_EDITOR_SEND'])
    delete env[name];
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
  tests = fs.existsSync(results) ? (JSON.parse(fs.readFileSync(results, 'utf8')) as DumpedTest[]) : [];
}, 150_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  for (const connection of connections) connection.socket.destroy();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

/** Every step of a test, depth first. */
function allSteps(steps: DumpedStep[]): DumpedStep[] {
  return steps.flatMap((s) => [s, ...allSteps(s.steps)]);
}

function test(title: string): DumpedTest {
  const found = tests.find((t) => t.title === title);
  if (!found) throw new Error(`no result for "${title}":\n${output}`);
  return found;
}

/** What the workers said of a test, from its begin to its end. */
function heardIn(title: string): RunToHub[] {
  for (const connection of connections) {
    const begin = connection.heard.findIndex((m) => m.type === 'test-begin' && m.title[m.title.length - 1] === title);
    if (begin < 0) continue;
    const end = connection.heard.findIndex((m, i) => i > begin && m.type === 'test-end');
    return connection.heard.slice(begin, end < 0 ? undefined : end + 1);
  }
  throw new Error(`no worker ran "${title}":\n${output}`);
}

function stopsIn(title: string): Stopped[] {
  return heardIn(title).filter((m): m is Stopped => m.type === 'stopped');
}

/** A stop as the editor heard it: why, and its line. */
const where = (stop: Stopped) => [stop.reason, stop.place.line, stop.bar];

describe('a run steered over the run channel', () => {
  it('passes every test, a stop longer than the test timeout and a connection closed under a stop included', () => {
    expect(exitCode, output).toBe(0);
    expect(tests.map((t) => [t.title, t.project, t.status])).toEqual([
      ['steered', 'headed', 'passed'],
      ['bar first', 'headed', 'passed'],
      ['finish', 'headed', 'passed'],
      ['next first call', 'headed', 'passed'],
      ['moved breakpoints', 'headed', 'passed'],
      ['headless', 'headless', 'passed'],
      ['connection closes', 'headless', 'passed'],
      ['a process it starts', 'headless', 'passed'],
    ]);
  });

  it('opens one run connection per worker, a project after another’s included, and none for a process a test starts', () => {
    expect(connections).toHaveLength(2);
    expect(connections.map((c) => c.heard[0])).toEqual([
      expect.objectContaining({
        type: 'run-attach',
        token: TOKEN,
        ref: REF,
        cwd: fs.realpathSync(project),
        workerIndex: 0,
        parallelIndex: 0,
        playwright: expect.stringMatching(/^1\.\d+\.\d+/),
        reporter: expect.stringMatching(/^\d+\.\d+\.\d+/),
      }),
      expect.objectContaining({ type: 'run-attach', workerIndex: 1 }),
    ]);
    expect(heardIn('steered')[0]).toEqual({
      type: 'test-begin',
      testId: expect.any(String),
      title: ['steered'],
      file: 'tests/headed.spec.cjs',
      line: 2,
      project: 'headed',
      retry: 0,
      cannotPause: null,
    });
    // A headless test stops too while the run connection is open.
    expect(heardIn('headless')[0]).toMatchObject({ project: 'headless', cannotPause: null });
  });

  it('stops at the next call after a Pause, at the next one after Step, and on the line it was run to', () => {
    const stops = stopsIn('steered');
    expect(stops.map(where)).toEqual([
      ['pause', mark('headed', 'pause-here'), true],
      ['step', mark('headed', 'step-here'), true],
      ['run-to', mark('headed', 'run-to'), true],
    ]);
    expect(stops[0]).toMatchObject({ title: `Fill "one" locator('input')`, locator: "locator('input')" });
    expect(stops[1]).toMatchObject({ title: `Click getByRole('button')` });
    // Every stop ends with the editor's answer, and the bar it showed came down (the test checks it).
    const ended = heardIn('steered').filter((m) => m.type === 'running');
    expect(ended).toEqual(stops.map((s) => ({ type: 'running', stop: s.stop })));
    expect(bars.filter((b) => b.includes(`headed.spec.cjs:${mark('headed', 'pause-here')}`))).toHaveLength(1);
    expect(images.steered?.data).toMatch(/^\/9j\//);
  });

  it('lets the bar answer a stop the editor leaves, and tells the editor it ended', () => {
    const stops = stopsIn('bar first');
    expect(stops.map(where)).toEqual([['breakpoint', mark('headed', 'bp'), true]]);
    const connection = connections[0]!;
    expect(connection.sent.filter((m) => 'stop' in m && m.stop === stops[0]!.stop)).toEqual([]);
    expect(heardIn('bar first')).toContainEqual({ type: 'running', stop: stops[0]!.stop });
  });

  it('stops at no breakpoint more after Finish, and at the next test’s first call after a Pause between tests', () => {
    expect(stopsIn('finish').map(where)).toEqual([['breakpoint', mark('headed', 'bp', 1), true]]);
    expect(stopsIn('next first call').map(where)).toEqual([['pause', mark('headed', 'first-call'), true]]);
  });

  it('stops at the breakpoints the editor sends during the run, in place of PIWI_PAUSE_AT', () => {
    expect(stopsIn('moved breakpoints').map(where)).toEqual([['breakpoint', mark('headed', 'new-bp'), true]]);
  });

  it('holds a headless stop for the editor, longer than the test timeout, and sends it an image of the page', () => {
    const stops = stopsIn('headless');
    expect(stops.map(where)).toEqual([['breakpoint', mark('headless', 'bp'), false]]);
    expect(Buffer.from(images.headless!.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const heard = heardIn('headless');
    const end = heard[heard.length - 1];
    expect(end).toMatchObject({ type: 'test-end', status: 'passed' });
    expect((end as { pausedMs: number }).pausedMs).toBeGreaterThanOrEqual(HOLD_MS - 50);
    const result = test('headless');
    expect(result.duration).toBeLessThan(TIMEOUT_MS);
    const pauses = readPauses(Buffer.from(result.pauses ?? ''));
    expect(pauses).toEqual([expect.objectContaining({ reason: 'breakpoint', title: `Fill "h" locator('input')` })]);
    const held = (steps: DumpedStep[]) => allSteps(steps).filter((s) => s.duration >= HOLD_MS - 50);
    expect(held(result.steps).length).toBeGreaterThan(0);
    expect(held(withoutPausedTime(result.steps, pauses))).toEqual([]);
  });

  it('goes on when its connection closes under a stop no bar shows', () => {
    expect(stopsIn('connection closes').map(where)).toEqual([['breakpoint', mark('headless', 'bp', 1), false]]);
    expect(output).toContain('[piwi] The connection to the editor closed: the test goes on.');
  });

  it('lists the stops the editor answered in piwi-pauses, with their reasons', () => {
    const pauses = readPauses(Buffer.from(test('steered').pauses ?? ''));
    expect(pauses.map((p) => p.reason)).toEqual(['pause', 'step', 'run-to']);
    expect(pauses.every((p) => p.duration >= LOOK_MS - 50)).toBe(true);
  });

  it('shows none of its own calls among the test’s steps', () => {
    for (const result of tests) {
      const titles = allSteps(result.steps).map((s) => s.title);
      expect(titles, result.title).not.toContainEqual(
        expect.stringMatching(
          /Pause on next|Step to next|Run to|^Resume|Evaluate|Wait for function|highlight|Screenshot|Piwi capture/i,
        ),
      );
    }
    const body = test('steered').steps.filter((s) => s.category === 'pw:api' || s.category === 'expect');
    expect(body.map((s) => s.title)).toEqual([
      expect.stringMatching(/^Navigate/),
      'Fill "one"',
      'Click',
      'Press "Tab"',
      'Expect "toHaveValue"',
      'Fill "two"',
      'Expect "toHaveCount"',
    ]);
  });
});
