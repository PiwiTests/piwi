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
import { readPauses } from '../src/internal/collect/pause-events.js';

/**
 * Real Playwright runs, through the built package, where two contexts stop at once. A worker shows one stop at a
 * time, so the second waits its turn, and its context closes, its page closes or its breakpoint goes while it waits;
 * a navigation stops on a page of a context with two, which closes under it; a Pause is asked as a context closes
 * under a call of its own. One run keeps a run connection to a fake editor service (`PIWI_RUN_CHANNEL`), with a
 * headless project, where only the editor answers, and a headed one, where Piwi's pause bar shows as well; the other
 * has the breakpoints alone (`PIWI_PAUSE_AT`), headed, where a script of the page answers the bar. Without a display,
 * Chromium runs the headed projects without a window (`--headless=new`).
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
/** The tests' timeout: every test ends within it. */
const TIMEOUT_MS = 4000;
/** How long the editor, or the bar's page, takes to answer the stop shown: the other one waits meanwhile. */
const LOOK_MS = 1000;
/** How long the editor, or the bar's page, leaves a stop that should end without its answer: longer than a test. */
const HOLD_MS = 5000;
/** How long a test waits after it starts a call that stops, before the next step. */
const ISSUE_MS = 300;
const REF = 'ed-0badc0de';
const TOKEN = 'run-channel-token-0123456789';
const WINDOWS = process.platform === 'linux' && !!process.env.DISPLAY;
const HEADED_USE = `{ headless: false, launchOptions: { args: ${WINDOWS ? '[]' : "['--headless=new']"} } }`;

/**
 * A page of the app: it says when Piwi's pause bar shows, and clicks the button its `bar` query names after `barms`;
 * its button calls `/clicked`.
 */
const PAGE = (title: string) => `<!doctype html><title>${title}</title><input id="i">
<button id="b" onclick="fetch('/clicked?p=${title}')">Go</button>
<script>
new MutationObserver(() => {
  const bar = document.getElementById('__piwi-pause-bar');
  if (!bar || bar.dataset.seen) return;
  bar.dataset.seen = '1';
  fetch('/bar?p=${title}', { method: 'POST', body: bar.children[0].textContent });
  const query = new URLSearchParams(location.search);
  const answer = query.get('bar');
  if (!answer) return;
  setTimeout(() => [...bar.querySelectorAll('button')].find((b) => b.textContent === answer)?.click(), Number(query.get('barms')));
}).observe(document.documentElement, { childList: true, subtree: true });
</script>`;

/** What every spec starts with: a mark the server keeps by test, and the outcome of a call, its failure caught. */
const PRELUDE = (base: string) => `const { test } = require('../fixture.cjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = (what) => {
  const info = test.info();
  return fetch('${base}/mark?' + new URLSearchParams({ test: info.project.name + ' ' + info.title, what }));
};
/** A call's outcome, its failure handled at once: closing its page or context under it fails it. */
const outcome = (call) => call.then(() => 'ok', (error) => 'failed: ' + error.message.split('\\n')[0]);
`;

/**
 * Two contexts stopping at once: the first stop shows until `answer` (the editor's, or the bar's page's, after
 * `LOOK_MS`), and the second waits its turn while its context or its page closes. `// bp` marks a breakpoint's line.
 */
const CONCURRENT = (base: string, answer: string) => `
for (const closes of ['context', 'page']) {
  test('its ' + closes + ' closes while its stop waits', async ({ page, browser }) => {
    const other = await browser.newContext();
    const second = await other.newPage();
    await page.goto('${base}/a${answer}');
    await second.goto('${base}/b');
    const first = outcome(page.locator('#b').click()); // bp
    await sleep(${ISSUE_MS});
    const waiting = outcome(second.locator('#b').click()); // bp
    await sleep(${ISSUE_MS});
    await (closes === 'context' ? other.close() : second.close());
    await mark('second ' + (await waiting));
    await mark('first ' + (await first));
    if (closes === 'page') await other.close();
  });
}
`;

/**
 * A navigation stopped on the only page of its context, then one on the second page of the context, which closes
 * under it; the bar shows in the first, answered by `quick` for the one, `hold` for the other.
 */
const NAVIGATION = (base: string, quick: string, hold: string) => `
test('a navigation on another page of its context, that page closes', async ({ page, context }) => {
  await page.goto('${base}/a${quick}');
  await page.goto('${base}/a${hold}'); // bp
  const other = await context.newPage();
  await other.goto('${base}/c');
  await page.locator('#i').fill('y');
  const navigation = outcome(other.goto('${base}/d')); // bp
  await sleep(${ISSUE_MS});
  await other.close();
  await mark('navigation ' + (await navigation));
});
`;

