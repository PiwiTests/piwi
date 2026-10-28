import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { LIVE_SHARE_MISSING, readWorkerToInstance, type WorkerToInstance } from '@piwitests/core/live-view';
import { parseRunToHub, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { detectCi } from '../src/internal/support/ci.js';
import { jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * Share live in real Playwright runs outside CI, through the built package, against a fake instance and a fake editor
 * on the run channel. The global setup asks for a key in any run; outside CI the workers hold it and send the instance
 * nothing, and tell the editor the run can be shared, with its page there. The editor shares the run while its test
 * runs: the worker opens its stream, sends frames while someone watches, and the stop it holds shows as paused. The
 * editor stops sharing at that stop: the viewers hear why, the stream closes, and nothing more goes to the instance,
 * the stop's end included. A run whose project has the live view off tells the editor why it cannot be shared, and a
 * share asked anyway sends nothing.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const projects = path.join(pkgRoot, 'tests', `.live-view-share-${process.pid}`);
const RUN = 43;
const KEY = `pdl_${'s'.repeat(43)}`;
const REF = 'ed-5a1e5a1e';
const TOKEN = 'live-view-share-token-0123456789';
const requireHere = createRequire(import.meta.url);

/** A page that paints all the time. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>shop</title>
<style>#spin { width: 120px; height: 120px; background: linear-gradient(red, blue); animation: s 1s linear infinite } @keyframes s { to { transform: rotate(360deg) } }</style>
<h1>Shop</h1><div id="spin"></div>`;

/** The test: its page shows, the editor shares the run meanwhile, then the test stops at its breakpoint (`bp`). */
const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('shared while it runs', async ({ page }) => {
  await page.goto('${base}/page');
  await fetch('${base}/ready');
  await expect.poll(async () => (await (await fetch('${base}/watched')).json()).done, { timeout: 30000 }).toBe(true);
  await page.locator('h1').click(); // bp
  await expect(page.locator('h1')).toHaveText('Shop');
});
`;

interface Posted {
  at: number;
  message: WorkerToInstance;
}

/** What one run sent the fake instance and the fake editor. */
interface Heard {
  setups: Array<Record<string, unknown>>;
  streams: Array<{ res: http.ServerResponse; closed: boolean }>;
  posts: Posted[];
  liveRequests: number;
  /** What the worker told the editor of the run's live view, in order. */
  lives: Array<Extract<RunToHub, { type: 'live' }>>;
  /** The live view requests before the editor shared the run, and once it stopped sharing it. */
  beforeShare: number | null;
  afterUnshare: number | null;
  watched: boolean;
}

const fresh = (): Heard => ({
  setups: [],
  streams: [],
  posts: [],
  liveRequests: 0,
  lives: [],
  beforeShare: null,
  afterUnshare: null,
  watched: false,
});

/** A run of a project with the live view on, and one of a project with it off. */
type Mode = 'on' | 'off';

let server: FakeServer;
let hub: net.Server;
let folder = '';
let mode: Mode = 'on';
let heard = fresh();
let editor: net.Socket | null = null;
const runs: Record<Mode, { heard: Heard; exitCode: number | null; output: string }> = {
  on: { heard: fresh(), exitCode: null, output: '' },
  off: { heard: fresh(), exitCode: null, output: '' },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined | false, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(20);
  }
}

function tell(message: HubToRun): void {
  editor?.write(`${JSON.stringify(message)}\n`);
}

function sayViewers(count: number): void {
  for (const stream of heard.streams) {
    if (!stream.closed) stream.res.write(`data: ${JSON.stringify({ type: 'viewers', count })}\n\n`);
  }
}

const frames = () => heard.posts.filter((p) => p.message.type === 'frame' && 'data' in p.message);

/** The test's page shows: the editor shares the run while it runs, and someone watches it a while. */
async function onReady(): Promise<void> {
  try {
    heard.beforeShare = heard.liveRequests;
    tell({ type: 'share', on: true });
    if (mode === 'off') return void (await sleep(1000));
    await waitFor(() => heard.streams.length > 0);
    sayViewers(1);
    await waitFor(() => frames().length > 2);
    sayViewers(0);
  } finally {
    heard.watched = true;
  }
}

/** The test stopped: paused on the run page, then the editor stops sharing, and the test goes on. */
async function onStopped(stop: number): Promise<void> {
  if (mode === 'on') {
    await waitFor(() => heard.posts.some((p) => p.message.type === 'stop' && p.message.stop !== null));
    tell({ type: 'share', on: false });
    await waitFor(() => heard.posts.some((p) => p.message.type === 'unshared'));
    await waitFor(() => heard.streams.every((s) => s.closed));
    await waitFor(() => heard.lives[heard.lives.length - 1]?.on === false);
    heard.afterUnshare = heard.liveRequests;
  }
  tell({ type: 'control', action: 'resume', stop });
}

function write(project: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

async function runSuite(which: Mode, socketPath: string): Promise<void> {
  mode = which;
  heard = fresh();
  const project = path.join(projects, which);
  const spec = SPEC(server.url);
  const line = spec.split('\n').findIndex((l) => l.endsWith('// bp')) + 1;
  write(project, 'tests/share.spec.cjs', spec);
  write(
    project,
    'fixture.cjs',
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  write(
    project,
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
const { wrapConfig } = require(${JSON.stringify(dist)});
module.exports = wrapConfig(defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60000,
  workers: 1,
  reporter: 'line',
  use: { headless: true, viewport: { width: 1280, height: 720 }, trace: 'off' },
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'live-view-share-spec', streamingBatchDelay: 50 });
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PROJECT_NAME', 'PIWI_LIVE_VIEW']) {
    delete env[name];
  }
  for (const name of ['PIWI_RECORD_CHANNEL', 'PIWI_EDITOR_SEND']) delete env[name];
  // A run outside CI: no variable a CI provider sets is left.
  for (const name of Object.keys(env)) if (detectCi({ [name]: env[name] })) delete env[name];
  Object.assign(env, {
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
    PIWI_PAUSE_AT: `tests/share.spec.cjs:${line}`,
  });
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
  run.heard = heard;
  for (const stream of heard.streams) stream.res.end();
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-share-'));
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((socket) => {
    editor = socket;
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunToHub(line);
          if (message?.type === 'live') heard.lives.push(message);
          if (message?.type === 'stopped') void onStopped(message.stop);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));

  server = await startServer((req, res) => {
    const route = new URL(req.url, 'http://x').pathname;
    if (route === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
    }
    if (route === '/ready') {
      void onReady();
      return res.end();
    }
    if (route === '/watched') return jsonRes(res, 200, { done: heard.watched });
    if (route === '/api/test-runs/setup') {
      heard.setups.push(JSON.parse(req.body) as Record<string, unknown>);
      return jsonRes(res, 200, {
        success: true,
        runId: RUN,
        projectId: 1,
        setupToken: 'setup-token',
        ...(mode === 'on' && heard.setups[heard.setups.length - 1]?.liveView === true
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
        const stream = { res, closed: false };
        res.on('close', () => (stream.closed = true));
        heard.streams.push(stream);
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

  await runSuite('on', socketPath);
  await runSuite('off', socketPath);
}, 300_000);

afterAll(async () => {
  editor?.destroy();
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  await server?.close();
  fs.rmSync(projects, { recursive: true, force: true });
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
});

describe('Share live of a run outside CI', () => {
  it('lets the test pass, the run asking for a key that its worker holds, saying the run can be shared', () => {
    const { on } = runs;
    expect(on.exitCode, on.output).toBe(0);
    expect(on.heard.setups[0]).toMatchObject({ projectName: 'live-view-share-spec', liveView: true });
    expect(on.output).toContain('Live view ready');
    expect(on.output).not.toContain('Live view on');
    expect(on.heard.lives[0]).toEqual({
      type: 'live',
      can: true,
      on: false,
      viewers: 0,
      page: `${server.url}/test-runs/${RUN}`,
      why: null,
    });
  });

  it('sends the instance nothing until the editor shares the run, then streams while someone watches', () => {
    const { heard: run } = runs.on;
    expect(run.beforeShare).toBe(0);
    expect(run.streams.length).toBe(1);
    const sent = run.posts.filter((p) => p.message.type === 'frame' && 'data' in p.message);
    expect(sent.length).toBeGreaterThan(2);
    expect(run.lives.some((l) => l.on && l.viewers === 1)).toBe(true);
  });

  it('shows the stop it holds as paused, and once the editor stops sharing, the viewers hear why and nothing more goes', () => {
    const { heard: run } = runs.on;
    const stop = run.posts.find((p) => p.message.type === 'stop' && p.message.stop !== null);
    expect(stop?.message).toMatchObject({
      type: 'stop',
      stop: { reason: 'breakpoint', call: { file: 'tests/share.spec.cjs' }, test: 'shared while it runs' },
    });
    const unshared = run.posts.findIndex((p) => p.message.type === 'unshared');
    expect(unshared).toBeGreaterThan(run.posts.indexOf(stop!));
    expect(run.posts.slice(unshared + 1)).toEqual([]);
    expect(run.liveRequests).toBe(run.afterUnshare);
    expect(run.lives[run.lives.length - 1]).toMatchObject({ can: true, on: false, viewers: 0 });
  });

  it('says why a run of a project with the live view off cannot be shared, and sends nothing when asked anyway', () => {
    const { off } = runs;
    expect(off.exitCode, off.output).toBe(0);
    expect(off.heard.setups[0]).toMatchObject({ liveView: true });
    expect(off.heard.liveRequests).toBe(0);
    expect(off.heard.lives).toEqual([
      { type: 'live', can: false, on: false, viewers: 0, page: null, why: LIVE_SHARE_MISSING.off },
    ]);
    expect(off.output).not.toContain('Live view ready');
  });
});
