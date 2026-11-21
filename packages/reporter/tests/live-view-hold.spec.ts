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
 * Holding a failing CI test for its controllers, in a real CI run through the built package against a fake instance:
 * a test that fails while the project's setting is on (`hold`) and a controller watches its worker in full waits at
 * its failure, saying so (`stop` of kind `held`, with its end), and goes on at the hold's length, at **Let it go**, as
 * the last controller leaves and as its stream closes for good, its result unchanged. Without the setting, without a
 * controller (a Viewer watching), or with tiles alone, it ends at once, and a **Let it go** changes nothing.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.live-view-hold-${process.pid}`);
const RUN = 47;
const KEY = `pdl_${'h'.repeat(43)}`;
const requireHere = createRequire(import.meta.url);
/** A hold none of these tests reaches the end of, but the one held to its length. */
const LONG_MS = 60_000;
const SHORT_MS = 2_000;
/** A test's timeout, and a hold past it. */
const TIMEOUT_MS = 1_500;
const OVER_TIMEOUT_MS = 3_000;

/** What the fake instance says to the worker of each test, and what it does once that test is held. */
interface Scenario {
  hold: number | null;
  full: boolean;
  controller: boolean;
  /** As the held stop comes: Let it go, the last controller leaving, or the stream closed for good. */
  after?: 'let-go' | 'leave' | 'close';
}

const SCENARIOS: Record<string, Scenario> = {
  'held to its length': { hold: SHORT_MS, full: true, controller: true },
  'let go': { hold: LONG_MS, full: true, controller: true, after: 'let-go' },
  'the last controller leaves': { hold: LONG_MS, full: true, controller: true, after: 'leave' },
  'its stream closes for good': { hold: LONG_MS, full: true, controller: true, after: 'close' },
  'the setting is off': { hold: null, full: true, controller: true, after: 'let-go' },
  'tiles alone': { hold: LONG_MS, full: false, controller: false },
  'a viewer watches': { hold: LONG_MS, full: true, controller: false },
  // These two have bodies of their own (`SPEC`).
  'held longer than its timeout': { hold: OVER_TIMEOUT_MS, full: true, controller: true },
  'without the page fixture': { hold: LONG_MS, full: true, controller: true, after: 'let-go' },
};
/** The tests that fail on the `page` fixture's page, at once. */
const PLAIN = Object.keys(SCENARIOS).slice(0, -2);

const PAGE = '<!doctype html><title>a</title><h1>A</h1>';

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
const begin = async (page, title) => {
  await page.goto('${base}/a');
  await fetch('${base}/scenario?name=' + encodeURIComponent(title));
  await new Promise((resolve) => setTimeout(resolve, 500));
};
for (const title of ${JSON.stringify(PLAIN)}) {
  test(title, async ({ page }) => {
    await begin(page, title);
    await expect(page.getByRole('heading')).toHaveText('Not A', { timeout: 300 });
  });
}
test('held longer than its timeout', async ({ page }) => {
  test.setTimeout(${TIMEOUT_MS});
  await begin(page, 'held longer than its timeout');
  await expect(page.getByRole('heading')).toHaveText('Not A', { timeout: 300 });
});
test('without the page fixture', async ({ browser }) => {
  const page = await browser.newPage();
  await begin(page, 'without the page fixture');
  await expect(page.getByRole('heading')).toHaveText('Not A', { timeout: 300 });
});
`;

/** Each test's result, and when the runner heard it ended, as the run's own reporter writes them. */
const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message), duration: result.duration, endedAt: Date.now() });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

const streams: http.ServerResponse[] = [];
const posts: Array<{ at: number; message: WorkerToInstance }> = [];
/** The address of each stream a worker opened. */
const streamUrls: string[] = [];
let scenario: Scenario | null = null;
/** The stream of the worker running the current scenario's test refused for good: its next opening answers 410. */
let refuseNext = false;
let run = {
  exitCode: null as number | null,
  output: '',
  tests: [] as Array<{ title: string; status: string; errors: string[]; duration: number; endedAt: number }>,
};

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

