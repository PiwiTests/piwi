import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWorkerToInstance, type LiveCallLog, type WorkerToInstance } from '@piwitests/core/live-view';
import { detectCi } from '../src/internal/support/ci.js';
import { jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * The live view's call log, in a real CI run through the built package against a fake instance: while someone watches
 * a worker, it posts the call its test is in as Playwright logs it (the log's last lines, the point an input action
 * acts on, the elements the call's locator matches while it waits), from the moment they come, and nothing while
 * nobody watches. The text a fill types and a password field's value never go, and nothing of it shows among the
 * test's steps.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.live-view-call-log-${process.pid}`);
const RUN = 43;
const KEY = `pdl_${'c'.repeat(43)}`;
const SECRET = 'S3cr3t!Passw0rd';
const TEST_TITLE = 'waits on disabled buttons and a missing link while watched';
const requireHere = createRequire(import.meta.url);

/** A checkout whose Pay button is enabled 3 s after Check card is clicked; Confirm and Gift stay disabled. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>checkout</title>
<style>body { margin: 0; padding: 20px; font: 16px sans-serif }</style>
<label>Password <input id="password" type="password"></label>
<button id="check" onclick="setTimeout(() => { document.getElementById('pay').disabled = false; }, 3000)">Check card</button>
<button id="pay" disabled>Pay</button>
<button disabled>Confirm</button>
<button disabled>Gift</button>`;

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('${TEST_TITLE}', async ({ page }) => {
  await page.goto('${base}/checkout');
  // Someone comes to watch while the click waits.
  await fetch('${base}/watch-soon');
  await page.getByRole('link', { name: 'Missing' }).click({ timeout: 4000 }).catch(() => {});
  await page.getByLabel('Password').fill('${SECRET}');
  await new Promise((resolve) => setTimeout(resolve, 600));
  await expect(page.getByLabel('Password')).toHaveValue('not it', { timeout: 1500 }).catch(() => {});
  await page.getByRole('button', { name: 'Check card' }).click();
  await page.getByRole('button', { name: 'Pay' }).click();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await Promise.all([
    page.getByRole('button', { name: 'Confirm' }).click({ timeout: 2500 }).catch(() => {}),
    page.getByRole('button', { name: 'Gift' }).click({ timeout: 2500 }).catch(() => {}),
  ]);
  await fetch('${base}/unwatch');
});
`;

/** Each test's result and steps, as the run's own reporter writes them. */
const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const titles = (steps) => steps.flatMap((s) => [s.title, ...titles(s.steps)]);
    this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message), steps: titles(result.steps) });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

let server: FakeServer;
const streams: http.ServerResponse[] = [];
const posts: Array<{ at: number; message: WorkerToInstance }> = [];
let watchedFrom: number | null = null;
let watchedTo: number | null = null;
let run = {
  exitCode: null as number | null,
  output: '',
  tests: [] as Array<{ title: string; status: string; errors: string[]; steps: string[] }>,
};

function sayViewers(count: number): void {
  for (const res of streams)
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'viewers', count })}\n\n`);
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** The call logs the worker posted, in order. */
const callLogs = (): Array<{ at: number; log: LiveCallLog; test: string | null }> =>
  posts.flatMap((p) => (p.message.type === 'call-log' ? [{ at: p.at, log: p.message.log, test: p.message.test }] : []));

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    if (route === '/checkout') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
    }
    if (route === '/watch-soon') {
      setTimeout(() => {
        watchedFrom = Date.now();
        sayViewers(1);
      }, 1500);
      return res.end();
    }
    if (route === '/unwatch') {
      watchedTo = Date.now();
      sayViewers(0);
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
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'viewers', count: 0 })}\n\n`);
        streams.push(res);
        return;
      }
      const message = readWorkerToInstance(JSON.parse(req.body));
      if (typeof message === 'string') return jsonRes(res, 400, { message });
      posts.push({ at: Date.now(), message });
      return jsonRes(res, 200, { success: true });
    }
    if (route.startsWith('/api/')) return jsonRes(res, 200, { success: true, watched: true });
    res.writeHead(404);
    res.end();
  });

  write('tests/live.spec.cjs', SPEC(server.url));
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
  timeout: 30000,
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  use: { headless: true, viewport: { width: 1280, height: 720 }, trace: 'off' },
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'live-view-call-log-spec', streamingBatchDelay: 50 });
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
      { cwd: project, env, timeout: 120_000 },
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
}, 180_000);

