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
 * How a CI test a controller paused ends, and when a Pause is not taken, in a real CI run through the built package
 * against a fake instance: **End the test** fails the test at once with who ended it, the call it stopped before never
 * running and nothing after it in the test either; a Pause asked while the failing call waits is dropped as the test's
 * function ends, the failure then held once; a Pause of a test whose page was followed through Playwright's call
 * stream before the setting was on is dropped, saying why; and a Pause stops a call before it waits for its element,
 * as Playwright's in-process instrumentation leaves the debugger to.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.live-view-pause-end-${process.pid}`);
const RUN = 53;
const KEY = `pdl_${'e'.repeat(43)}`;
const requireHere = createRequire(import.meta.url);
const LONG_MS = 60_000;

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
/** The instance says the settings, a controller watching in full, and a Pause unless told not to. */
const plan = (query) => fetch('${base}/plan?' + query);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('ended at its stop, named', async ({ page }) => {
  await page.goto('${base}/a');
  await plan('after=end&by=Ana');
  await wait(500);
  await page.goto('${base}/side-goto');
  await page.evaluate(() => fetch('/side-evaluate'));
  await page.request.post('${base}/side-api');
  await page.getByRole('heading').click();
});

test('ended at its stop, unnamed', async ({ page }) => {
  await page.goto('${base}/a');
  await plan('after=end');
  await wait(500);
  await page.getByRole('heading').click();
  await page.evaluate(() => fetch('/side-after-locator'));
});

test.describe('with an afterEach that calls the page', () => {
  test.afterEach(async ({ page }) => {
    await page.getByRole('heading').textContent();
  });
  test('paused while its failing call waits', async ({ page }) => {
    await page.goto('${base}/a');
    setTimeout(() => void plan('t=fail&after=resume'), 300);
    await expect(page.getByRole('heading')).toHaveText('Not A', { timeout: 1500 });
  });
});

test('followed through the call stream before the setting', async ({ page }) => {
  await page.goto('${base}/a');
  await plan('setting=0&pause=0');
  await wait(600);
  await plan('after=resume');
  await wait(300);
  await page.getByRole('heading').click();
});

test('paused before its call waits', async ({ page }) => {
  await page.goto('${base}/late');
  await plan('after=resume&wait=3000');
  await wait(900);
  await page.getByRole('button').click();
});
`;

const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    this.tests.push({ title: test.title, status: result.status, retry: result.retry, errors: result.errors.map((e) => e.message) });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface Result {
  title: string;
  status: string;
  retry: number;
  errors: string[];
}

const streams: http.ServerResponse[] = [];
const posts: Array<{ at: number; message: WorkerToInstance }> = [];
/** The side requests the test's page and its request context made, each with when it came. */
const hits: Array<{ route: string; at: number }> = [];
let plan: { after: string | null; by: string | null; wait: number } = { after: null, by: null, wait: 300 };
/** Each plan the tests asked, with the name a test gave it (`t`) and when. */
const plans: Array<{ name: string | null; at: number }> = [];
let run = { output: '', tests: [] as Result[] };

function say(message: unknown): void {
  const stream = streams[streams.length - 1];
  if (stream && !stream.writableEnded) stream.write(`data: ${JSON.stringify(message)}\n\n`);
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** What the worker posted from the first plan named `name` (`t`), its first attempt's, until the next plan. */
function postsOf(name: string): Array<{ at: number; message: WorkerToInstance }> {
  const first = plans.findIndex((p) => p.name === name);
  const next = first + 1 < plans.length ? first + 1 : -1;
  const from = plans[first]!.at;
  const to = next < 0 ? Infinity : plans[next]!.at;
  return posts.filter((p) => p.at >= from && p.at < to);
}

const stopsOf = (test: string): LiveStop[] =>
  posts.flatMap((p) => (p.message.type === 'stop' && p.message.stop?.test === test ? [p.message.stop] : []));
const resultsOf = (test: string): Result[] => run.tests.filter((t) => t.title === test);

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  const server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    if (route.startsWith('/side')) {
      hits.push({ route, at: Date.now() });
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<h1>S</h1>');
    }
    if (route === '/a') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>a</title><h1>A</h1>');
    }
    if (route === '/late') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(
        '<!doctype html><title>l</title><script>setTimeout(() => { document.body.innerHTML = "<button>Go</button>"; fetch("/side-shown"); }, 2500)</script>',
      );
    }
    if (route === '/plan') {
      const q = url.searchParams;
      plan = { after: q.get('after'), by: q.get('by'), wait: Number(q.get('wait') ?? 300) };
      plans.push({ name: q.get('t'), at: Date.now() });
      say(q.get('setting') === '0' ? { type: 'hold', ms: LONG_MS } : { type: 'hold', ms: LONG_MS, pause: true });
      say({ type: 'view', width: 640, height: 400, fps: 4, full: true, layers: [], inspect: false, controller: true });
      say({ type: 'viewers', count: 1 });
      if (q.get('pause') !== '0') say({ type: 'pause' });
      return res.end();
    }
    if (route === '/api/test-runs/setup') {
      return jsonRes(res, 200, { success: true, runId: RUN, projectId: 1, setupToken: 's', liveView: { key: KEY } });
    }
    if (route === `/api/test-runs/${RUN}/begin`)
      return jsonRes(res, 200, { success: true, runId: RUN, streamToken: 't' });
    if (route === `/api/test-runs/${RUN}/live-view`) {
      if (req.headers.authorization !== `Bearer ${KEY}`) return jsonRes(res, 401, { message: 'no key' });
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'viewers', count: 0 })}\n\n`);
        streams.push(res);
        return;
      }
      if (req.headers['content-type'] !== 'application/json') return jsonRes(res, 200, { success: true });
      const message = readWorkerToInstance(JSON.parse(req.body));
      if (typeof message === 'string') return jsonRes(res, 400, { message });
      posts.push({ at: Date.now(), message });
      if (message.type === 'stop' && message.stop?.reason === 'held') setTimeout(() => say({ type: 'let-go' }), 300);
      if (message.type === 'stop' && message.stop?.reason === 'pause' && plan.after) {
        const { after, by } = plan;
        setTimeout(() => {
          if (after === 'resume') say({ type: 'resume' });
          if (after === 'end') say(by ? { type: 'end-test', by } : { type: 'end-test' });
        }, plan.wait);
      }
      return jsonRes(res, 200, { success: true });
    }
    if (route.startsWith('/api/')) return jsonRes(res, 200, { success: true });
    res.writeHead(404);
    res.end();
  });

  write('tests/end.spec.cjs', SPEC(server.url));
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
  timeout: 20000,
  retries: 1,
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  use: { headless: true, viewport: { width: 640, height: 400 }, trace: 'off' },
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'live-view-pause-end-spec', streamingBatchDelay: 50 });
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
      { cwd: project, env, timeout: 240_000 },
      (_error, stdout, stderr) => {
        run.output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'results.json');
  run = { ...run, tests: fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [] };
  for (const res of streams) res.end();
  await server.close();
}, 300_000);