/** How long after its held stop came the runner heard the test end, in ms. */
const heldFor = (test: string): number => {
  const ended = run.tests.find((t) => t.title === test)!.endedAt;
  return ended - stopsOf(test)[0]!.at;
};

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
      say({ type: 'hold', ms: scenario.hold });
      const view = { type: 'view', width: 640, height: 400, fps: 4, full: scenario.full, layers: [], inspect: false };
      say(scenario.controller ? { ...view, controller: true } : view);
      say({ type: 'viewers', count: 1 });
      // A Let it go of a worker that holds nothing changes nothing.
      if (scenario.hold === null && scenario.after === 'let-go') say({ type: 'let-go' });
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
        streamUrls.push(req.url);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'viewers', count: 0 })}\n\n`);
        streams.push(res);
        return;
      }
      if (req.headers['content-type'] !== 'application/json') return jsonRes(res, 200, { success: true });
      const message = readWorkerToInstance(JSON.parse(req.body));
      if (typeof message === 'string') return jsonRes(res, 400, { message });
      posts.push({ at: Date.now(), message });
      if (message.type === 'stop' && message.stop?.reason === 'held' && scenario?.after) {
        const after = scenario.after;
        setTimeout(() => {
          if (after === 'let-go') say({ type: 'let-go' });
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

  write('tests/hold.spec.cjs', SPEC(server.url));
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
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'live-view-hold-spec', streamingBatchDelay: 50 });
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

describe('holding a failing CI test for its controllers', () => {
  it('says on each stream that the worker can hold', () => {
    expect(streamUrls.length, run.output).toBeGreaterThan(0);
    for (const url of streamUrls) expect(new URL(url, 'http://x').searchParams.get('features')).toBe('hold');
  });

  it('leaves each test’s result as it was: failed, with its own error', () => {
    expect(
      run.tests.map((t) => [t.title, t.status]),
      run.output,
    ).toEqual(Object.keys(SCENARIOS).map((title) => [title, 'failed']));
    for (const test of run.tests) expect(test.errors.join('\n'), test.title).toContain('toHaveText');
  });

  it('holds a failing test while a controller watches it in full, saying when the hold ends', () => {
    const [held, end] = stopsOf('held to its length');
    expect(held?.stop).toMatchObject({ reason: 'held', test: 'held to its length' });
    expect(held!.stop!.call.title).toMatch(/^Failed: /);
    expect(held!.stop!.until! - held!.at).toBeGreaterThan(SHORT_MS - 500);
    expect(held!.stop!.until! - held!.at).toBeLessThanOrEqual(SHORT_MS + 100);
    expect(end?.stop).toBeNull();
  });

  it('ends the hold at its length', () => {
    expect(heldFor('held to its length')).toBeGreaterThan(SHORT_MS - 500);
    expect(heldFor('held to its length')).toBeLessThan(SHORT_MS + 3000);
  });

  it('ends the hold at Let it go, as the last controller leaves, and as its stream closes for good', () => {
    for (const test of ['let go', 'the last controller leaves', 'its stream closes for good']) {
      expect(stopsOf(test)[0]?.stop?.reason, test).toBe('held');
      expect(heldFor(test), test).toBeLessThan(5_000);
    }
    for (const test of ['let go', 'the last controller leaves']) {
      const stops = stopsOf(test);
      expect(stops[stops.length - 1]?.stop, test).toBeNull();
    }
  });

  it('holds nothing with the setting off, with tiles alone, or for a viewer who may not control the run', () => {
    for (const test of ['the setting is off', 'tiles alone', 'a viewer watches']) {
      expect(stopsOf(test), test).toEqual([]);
    }
    const held = posts.filter((p) => p.message.type === 'stop' && p.message.stop?.reason === 'held');
    expect(held.map((p) => (p.message as { stop: LiveStop }).stop.test)).toEqual([
      'held to its length',
      'let go',
      'the last controller leaves',
      'its stream closes for good',
      'held longer than its timeout',
      'without the page fixture',
    ]);
  });

  it('holds past the test’s timeout without timing it out, its duration leaving the wait out', () => {
    const test = run.tests.find((t) => t.title === 'held longer than its timeout')!;
    expect(test.status).toBe('failed');
    expect(test.errors.join('\n')).not.toMatch(/Test timeout/);
    expect(heldFor('held longer than its timeout')).toBeGreaterThan(OVER_TIMEOUT_MS - 500);
    expect(test.duration).toBeLessThan(TIMEOUT_MS);
  });

  it('holds a test that does not use the page fixture, on the page it opened', () => {
    expect(stopsOf('without the page fixture')[0]?.stop?.reason).toBe('held');
    expect(heldFor('without the page fixture')).toBeLessThan(5_000);
  });
});
