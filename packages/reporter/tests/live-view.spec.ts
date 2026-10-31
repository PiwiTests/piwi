import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIVE_FRAME_BYTE_RATE,
  LIVE_FRAME_FPS,
  LIVE_FRAME_HEIGHT,
  LIVE_FRAME_WIDTH,
  MAX_LIVE_FRAME,
  readWorkerToInstance,
  type WorkerToInstance,
} from '@piwitests/core/live-view';
import { detectCi } from '../src/internal/support/ci.js';
import { jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * The run page's live view, in real Playwright runs through the built package against a fake instance. The global
 * setup of a CI run asks for a key; the instance gives one for a project with the live view on, and the reporter names
 * it in the workers' environment, which no process the worker's hooks, fixtures or tests start gets. Each worker then
 * keeps an event stream open to the instance and sends nothing more until the instance says someone watches: then
 * frames of the running test's page, each with its call and its test, a few a second at most, which stop as nobody
 * watches or the test ends. A suite that records video keeps its video, and sends fewer, heavier frames; a test that
 * starts its own screencast while watched gets it, and the view goes on with images. With the live view off, the
 * instance gives no key and no worker sends anything; a run outside CI holds its key and sends nothing, as nobody
 * shares it (`live-view-share.spec.ts` shares one).
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
/** The projects the runs use, inside the package so they resolve `@playwright/test`. */
const projects = path.join(pkgRoot, 'tests', `.live-view-${process.pid}`);
const RUN = 41;
const KEY = `pdl_${'k'.repeat(43)}`;
const requireHere = createRequire(import.meta.url);
const OWN = 'records its own screencast while watched';

/** A page of the app: an animated one paints all the time, a still one once. */
const PAGE = (animated: boolean) => `<!doctype html><meta charset="utf-8"><title>shop</title>
<style>body { margin: 0; padding: 20px; font: 16px sans-serif }
#spin { width: 120px; height: 120px; background: linear-gradient(red, blue); animation: s 1s linear infinite } @keyframes s { to { transform: rotate(360deg) } }</style>
<h1>Shop</h1><p>A slow page.</p>${animated ? '<div id="spin"></div>' : ''}`;

/** A busy page: a canvas of shapes redrawn at every frame, which no JPEG makes small. */
const BUSY = `<!doctype html><meta charset="utf-8"><style>body { margin: 0 }</style><canvas id="c" width="1280" height="720"></canvas>
<script>
const context = document.getElementById('c').getContext('2d');
const draw = () => {
  for (let i = 0; i < 400; i++) {
    context.fillStyle = 'hsl(' + Math.random() * 360 + ', 70%, 50%)';
    context.beginPath();
    context.arc(Math.random() * 1280, Math.random() * 720, 4 + Math.random() * 30, 0, 7);
    context.fill();
  }
  requestAnimationFrame(draw);
};
draw();
</script>`;

/**
 * Each test tells the instance when its page shows, then waits until the instance watched it as it planned. The
 * hooks and a worker fixture say whether a process they start gets the live view's key.
 */
const SPEC = (base: string) => `const { test, expect, sawKey } = require('../fixture.cjs');
const ready = (name) => fetch('${base}/ready?test=' + encodeURIComponent(name));
const done = (name) => expect.poll(async () => (await (await fetch('${base}/done?test=' + encodeURIComponent(name))).json()).done, { timeout: 15000 }).toBe(true);
const mark = (name) => fetch('${base}/mark?name=' + name);
test.beforeAll(() => sawKey('beforeAll'));
test.afterAll(() => sawKey('afterAll'));
test('watched while it runs', async ({ page }) => {
  // The key is the workers' alone: a process the test starts does not get it.
  if (process.env.PIWI_LIVE_VIEW !== undefined) throw new Error('the live view key is in the test environment');
  await sawKey('test');
  await page.goto('${base}/animated');
  await ready('watched while it runs');
  await done('watched while it runs');
  await expect(page.locator('h1')).toHaveText('Shop');
});
test('watched on a busy page', async ({ page }) => {
  await page.goto('${base}/busy');
  await ready('watched on a busy page');
  await done('watched on a busy page');
});
test('ended while watched', async ({ page }) => {
  await page.goto('${base}/still');
  await ready('ended while watched');
  await done('ended while watched');
});
test('${OWN}', async ({ page }) => {
  await page.goto('${base}/animated');
  await ready('${OWN}');
  await expect.poll(async () => (await (await fetch('${base}/framed?test=${encodeURIComponent(OWN)}')).json()).framed, { timeout: 15000 }).toBe(true);
  let own = 0;
  await mark('own-start');
  await page.screencast.start({ path: test.info().outputPath('own.webm'), onFrame: () => { own += 1; } });
  await page.waitForTimeout(2500);
  await page.screencast.stop();
  await mark('own-stop');
  expect(own).toBeGreaterThan(0);
  expect(require('node:fs').statSync(test.info().outputPath('own.webm')).size).toBeGreaterThan(1000);
  await done('${OWN}');
});
`;

const VIDEO_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('recorded on video while watched', async ({ page }) => {
  await page.goto('${base}/animated');
  await fetch('${base}/ready?test=' + encodeURIComponent('recorded on video while watched'));
  await expect.poll(async () => (await (await fetch('${base}/done?test=recorded%20on%20video%20while%20watched')).json()).done, { timeout: 15000 }).toBe(true);
});
test('a busy page recorded on video while watched', async ({ page }) => {
  await page.goto('${base}/busy');
  await fetch('${base}/ready?test=' + encodeURIComponent('a busy page recorded on video while watched'));
  await expect.poll(async () => (await (await fetch('${base}/done?test=a%20busy%20page%20recorded%20on%20video%20while%20watched')).json()).done, { timeout: 15000 }).toBe(true);
});
`;

/** Each test's result, attachments and steps, as the run's own reporter writes them. */
const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const step = (s) => ({ title: s.title, steps: s.steps.map(step) });
    this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message), attachments: result.attachments.map((a) => ({ name: a.name, path: a.path })), steps: result.steps.map(step) });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface Posted {
  at: number;
  message: WorkerToInstance;
}

/** What one run sent the fake instance. */
interface Heard {
  setups: Array<Record<string, unknown>>;
  streams: Array<{ url: string; authorization?: string; res: http.ServerResponse }>;
  posts: Posted[];
  /** Any request to the live view endpoint, whatever it carried. */
  liveRequests: number;
  /** When the instance said someone watches, and stopped saying it, per test. */
  watching: Record<string, { from: number; to: number | null }>;
  done: Set<string>;
  /** When each test said it reached a point of its own. */
  marks: Record<string, number>;
  /** Where a process the worker started looked for the key, and whether it had it. */
  sawKey: Array<{ where: string; had: boolean }>;
}

const fresh = (): Heard => ({
  setups: [],
  streams: [],
  posts: [],
  liveRequests: 0,
  watching: {},
  done: new Set(),
  marks: {},
  sawKey: [],
});

/** A CI run of a project with the live view on or off, and a run outside CI of a project with it on. */
type Mode = 'on' | 'off' | 'local';

let server: FakeServer;
let mode: Mode = 'on';
let heard = fresh();
const runs: Record<Mode, { heard: Heard; exitCode: number | null; output: string; tests: DumpedTest[] }> = {
  on: { heard: fresh(), exitCode: null, output: '', tests: [] },
  off: { heard: fresh(), exitCode: null, output: '', tests: [] },
  local: { heard: fresh(), exitCode: null, output: '', tests: [] },
};

interface DumpedStep {
  title: string;
  steps: DumpedStep[];
}
interface DumpedTest {
  title: string;
  status: string;
  errors: string[];
  attachments: Array<{ name: string; path?: string }>;
  steps: DumpedStep[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined | false, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(20);
  }
}

/** Say on every worker's stream how many people watch. */
function sayViewers(count: number): void {
  for (const stream of heard.streams) {
    if (!stream.res.writableEnded) stream.res.write(`data: ${JSON.stringify({ type: 'viewers', count })}\n\n`);
  }
}

const frames = (from = 0, to = Infinity) =>
  heard.posts.filter(
    (p): p is { at: number; message: Extract<WorkerToInstance, { type: 'frame'; data: string }> } =>
      p.message.type === 'frame' && 'data' in p.message && p.at >= from && p.at < to,
  );

/** What the instance does once a test's page shows: someone watches it a while, as each test plans. */
async function onReady(test: string): Promise<void> {
  // With the live view off, or in a run that asked for no key, nobody can watch.
  if (mode !== 'on') return void heard.done.add(test);
  const watch = (heard.watching[test] = { from: Date.now(), to: null as number | null });
  try {
    if (
      test === 'watched while it runs' ||
      test === 'watched on a busy page' ||
      test === 'recorded on video while watched' ||
      test === 'a busy page recorded on video while watched'
    ) {
      sayViewers(1);
      await sleep(2500);
      watch.to = Date.now();
      sayViewers(0);
      // Nobody watches: no frame comes any more.
      await sleep(1000);
    } else if (test === 'ended while watched') {
      sayViewers(1);
      await waitFor(() => frames(watch.from).length > 0);
      // The test ends while watched: the worker says so.
    } else if (test === OWN) {
      sayViewers(1);
      await waitFor(() => heard.marks['own-stop'], 30_000);
      watch.to = Date.now();
      sayViewers(0);
    }
  } finally {
    heard.done.add(test);
  }
}

function write(project: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** A JPEG's size in pixels, from its first frame header; null for none. */
function jpegSize(data: Buffer): { width: number; height: number } | null {
  for (let i = 2; i + 9 < data.length;) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1]!;
    const length = data.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return null;
}

/** Run the suite once, as `which` says. */
async function runSuite(which: Mode): Promise<void> {
  mode = which;
  heard = fresh();
  const project = path.join(projects, which);
  write(project, 'tests/live.spec.cjs', SPEC(server.url));
  write(project, 'tests/video.spec.cjs', VIDEO_SPEC(server.url));
  write(
    project,
    'fixture.cjs',
    `const { execFileSync } = require('node:child_process');
const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
/** Whether a process started now gets the live view's key, said to the instance. */
const sawKey = (where) => {
  const had = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.PIWI_LIVE_VIEW !== undefined))']).toString();
  return fetch(${JSON.stringify(server.url)} + '/saw-key?where=' + where + '&had=' + had);
};
exports.test = extendPiwiFixtures(base).extend({
  workerSawKey: [async ({}, use) => { await sawKey('worker-fixture'); await use(); await sawKey('worker-teardown'); }, { scope: 'worker', auto: true }],
});
exports.expect = expect;
exports.sawKey = sawKey;
`,
  );
  write(project, 'results-reporter.cjs', RESULTS_REPORTER);
  write(
    project,
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
const { wrapConfig } = require(${JSON.stringify(dist)});
module.exports = wrapConfig(defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 30000,
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  use: { headless: true, viewport: { width: 1280, height: 720 } },
  projects: [
    // No trace: the view is the page's one screencast client, at its own size.
    { name: 'live', testMatch: 'live.spec.cjs', use: { trace: 'off' } },
    { name: 'video', testMatch: 'video.spec.cjs', use: { video: 'on' }, dependencies: ['live'] },
  ],
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'live-view-spec', streamingBatchDelay: 50 });
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PROJECT_NAME', 'PIWI_LIVE_VIEW']) {
    delete env[name];
  }
  // A CI run, or none: no variable a CI provider sets is left.
  for (const name of Object.keys(env)) if (detectCi({ [name]: env[name] })) delete env[name];
  if (which !== 'local') env.CI = 'true';
  const run = runs[which];
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [requireHere.resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 120_000 },
      (error, stdout, stderr) => {
        run.exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        run.output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'results.json');
  run.tests = fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [];
  run.heard = heard;
  for (const stream of heard.streams) stream.res.end();
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    if (route === '/ready') {
      void onReady(url.searchParams.get('test') ?? '');
      return res.end();
    }
    if (route === '/done') return jsonRes(res, 200, { done: heard.done.has(url.searchParams.get('test') ?? '') });
    if (route === '/framed') {
      const watch = heard.watching[url.searchParams.get('test') ?? ''];
      return jsonRes(res, 200, { framed: mode !== 'on' || (!!watch && frames(watch.from).length > 0) });
    }
    if (route === '/mark') {
      heard.marks[url.searchParams.get('name') ?? ''] = Date.now();
      return res.end();
    }
    if (route === '/saw-key') {
      heard.sawKey.push({ where: url.searchParams.get('where') ?? '', had: url.searchParams.get('had') === 'true' });
      return res.end();
    }
    if (route === '/busy') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(BUSY);
    }
    if (route === '/animated' || route === '/still') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE(route === '/animated'));
    }
    if (route === '/api/test-runs/setup') {
      heard.setups.push(JSON.parse(req.body) as Record<string, unknown>);
      return jsonRes(res, 200, {
        success: true,
        runId: RUN,
        projectId: 1,
        setupToken: 'setup-token',
        // The project's setting: a key for a reporter that asks.
        ...(mode !== 'off' && heard.setups[heard.setups.length - 1]?.liveView === true
          ? { liveView: { key: KEY } }
          : {}),
      });
    }
    if (route === `/api/test-runs/${RUN}/begin`) {
      return jsonRes(res, 200, { success: true, runId: RUN, streamToken: 'stream-token' });
    }
    if (route === `/api/test-runs/${RUN}/live-view`) {
      heard.liveRequests++;
      if (req.headers.authorization !== `Bearer ${KEY}`) return jsonRes(res, 401, { message: 'no key' });
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'viewers', count: 0 })}\n\n`);
        heard.streams.push({ url: req.url, authorization: req.headers.authorization, res });
        return;
      }
      const message = readWorkerToInstance(JSON.parse(req.body));
      if (typeof message === 'string') return jsonRes(res, 400, { message });
      heard.posts.push({ at: Date.now(), message });
      return jsonRes(res, 200, { success: true });
    }
    if (route.startsWith('/api/')) return jsonRes(res, 200, { success: true, watched: true });
    res.writeHead(404);
    res.end();
  });

  await runSuite('on');
  await runSuite('off');
  await runSuite('local');
}, 400_000);