/** The run connection's own tests, in the headless project. */
const EDITOR_ONLY = (base: string) => `
test('a Pause, and a stop of a context as it closes', async ({ page, browser }) => {
  const other = await browser.newContext();
  const second = await other.newPage();
  await page.goto('${base}/a');
  await second.goto('${base}/b');
  await fetch('${base}/ready?for=pause');
  const closing = other.close();
  const click = outcome(second.locator('#b').click());
  await closing;
  await mark('second ' + (await click));
  await page.locator('#i').fill('p'); // pause-here
});
test('a breakpoint removed while its stop waits', async ({ page, browser }) => {
  const other = await browser.newContext();
  const second = await other.newPage();
  await page.goto('${base}/a');
  await second.goto('${base}/b');
  const first = outcome(page.locator('#b').click()); // bp
  await sleep(${ISSUE_MS});
  const waiting = outcome(second.locator('#b').click()); // bp
  await sleep(${ISSUE_MS});
  await fetch('${base}/ready?for=remove');
  await mark('first ' + (await first));
  await mark('second ' + (await waiting));
  await other.close();
});
`;

/** Each test's result, as the run's own reporter writes it, with the stops it attached. */
const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const pauses = result.attachments.find((a) => a.name === 'piwi-pauses')?.body?.toString('utf8') ?? null;
    this.tests.push({ title: test.title, project: test.parent.project().name, status: result.status, duration: result.duration, errors: result.errors.map((e) => e.message), pauses });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface DumpedTest {
  title: string;
  project: string;
  status: string;
  duration: number;
  errors: string[];
  pauses: string | null;
}

/** One Playwright run: its project folder, its app, what its pages said, and its results. */
interface Run {
  folder: string;
  server: FakeServer;
  /** Each spec's marked lines, by spec and marker: `editor bp`. */
  lines: Record<string, number[]>;
  /** What each test marked, by `<project> <title>`. */
  marks: Record<string, string[]>;
  /** Each pause bar shown, as `<page> <its place>`. */
  bars: string[];
  exitCode: number | null;
  output: string;
  tests: DumpedTest[];
}

/** A worker's run connection, as the fake editor service holds it. */
interface Connection {
  socket: net.Socket;
  heard: RunToHub[];
  /** The test it runs, as `<project> <title>`. */
  test: string | null;
}

type Stopped = Extract<RunToHub, { type: 'stopped' }>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `done`, for `ms` at most. */
async function until(done: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !done() && Date.now() < end;) await sleep(20);
}

let hub: net.Server;
let socketFolder = '';
const connections: Connection[] = [];
/** The images the editor received in the navigation test, by the stop's line. */
const images: Record<number, PausedImage | null> = {};
/** Whether the editor took the breakpoint off while the stop waited. */
let removed = false;
let editorRun: Run;
let barRun: Run;

function send(connection: Connection, message: HubToRun): void {
  connection.socket.write(`${JSON.stringify(message)}\n`);
}

/** The editor's side of each stop: it looks a while and resumes, or holds a stop that should end without it. */
async function onStopped(connection: Connection, stop: Stopped): Promise<void> {
  const test = connection.test ?? '';
  const resume = async (after: number) => {
    await sleep(after);
    send(connection, { type: 'control', action: 'resume', stop: stop.stop });
  };
  if (test === 'headless a navigation on another page of its context, that page closes') {
    send(connection, { type: 'request', request: stop.stop, what: 'image' });
    await until(() => connection.heard.some((m) => m.type === 'answer' && m.request === stop.stop));
    const answer = connection.heard.find((m) => m.type === 'answer' && m.request === stop.stop);
    images[stop.place.line] = answer?.type === 'answer' && answer.what === 'image' ? answer.value : null;
    return resume(stop.place.line === editorRun.lines['editor bp']![0] ? 0 : HOLD_MS);
  }
  if (test === 'headless a breakpoint removed while its stop waits') {
    await until(() => removed);
    return resume(ISSUE_MS);
  }
  return resume(stop.reason === 'pause' ? 0 : LOOK_MS);
}

/** Every marked line of `spec`, `// <marker>` at its end. */
function markLines(run: Run, name: string, spec: string): void {
  spec.split('\n').forEach((line, i) => {
    const marker = /\/\/ ([\w-]+)$/.exec(line)?.[1];
    if (marker) (run.lines[`${name} ${marker}`] ??= []).push(i + 1);
  });
}

