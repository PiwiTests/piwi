import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWorkerToInstance, type LiveStop, type WorkerToInstance } from '@piwitests/core/live-view';
import { detectCi } from '../src/internal/support/ci.js';
import { jsonRes, startServer } from './_helpers.js';

/**
 * Pausing a CI test for its controllers, in a real CI run through the built package against a fake instance: with the
 * project's setting on (`hold`'s `pause`) and a controller watching its worker in full, a **Pause** on the worker's
 * stream stops its test before its next call, saying so (`stop` of kind `pause`, with its end), its timeout suspended;
 * the pause ends at **Resume**, at **End the test** (which fails the test with who ended it), at its length, as the
 * last controller leaves, as the setting turns off and as the stream closes for good, and the test's result is its
 * own. Without the setting, or for a Viewer, a Pause changes nothing.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.live-view-pause-${process.pid}`);
const RUN = 49;
const KEY = `pdl_${'q'.repeat(43)}`;
const requireHere = createRequire(import.meta.url);
/** A pause none of these tests reaches the end of, but the one paused to its length. */
const LONG_MS = 60_000;
const SHORT_MS = 2_000;
/** A test's timeout, and a pause past it. */
const TIMEOUT_MS = 1_500;
const OVER_TIMEOUT_MS = 3_000;

/** What the fake instance says to the worker of each test, and what it does once that test is paused. */
interface Scenario {
  ms: number;
  pause: boolean;
  controller: boolean;
  /** As the paused stop comes. */
  after?: 'resume' | 'end' | 'leave' | 'off' | 'close';
}

const SCENARIOS: Record<string, Scenario> = {
  resumed: { ms: LONG_MS, pause: true, controller: true, after: 'resume' },
  'ended at End the test': { ms: LONG_MS, pause: true, controller: true, after: 'end' },
  'paused to its length': { ms: SHORT_MS, pause: true, controller: true },
  'the last controller leaves': { ms: LONG_MS, pause: true, controller: true, after: 'leave' },
  'the setting turns off': { ms: LONG_MS, pause: true, controller: true, after: 'off' },
  'the setting is off': { ms: LONG_MS, pause: false, controller: true, after: 'resume' },
  'a viewer watches': { ms: LONG_MS, pause: true, controller: false },
  'paused longer than its timeout': { ms: OVER_TIMEOUT_MS, pause: true, controller: true },
  'resumed, then fails': { ms: LONG_MS, pause: true, controller: true, after: 'resume' },
  // Last: its worker's stream opens no more, and the worker that follows a failure opens a new one.
  'its stream closes for good': { ms: LONG_MS, pause: true, controller: true, after: 'close' },
};