afterAll(async () => {
  await server?.close();
  fs.rmSync(projects, { recursive: true, force: true });
});

/** Every step title of a test, nested ones included. */
const stepTitles = (steps: DumpedStep[]): string[] => steps.flatMap((s) => [s.title, ...stepTitles(s.steps)]);

const TITLES = [
  'watched while it runs',
  'watched on a busy page',
  'ended while watched',
  OWN,
  'recorded on video while watched',
  'a busy page recorded on video while watched',
];

describe('the live view of a run on the instance', () => {
  it('lets every test of a CI run pass, the run asking for a key and each worker holding one stream with it', () => {
    const { on } = runs;
    expect(on.exitCode, on.output).toBe(0);
    expect(on.tests.map((t) => [t.title, t.status, t.errors])).toEqual(TITLES.map((title) => [title, 'passed', []]));
    expect(on.heard.setups[0]).toMatchObject({ projectName: 'live-view-spec', liveView: true });
    expect(on.output).toContain('Live view on');
    // One worker a project: one stream each, naming it, with the run's key.
    expect(on.heard.streams.length).toBeGreaterThanOrEqual(2);
    expect(on.heard.streams[0]!.url).toMatch(/\/api\/test-runs\/41\/live-view\?worker=0$/);
    expect(on.heard.streams[0]!.authorization).toBe(`Bearer ${KEY}`);
  });

  it('keeps the key from every process the worker starts, and hands it to the projects that depend on its own', () => {
    const { sawKey, watching } = runs.on.heard;
    const places = ['worker-fixture', 'beforeAll', 'test', 'afterAll', 'worker-teardown'];
    for (const where of places) expect(sawKey.filter((s) => s.where === where).length, where).toBeGreaterThan(0);
    expect(sawKey.filter((s) => s.had)).toEqual([]);
    // The video project depends on the first: its worker got the key too, and was watched.
    expect(watching['recorded on video while watched']).toBeDefined();
  });

  it('sends no frame before anyone watches, and none once nobody does', () => {
    const { heard: run } = runs.on;
    const watch = run.watching['watched while it runs']!;
    const before = run.posts.filter((p) => p.message.type === 'frame' && p.at < watch.from);
    expect(before).toEqual([]);
    const watched = run.posts.filter((p) => p.message.type === 'frame' && p.at >= watch.from && p.at <= watch.to!);
    expect(watched.length).toBeGreaterThan(3);
    // A frame in flight as the viewer left may still land just after.
    const after = run.posts.filter(
      (p) => p.message.type === 'frame' && p.at > watch.to! + 300 && p.at < watch.to! + 1000,
    );
    expect(after).toEqual([]);
  });

  it('sends small frames of the page, a few a second at most, each with the call it was taken at', () => {
    heard = runs.on.heard;
    const watch = heard.watching['watched while it runs']!;
    const seen = frames(watch.from, watch.to!);
    const seconds = (watch.to! - watch.from) / 1000;
    const bytes = seen.reduce((sum, f) => sum + Buffer.from(f.message.data, 'base64').length, 0);
    const fps = seen.length / seconds;
    console.log(
      `[live view] ${seen.length} frames in ${seconds.toFixed(1)} s: ${fps.toFixed(1)} a second, ` +
        `${Math.round(bytes / seen.length / 1024)} KB a frame, ${Math.round(bytes / seconds / 1024)} KB a second`,
    );
    expect(fps).toBeLessThanOrEqual(LIVE_FRAME_FPS + 0.5);
    expect(bytes / seconds).toBeLessThanOrEqual(LIVE_FRAME_BYTE_RATE);
    const jpeg = Buffer.from(seen[0]!.message.data, 'base64');
    expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    const size = jpegSize(jpeg)!;
    expect(size.width).toBeLessThanOrEqual(LIVE_FRAME_WIDTH);
    expect(size.height).toBeLessThanOrEqual(LIVE_FRAME_HEIGHT);
    const calls = seen.flatMap((f) => (f.message.call ? [f.message.call] : []));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toMatchObject({ file: 'tests/live.spec.cjs', line: expect.any(Number) });
    expect(calls[0]!.title.length).toBeGreaterThan(0);
  });

  it('holds a busy page within the byte rate, each frame within the cap, on video too', () => {
    heard = runs.on.heard;
    for (const test of ['watched on a busy page', 'a busy page recorded on video while watched']) {
      const watch = heard.watching[test]!;
      const seen = frames(watch.from, watch.to!);
      const seconds = (watch.to! - watch.from) / 1000;
      const sizes = seen.map((f) => Buffer.from(f.message.data, 'base64').length);
      const bytes = sizes.reduce((sum, size) => sum + size, 0);
      console.log(
        `[live view, ${test}] ${seen.length} frames in ${seconds.toFixed(1)} s: ${(seen.length / seconds).toFixed(1)} a second, ` +
          `${Math.round(bytes / Math.max(1, seen.length) / 1024)} KB a frame, ${Math.round(bytes / seconds / 1024)} KB a second`,
      );
      expect(seen.length, test).toBeGreaterThan(0);
      expect(Math.max(...sizes), test).toBeLessThanOrEqual(MAX_LIVE_FRAME);
      expect(bytes / seconds, test).toBeLessThanOrEqual(LIVE_FRAME_BYTE_RATE * 1.2);
    }
  });

  it('says the test ended while someone watched it', () => {
    heard = runs.on.heard;
    const watch = heard.watching['ended while watched']!;
    expect(frames(watch.from).length).toBeGreaterThan(0);
    expect(heard.posts.some((p) => p.message.type === 'ended' && p.at >= watch.from)).toBe(true);
  });

  it('names each frame’s test', () => {
    heard = runs.on.heard;
    for (const test of ['watched while it runs', 'watched on a busy page', 'recorded on video while watched']) {
      const watch = heard.watching[test]!;
      const named = new Set(frames(watch.from, watch.to!).map((f) => f.message.test));
      expect([...named], test).toEqual([test]);
    }
  });

  it('lets a watched test start its own screencast, and goes on with images of the page while it records', () => {
    heard = runs.on.heard;
    const watch = heard.watching[OWN]!;
    const { 'own-start': start, 'own-stop': stop } = heard.marks;
    expect(frames(watch.from, start).length).toBeGreaterThan(0);
    // One image a second while the test holds the page's screencast.
    expect(frames(start, stop).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the video whole and sends fewer, heavier frames in a suite that records video', () => {
    heard = runs.on.heard;
    const test = runs.on.tests.find((t) => t.title === 'recorded on video while watched')!;
    const video = test.attachments.find((a) => a.name === 'video');
    expect(video?.path && fs.statSync(video.path).size).toBeGreaterThan(10_000);
    const watch = heard.watching['recorded on video while watched']!;
    const seen = frames(watch.from, watch.to!);
    const seconds = (watch.to! - watch.from) / 1000;
    const bytes = seen.reduce((sum, f) => sum + Buffer.from(f.message.data, 'base64').length, 0);
    console.log(
      `[live view, video on] ${seen.length} frames in ${seconds.toFixed(1)} s, ` +
        `${Math.round(bytes / Math.max(1, seen.length) / 1024)} KB a frame, ${Math.round(bytes / seconds / 1024)} KB a second`,
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(bytes / seconds).toBeLessThanOrEqual(LIVE_FRAME_BYTE_RATE * 1.2);
    // The video's client came first: the frames are at its size, 800 pixels at most.
    const size = jpegSize(Buffer.from(seen[0]!.message.data, 'base64'))!;
    expect(size.width).toBeGreaterThan(LIVE_FRAME_WIDTH);
    expect(size.width).toBeLessThanOrEqual(800);
  });

  it('shows nothing of the view among the tests’ steps', () => {
    for (const test of runs.on.tests) {
      const titles = stepTitles(test.steps).join('\n');
      expect(titles, test.title).not.toMatch(/screencast|Screenshot|Evaluate/i);
    }
  });

  it('sends nothing with the live view off: no key, no stream, no post', () => {
    const { off } = runs;
    expect(off.exitCode, off.output).toBe(0);
    expect(off.tests.map((t) => t.status)).toEqual(TITLES.map(() => 'passed'));
    expect(off.heard.setups[0]).toMatchObject({ liveView: true });
    expect(off.heard.liveRequests).toBe(0);
    expect(off.output).not.toContain('Live view on');
    // The CI run says why nobody can watch it, and what turns the view on.
    expect(off.output).toContain('Live view off: nobody can watch this run');
  });

  it('sends nothing from a run outside CI nobody shares, in a project with the live view on, its key held', () => {
    const { local } = runs;
    expect(local.exitCode, local.output).toBe(0);
    expect(local.tests.map((t) => t.status)).toEqual(TITLES.map(() => 'passed'));
    expect(local.heard.setups).toHaveLength(1);
    expect(local.heard.setups[0]).toMatchObject({ liveView: true });
    expect(local.heard.liveRequests).toBe(0);
    expect(local.output).not.toContain('Live view on');
    expect(local.output).not.toContain('Live view off');
    // No editor follows the run: nobody can share it, and the reporter says nothing of it.
    expect(local.output).not.toContain('Live view ready');
  });
});