/** The breakpoints of a run, as `PIWI_PAUSE_AT` lists them. */
function pauseAt(run: Run): string {
  return Object.entries(run.lines)
    .filter(([key]) => key.endsWith(' bp'))
    .flatMap(([key, lines]) => lines.map((line) => `tests/${key.split(' ')[0]}.spec.cjs:${line}`))
    .join(';');
}

/** Set up a run's project and app, with the routes its specs call. */
async function prepareRun(name: string, routes: (url: URL, run: Run) => boolean): Promise<Run> {
  const folder = path.join(pkgRoot, 'tests', `.concurrent-stops-${name}-${process.pid}`);
  const run: Run = {
    folder,
    server: undefined as unknown as FakeServer,
    lines: {},
    marks: {},
    bars: [],
    exitCode: null,
    output: '',
    tests: [],
  };
  run.server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/mark') {
      (run.marks[url.searchParams.get('test')!] ??= []).push(url.searchParams.get('what')!);
      return res.end();
    }
    if (url.pathname === '/bar') {
      run.bars.push(`${url.searchParams.get('p')} ${req.body}`);
      return res.end();
    }
    if (url.pathname === '/clicked') return res.end();
    if (routes(url, run)) {
      setTimeout(() => res.end(), ISSUE_MS);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE(url.pathname.slice(1) || 'a'));
  });
  return run;
}

function write(run: Run, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(run.folder, file)), { recursive: true });
  fs.writeFileSync(path.join(run.folder, file), text);
}