afterAll(async () => {
  await server?.close();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('the live view’s call log', () => {
  it('lets the test pass, as without it', () => {
    expect(run.exitCode, run.output).toBe(0);
    expect(run.tests.map((t) => [t.title, t.status, t.errors])).toEqual([[TEST_TITLE, 'passed', []]]);
  });

  it('shows a viewer who comes while a call waits that call at once, with its log and its time so far', () => {
    const [first] = callLogs();
    expect(first, JSON.stringify(callLogs().map((c) => c.log.call.title))).toBeDefined();
    expect(first!.at - watchedFrom!).toBeLessThan(1500);
    expect(first!.log).toMatchObject({
      call: { title: "Click getByRole('link', { name: 'Missing' })" },
      status: 'running',
    });
    expect(first!.log.lines.join('\n')).toContain("waiting for getByRole('link', { name: 'Missing' })");
    expect(first!.log.ms).toBeGreaterThanOrEqual(1000);
    const missing = callLogs().find(({ log }) => log.call.title.includes("'Missing'") && log.target?.count === 0)?.log;
    expect(missing?.target).toEqual({ count: 0, box: null, enabled: null });
  });

  it('tells why a click waits: Playwright’s log, its place, and the element its locator matches, not enabled', () => {
    const waiting = callLogs().find(
      ({ log }) =>
        log.status === 'running' &&
        log.call.title.startsWith("Click getByRole('button', { name: 'Pay' })") &&
        log.target?.enabled === false,
    )?.log;
    expect(waiting, JSON.stringify(callLogs().map((c) => c.log.call.title))).toBeDefined();
    expect(waiting!.call).toMatchObject({ file: 'tests/live.spec.cjs' });
    expect(waiting!.lines.join('\n')).toMatch(/element is not enabled/);
    expect(waiting!.target).toMatchObject({ count: 1, enabled: false });
    expect(waiting!.target!.box!.width).toBeGreaterThan(0);
    expect(waiting!.viewport).toEqual({ width: 1280, height: 720 });
    // Once Pay is enabled, the click names the point it acts on, and ends: the test goes on without a call a while.
    const pay = callLogs().filter(({ log }) => log.call.title.startsWith("Click getByRole('button', { name: 'Pay' })"));
    expect(pay.some(({ log }) => log.point !== null)).toBe(true);
    expect(pay.some(({ log }) => log.status === 'passed')).toBe(true);
  });

  it('keeps each of two calls waiting at once whole: its time and its element', () => {
    const both = callLogs().filter(({ log }) => /'(Confirm|Gift)'/.test(log.call.title));
    expect(both.length).toBeGreaterThan(0);
    expect(Math.max(...both.map(({ log }) => log.ms))).toBeGreaterThanOrEqual(1500);
    expect(both.some(({ log }) => log.target?.count === 1 && log.target.enabled === false)).toBe(true);
  });

  it('never sends the text a fill types, nor a password field’s value', () => {
    expect(JSON.stringify(posts)).not.toContain('S3cr3t');
    expect(callLogs().some(({ log }) => log.call.title === `Fill "<hidden>" getByLabel('Password')`)).toBe(true);
    expect(callLogs().some(({ log }) => log.lines.some((line) => line.includes('unexpected value "<hidden>"')))).toBe(
      true,
    );
  });

  it('names its test, and goes only while someone watches', () => {
    expect(new Set(callLogs().map(({ test }) => test))).toEqual(new Set([TEST_TITLE]));
    expect(watchedFrom).not.toBeNull();
    for (const { at } of callLogs()) {
      expect(at).toBeGreaterThanOrEqual(watchedFrom!);
      expect(at).toBeLessThanOrEqual(watchedTo! + 1000);
    }
  });

  it('shows nothing of itself among the test’s steps', () => {
    const steps = run.tests[0]!.steps;
    expect(steps.filter((title) => /evaluate|debugger|enable|Piwi capture/i.test(title))).toEqual([]);
  });
});