const PAGE = '<!doctype html><title>a</title><h1>A</h1>';

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
const begin = async (page, title) => {
  await page.goto('${base}/a');
  await fetch('${base}/scenario?name=' + encodeURIComponent(title));
  await new Promise((resolve) => setTimeout(resolve, 500));
};
for (const title of ${JSON.stringify(Object.keys(SCENARIOS))}) {
  test(title, async ({ page }) => {
    if (title === 'paused longer than its timeout') test.setTimeout(${TIMEOUT_MS});
    await begin(page, title);
    await page.getByRole('heading').click();
    const expected = title === 'resumed, then fails' ? 'Not A' : 'A';
    await expect(page.getByRole('heading')).toHaveText(expected, { timeout: 300 });
  });
}
`;

/** Each test's result, and when the runner heard it ended, as the run's own reporter writes them. */
const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message), duration: result.duration, annotations: result.annotations.map((a) => a.type), endedAt: Date.now() });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface Result {
  title: string;
  status: string;
  errors: string[];
  duration: number;
  annotations: string[];
  endedAt: number;
}

const streams: http.ServerResponse[] = [];
const posts: Array<{ at: number; message: WorkerToInstance }> = [];
let scenario: Scenario | null = null;
/** The stream of the worker running the current scenario's test refused for good: its next opening answers 410. */
let refuseNext = false;
let run = { exitCode: null as number | null, output: '', tests: [] as Result[] };

function say(message: unknown): void {
  const stream = streams[streams.length - 1];
  if (stream && !stream.writableEnded) stream.write(`data: ${JSON.stringify(message)}\n\n`);
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** The stops the worker posted about `test`, in order, each with when it came. */
const stopsOf = (test: string): Array<{ at: number; stop: LiveStop | null }> => {
  const all = posts.flatMap((p) => (p.message.type === 'stop' ? [{ at: p.at, stop: p.message.stop }] : []));
  const first = all.findIndex((s) => s.stop?.test === test);
  if (first < 0) return [];
  const end = all.findIndex((s, i) => i > first && s.stop === null);
  return all.slice(first, end < 0 ? undefined : end + 1);
};

const resultOf = (test: string): Result => run.tests.find((t) => t.title === test)!;

/** How long after its paused stop came the runner heard the test end, in ms. */
const pausedFor = (test: string): number => resultOf(test).endedAt - stopsOf(test)[0]!.at;

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  const server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    if (route === '/a') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
    }
    if (route === '/scenario') {
      scenario = SCENARIOS[url.searchParams.get('name') ?? '']!;
      say(scenario.pause ? { type: 'hold', ms: scenario.ms, pause: true } : { type: 'hold', ms: scenario.ms });
      const view = { type: 'view', width: 640, height: 400, fps: 4, full: true, layers: [], inspect: false };
      say(scenario.controller ? { ...view, controller: true } : view);
      say({ type: 'viewers', count: 1 });
      say({ type: 'pause' });
      // Without the setting, a Resume changes nothing either.
      if (!scenario.pause && scenario.after === 'resume') say({ type: 'resume' });
      return res.end();
    }
    if (route === '/api/test-runs/setup') {
      return jsonRes(res, 200, {
        success: true,
        runId: RUN,
        projectId: 1,
        setupToken: 'setup-token',
        liveView: { key: KEY },
      });
    }
    if (route === `/api/test-runs/${RUN}/begin`) {
      return jsonRes(res, 200, { success: true, runId: RUN, streamToken: 'stream-token' });
    }
    if (route === `/api/test-runs/${RUN}/live-view`) {
      if (req.headers.authorization !== `Bearer ${KEY}`) return jsonRes(res, 401, { message: 'no key' });
      if (req.method === 'GET') {
        if (refuseNext) {
          refuseNext = false;
          return jsonRes(res, 410, { message: 'The run is no longer live' });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'viewers', count: 0 })}\n\n`);
        streams.push(res);
        return;
      }
      if (req.headers['content-type'] !== 'application/json') return jsonRes(res, 200, { success: true });
      const message = readWorkerToInstance(JSON.parse(req.body));
      if (typeof message === 'string') return jsonRes(res, 400, { message });
      posts.push({ at: Date.now(), message });
      // A failure held after a pause goes on at once.
      if (message.type === 'stop' && message.stop?.reason === 'held') say({ type: 'let-go' });
      if (message.type === 'stop' && message.stop?.reason === 'pause' && scenario?.after) {
        const after = scenario.after;
        setTimeout(() => {
          if (after === 'resume') say({ type: 'resume' });
          if (after === 'end') say({ type: 'end-test' });
          if (after === 'off') say({ type: 'hold', ms: LONG_MS });
          if (after === 'leave') {
            say({ type: 'view', width: 640, height: 400, fps: 4, full: false, layers: [], inspect: false });
            say({ type: 'viewers', count: 0 });
          }
          if (after === 'close') {
            refuseNext = true;
            streams[streams.length - 1]?.end();
          }
        }, 300);
      }
      return jsonRes(res, 200, { success: true });
    }
    if (route.startsWith('/api/')) return jsonRes(res, 200, { success: true });
    res.writeHead(404);
    res.end();
  });

  write('tests/pause.spec.cjs', SPEC(server.url));
  write(
    'fixture.cjs',
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  write('results-reporter.cjs', RESULTS_REPORTER);
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
const { wrapConfig } = require(${JSON.stringify(dist)});
module.exports = wrapConfig(defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 15000,
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  use: { headless: true, viewport: { width: 640, height: 400 }, trace: 'off' },
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'live-view-pause-spec', streamingBatchDelay: 50 });
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PROJECT_NAME', 'PIWI_LIVE_VIEW']) {
    delete env[name];
  }
  for (const name of Object.keys(env)) if (detectCi({ [name]: env[name] })) delete env[name];
  env.CI = 'true';
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [requireHere.resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 150_000 },
      (error, stdout, stderr) => {
        run.exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        run.output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'results.json');
  run = { ...run, tests: fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [] };
  for (const res of streams) res.end();
  await server.close();
}, 180_000);

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('pausing a CI test for its controllers', () => {
  it('leaves each test’s result its own: passed once it goes on, failed with its own error, failed at End the test', () => {
    expect(
      run.tests.map((t) => [t.title, t.status]),
      run.output,
    ).toEqual(
      Object.keys(SCENARIOS).map((title) => [
        title,
        title === 'ended at End the test' || title === 'resumed, then fails' ? 'failed' : 'passed',
      ]),
    );
    expect(resultOf('resumed, then fails').errors.join('\n')).toContain('toHaveText');
    expect(resultOf('ended at End the test').errors.join('\n')).toMatch(/^Error: Ended from Piwi$/m);
  });

  it('pauses the test before its next call, saying when the pause ends', () => {
    const [paused, end] = stopsOf('paused to its length');
    expect(paused?.stop).toMatchObject({ reason: 'pause', test: 'paused to its length' });
    expect(paused!.stop!.call.title).toMatch(/click/i);
    expect(paused!.stop!.call.line).toBeGreaterThan(0);
    expect(paused!.stop!.until! - paused!.at).toBeGreaterThan(SHORT_MS - 500);
    expect(paused!.stop!.until! - paused!.at).toBeLessThanOrEqual(SHORT_MS + 100);
    expect(end?.stop).toBeNull();
  });

  it('ends the pause at its length', () => {
    expect(pausedFor('paused to its length')).toBeGreaterThan(SHORT_MS - 500);
    expect(pausedFor('paused to its length')).toBeLessThan(SHORT_MS + 3000);
  });

  it('ends the pause at Resume, at End the test, as the last controller leaves, as the setting turns off, and as its stream closes for good', () => {
    for (const test of [
      'resumed',
      'ended at End the test',
      'the last controller leaves',
      'the setting turns off',
      'its stream closes for good',
    ]) {
      expect(stopsOf(test)[0]?.stop?.reason, test).toBe('pause');
      expect(pausedFor(test), test).toBeLessThan(5_000);
    }
  });

  it('pauses nothing with the setting off, or for a viewer who may not control the run', () => {
    for (const test of ['the setting is off', 'a viewer watches']) expect(stopsOf(test), test).toEqual([]);
    const paused = posts.filter((p) => p.message.type === 'stop' && p.message.stop?.reason === 'pause');
    expect(paused.map((p) => (p.message as { stop: LiveStop }).stop.test)).toEqual([
      'resumed',
      'ended at End the test',
      'paused to its length',
      'the last controller leaves',
      'the setting turns off',
      'paused longer than its timeout',
      'resumed, then fails',
      'its stream closes for good',
    ]);
  });

  it('pauses past the test’s timeout without timing it out, its duration leaving the wait out', () => {
    const test = resultOf('paused longer than its timeout');
    expect(test.status).toBe('passed');
    expect(pausedFor('paused longer than its timeout')).toBeGreaterThan(OVER_TIMEOUT_MS - 500);
    expect(test.duration).toBeLessThan(TIMEOUT_MS);
  });
});