/** Write a run's specs, fixture, reporter and config with `projects`. */
function writeRun(run: Run, specs: Record<string, string>, projects: string): void {
  for (const [name, spec] of Object.entries(specs)) {
    markLines(run, name, spec);
    write(run, `tests/${name}.spec.cjs`, spec);
  }
  write(
    run,
    'fixture.cjs',
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  write(run, 'results-reporter.cjs', RESULTS_REPORTER);
  write(
    run,
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: ${TIMEOUT_MS},
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  projects: ${projects},
});
`,
  );
}

/** Run Playwright in a run's project, with `env` on top of this process's environment. */
async function execute(run: Run, env: NodeJS.ProcessEnv): Promise<void> {
  const full: NodeJS.ProcessEnv = { ...process.env, PIWI_PAUSE_AT: pauseAt(run), ...env };
  for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_RECORD_CHANNEL', 'PIWI_EDITOR_SEND'])
    delete full[name];
  if (!env.PIWI_RUN_CHANNEL) delete full.PIWI_RUN_CHANNEL;
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test'],
      { cwd: run.folder, env: full, timeout: 90_000 },
      (error, stdout, stderr) => {
        run.exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        run.output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(run.folder, 'results.json');
  run.tests = fs.existsSync(results) ? (JSON.parse(fs.readFileSync(results, 'utf8')) as DumpedTest[]) : [];
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  socketFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-concurrent-stops-'));
  const socketPath = path.join(socketFolder, 'channel.sock');
  hub = net.createServer((socket) => {
    const connection: Connection = { socket, heard: [], test: null };
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
          if (message.type === 'test-begin') {
            connection.test = `${message.project} ${message.title[message.title.length - 1]!}`;
          }
          if (message.type === 'stopped') void onStopped(connection, message);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));

  editorRun = await prepareRun('editor', (url, run) => {
    const want = url.searchParams.get('for');
    if (url.pathname !== '/ready' || !want) return false;
    const title = want === 'pause' ? 'a Pause, and a stop of a context as it closes' : 'a breakpoint removed';
    const connection = connections.find((c) => c.test?.startsWith(`headless ${title}`));
    if (!connection) return true;
    if (want === 'pause') send(connection, { type: 'control', action: 'pause' });
    else {
      // Every breakpoint of the run but the line the waiting stop is on.
      const waitingOn = run.lines['editor bp']![3]!;
      const places = pauseAt(run)
        .split(';')
        .map((entry) => ({ file: entry.slice(0, entry.lastIndexOf(':')), line: Number(entry.split(':').pop()) }))
        .filter((place) => !(place.file === 'tests/editor.spec.cjs' && place.line === waitingOn));
      send(connection, { type: 'breakpoints', places });
      setTimeout(() => (removed = true), ISSUE_MS / 2);
    }
    return true;
  });
  const base = editorRun.server.url;
  writeRun(
    editorRun,
    {
      concurrent: PRELUDE(base) + CONCURRENT(base, ''),
      editor: PRELUDE(base) + NAVIGATION(base, '', '') + EDITOR_ONLY(base),
    },
    `[
    { name: 'headless', testMatch: ['concurrent.spec.cjs', 'editor.spec.cjs'], use: { headless: true } },
    { name: 'headed', testMatch: 'concurrent.spec.cjs', use: ${HEADED_USE} },
  ]`,
  );

  barRun = await prepareRun('bar', () => false);
  const barBase = barRun.server.url;
  writeRun(
    barRun,
    {
      bar:
        PRELUDE(barBase) +
        CONCURRENT(barBase, `?bar=Resume&barms=${LOOK_MS}`) +
        NAVIGATION(barBase, `?bar=Resume&barms=${ISSUE_MS}`, `?bar=Resume&barms=${HOLD_MS}`),
    },
    `[{ name: 'headed', use: ${HEADED_USE} }]`,
  );

  // One run after the other: one browser at a time beside the rest of the suite.
  await execute(editorRun, {
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
  });
  await execute(barRun, {});
}, 200_000);

afterAll(async () => {
  for (const run of [editorRun, barRun]) {
    if (!run) continue;
    fs.rmSync(run.folder, { recursive: true, force: true });
    await run.server.close();
  }
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  for (const connection of connections) connection.socket.destroy();
  if (socketFolder) fs.rmSync(socketFolder, { recursive: true, force: true });
});

function result(run: Run, project: string, title: string): DumpedTest {
  const found = run.tests.find((t) => t.project === project && t.title === title);
  if (!found) throw new Error(`no result for "${project} ${title}":\n${run.output}`);
  return found;
}

/** What the workers said of a test, `<project> <title>`, from its begin to its end. */
function heardIn(test: string): RunToHub[] {
  for (const connection of connections) {
    const begin = connection.heard.findIndex(
      (m) => m.type === 'test-begin' && `${m.project} ${m.title[m.title.length - 1]}` === test,
    );
    if (begin < 0) continue;
    const end = connection.heard.findIndex((m, i) => i > begin && m.type === 'test-end');
    return connection.heard.slice(begin, end < 0 ? undefined : end + 1);
  }
  throw new Error(`no worker ran "${test}":\n${editorRun.output}`);
}

/** The stops the editor heard in a test, as their reason, line and whether the bar shows them. */
function stopsIn(test: string): Array<[string, number, boolean]> {
  return heardIn(test)
    .filter((m): m is Stopped => m.type === 'stopped')
    .map((s) => [s.reason, s.place.line, s.bar]);
}

/**
 * What the messages of a connection break of the editor's view: each stop ends once (`running`), one stops at a
 * time, within a test, under a number of its own, and none is open as its test ends.
 */
function brokenOrder(heard: RunToHub[]): string[] {
  const broken: string[] = [];
  const open = new Set<number>();
  const seen = new Set<number>();
  let test: string | null = null;
  for (const m of heard) {
    if (m.type === 'test-begin') test = m.title.join(' ');
    if (m.type === 'stopped') {
      if (!test) broken.push(`stop ${m.stop} outside a test`);
      if (open.size) broken.push(`stop ${m.stop} while ${[...open].join(', ')} open`);
      if (seen.has(m.stop)) broken.push(`stop ${m.stop} again`);
      seen.add(m.stop);
      open.add(m.stop);
    }
    if (m.type === 'running' && !open.delete(m.stop)) broken.push(`running ${m.stop}, not open`);
    if (m.type === 'test-end') {
      if (open.size) broken.push(`${test} ended with ${[...open].join(', ')} open`);
      test = null;
    }
  }
  if (open.size) broken.push(`the connection ended with ${[...open].join(', ')} open`);
  return broken;
}

const CLOSES = ['context', 'page'] as const;

describe('two contexts stopping at once, over the run connection', () => {
  it('passes every test within its timeout, the editor’s view of each connection in order', () => {
    expect(editorRun.exitCode, editorRun.output).toBe(0);
    expect(editorRun.tests.map((t) => `${t.project} ${t.title}: ${t.status}`).sort()).toEqual([
      'headed its context closes while its stop waits: passed',
      'headed its page closes while its stop waits: passed',
      'headless a Pause, and a stop of a context as it closes: passed',
      'headless a breakpoint removed while its stop waits: passed',
      'headless a navigation on another page of its context, that page closes: passed',
      'headless its context closes while its stop waits: passed',
      'headless its page closes while its stop waits: passed',
    ]);
    for (const t of editorRun.tests) expect(t.duration, t.title).toBeLessThan(TIMEOUT_MS);
    expect(connections).toHaveLength(2);
    for (const connection of connections) expect(brokenOrder(connection.heard)).toEqual([]);
  });

  it('lets a stop waiting its turn go on unshown when its context or its page closes, headless and headed', () => {
    const [first, second] = editorRun.lines['concurrent bp']!;
    for (const project of ['headless', 'headed']) {
      for (const closes of CLOSES) {
        const test = `${project} its ${closes} closes while its stop waits`;
        expect(stopsIn(test), test).toEqual([['breakpoint', first, project === 'headed']]);
        expect(
          heardIn(test).filter((m) => m.type === 'running'),
          test,
        ).toHaveLength(1);
        // The waiting call went on as its context or page closed, and failed with it.
        expect(editorRun.marks[test], test).toEqual([expect.stringMatching(/^second failed: .*closed/), 'first ok']);
        const pauses = readPauses(
          Buffer.from(result(editorRun, project, `its ${closes} closes while its stop waits`).pauses ?? ''),
        );
        expect(
          pauses.map((p) => p.location.split(':')[1]),
          test,
        ).toEqual([String(first)]);
        expect(pauses[0]!.duration, test).toBeGreaterThanOrEqual(LOOK_MS - 50);
      }
    }
    expect(second).toBeGreaterThan(first!);
  });

  it('ends a stop on a page its call does not name with any page of its context that closes, with no image of it', () => {
    const test = 'headless a navigation on another page of its context, that page closes';
    const [known, guessed] = editorRun.lines['editor bp']!;
    expect(stopsIn(test)).toEqual([
      ['breakpoint', known, false],
      ['breakpoint', guessed, false],
    ]);
    // The context's only page is the one a call names; of two, the editor gets no image of a guess.
    expect(Buffer.from(images[known!]!.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(images[guessed!]).toBeNull();
    const pauses = readPauses(Buffer.from(result(editorRun, 'headless', test.slice('headless '.length)).pauses ?? ''));
    expect(pauses).toHaveLength(2);
    expect(pauses[1]!.duration).toBeLessThan(HOLD_MS - 1000);
    expect(editorRun.marks[test]).toEqual([expect.stringMatching(/^navigation /)]);
  });

  it('keeps a Pause for the next stop when a stop of a closing context comes first', () => {
    const test = 'headless a Pause, and a stop of a context as it closes';
    expect(stopsIn(test)).toEqual([['pause', editorRun.lines['editor pause-here']![0], false]]);
  });

  it('lets a stop waiting its turn go on unshown when the editor takes its breakpoint off meanwhile', () => {
    const test = 'headless a breakpoint removed while its stop waits';
    const [, , first, second] = editorRun.lines['editor bp']!;
    expect(stopsIn(test)).toEqual([['breakpoint', first, false]]);
    expect(second).toBeGreaterThan(first!);
    expect(editorRun.marks[test]).toEqual(['first ok', 'second ok']);
  });
});

describe('two contexts stopping at once, with breakpoints alone', () => {
  it('passes every test within its timeout', () => {
    expect(barRun.exitCode, barRun.output).toBe(0);
    expect(barRun.tests.map((t) => [t.title, t.status])).toEqual([
      ['its context closes while its stop waits', 'passed'],
      ['its page closes while its stop waits', 'passed'],
      ['a navigation on another page of its context, that page closes', 'passed'],
    ]);
    for (const t of barRun.tests) expect(t.duration, t.title).toBeLessThan(TIMEOUT_MS);
  });

  it('lets a stop waiting its turn go on unshown when its context or its page closes, the bar shown once', () => {
    const [first] = barRun.lines['bar bp']!;
    for (const closes of CLOSES) {
      const title = `its ${closes} closes while its stop waits`;
      const pauses = readPauses(Buffer.from(result(barRun, 'headed', title).pauses ?? ''));
      expect(
        pauses.map((p) => p.location.split(':')[1]),
        title,
      ).toEqual([String(first)]);
      expect(barRun.marks[`headed ${title}`], title).toEqual([
        expect.stringMatching(/^second failed: .*closed/),
        'first ok',
      ]);
    }
    expect(barRun.bars.filter((bar) => bar.startsWith('b '))).toEqual([]);
  });

  it('takes the bar down from a guess as another page of its context closes', () => {
    const title = 'a navigation on another page of its context, that page closes';
    const [, , known, guessed] = barRun.lines['bar bp']!;
    const pauses = readPauses(Buffer.from(result(barRun, 'headed', title).pauses ?? ''));
    expect(pauses.map((p) => Number(p.location.split(':')[1]))).toEqual([known, guessed]);
    expect(pauses[1]!.duration).toBeLessThan(HOLD_MS - 1000);
  });
});