afterAll(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('End the test of a paused CI test', () => {
  it('fails the test at once with who ended it, and its retry runs as after any failure', () => {
    const [first, retry] = resultsOf('ended at its stop, named');
    expect(first, run.output).toMatchObject({ status: 'failed', retry: 0 });
    expect(first!.errors.join('\n')).toMatch(/^Error: Ended from Piwi by Ana$/m);
    expect(retry).toMatchObject({ retry: 1 });
    expect(resultsOf('ended at its stop, unnamed')[0]!.errors.join('\n')).toMatch(/^Error: Ended from Piwi$/m);
  });

  it('runs neither the call it stopped before nor anything after it', () => {
    expect(stopsOf('ended at its stop, named')[0]).toMatchObject({ reason: 'pause' });
    expect(hits.map((hit) => hit.route)).not.toContain('/side-goto');
    expect(hits.map((hit) => hit.route)).not.toContain('/side-evaluate');
    expect(hits.map((hit) => hit.route)).not.toContain('/side-api');
    expect(hits.map((hit) => hit.route)).not.toContain('/side-after-locator');
  });
});

describe('a Pause the test cannot take', () => {
  it('is dropped as the failing test’s function ends, the failure held once', () => {
    const test = 'paused while its failing call waits';
    expect(resultsOf(test)[0]).toMatchObject({ status: 'failed' });
    expect(resultsOf(test)[0]!.errors.join('\n')).toContain('toHaveText');
    expect(stopsOf(test).map((stop) => stop.reason)).not.toContain('pause');
    const attempt = postsOf('fail').flatMap((p) =>
      p.message.type === 'stop' && p.message.stop ? [p.message.stop] : [],
    );
    expect(attempt.map((stop) => stop.reason)).toEqual(['held']);
    const asked = postsOf('fail')
      .filter((p) => p.message.type === 'pause-asked')
      .map((p) => p.message);
    expect(asked[0]).toMatchObject({ waiting: true });
    expect(asked[1]).toMatchObject({ waiting: false, why: expect.stringMatching(/function ended/) });
  });

  it('is dropped for a page followed through Playwright’s call stream before the setting, saying why', () => {
    const test = 'followed through the call stream before the setting';
    expect(resultsOf(test)[0]).toMatchObject({ status: 'passed' });
    expect(stopsOf(test)).toEqual([]);
    const dropped = posts.filter(
      (p) => p.message.type === 'pause-asked' && !p.message.waiting && /followed/.test(p.message.why),
    );
    expect(dropped).toHaveLength(1);
  });
});

describe('a Pause of a test whose project lets its controllers pause', () => {
  it('stops the call before it waits for its element, as the instrumentation leaves the debugger to', () => {
    const test = 'paused before its call waits';
    expect(resultsOf(test)[0]).toMatchObject({ status: 'passed' });
    const paused = posts.find((p) => p.message.type === 'stop' && p.message.stop?.test === test)!;
    const shown = hits.find((hit) => hit.route === '/side-shown')!;
    expect(paused.at).toBeLessThan(shown.at);
  });
});
