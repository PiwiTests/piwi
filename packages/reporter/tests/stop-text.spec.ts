import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun } from '@piwitests/core/run-channel';
import { detectCi } from '../src/internal/support/ci.js';
import { jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * A run outside CI tells the instance where its tests stand stopped, as text, while someone has the run open, in a
 * real Playwright run through the built package against a fake instance and a fake editor on the run channel. The
 * editor pauses each test; the first stops while the instance says someone watches, and its stop and its end reach the
 * instance (`test-stopped`, `test-resumed`); the second stops while nobody watches, and its stop reaches the instance
 * only once someone opens the run. The instance names the run's page under its public address (`runUrl`), which the
 * run prints and puts in its output in place of the address the reporter reached it at.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.stop-text-${process.pid}`);
const RUN = 77;
const PAGE = 'https://piwi.example.com/test-runs/77';
const REF = 'ed-5704e5704';
const TOKEN = 'stop-text-channel-token-01234567';
const requireHere = createRequire(import.meta.url);

const SPEC = `const { test, expect } = require('../fixture.cjs');
test('stops while watched', async ({ page }) => {
  await page.setContent('<h1>Shop</h1>');
  await expect(page.locator('h1')).toHaveText('Shop');
  await page.locator('h1').click();
});
test('stops while nobody watches', async ({ page }) => {
  await page.setContent('<h1>Shop</h1>');
  await expect(page.locator('h1')).toHaveText('Shop');
  await page.locator('h1').click();
});
`;

interface Event {
  at: number;
  type: string;
  title: string;
  stop?: Record<string, unknown>;
  pausedMs?: number;
}

let server: FakeServer;
let hub: net.Server;
let folder = '';
let editor: net.Socket | null = null;
let output = '';
let exitCode: number | null = null;
let metadata: Record<string, unknown> = {};
/** Whether the instance says someone watches the run, and when it last said nobody did. */
let watched = true;
let saidUnwatchedAt = 0;
const events: Event[] = [];
/** When the instance began to say someone watches the second test's stop. */
let watchedAgainAt = 0;
let stops = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined | false, ms = 20_000): Promise<T> {
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

const stoppedOf = (title: string) => events.find((e) => e.type === 'test-stopped' && e.title === title);

/** A test began: the editor pauses it, the second once the instance said nobody watches. */
async function onBegin(title: string): Promise<void> {
  if (title === 'stops while nobody watches') {
    watched = false;
    saidUnwatchedAt = 0;
    await waitFor(() => saidUnwatchedAt > 0);
  }
  tell({ type: 'control', action: 'pause' });
}

/** A test stopped: once the instance heard it (opened again for the second), the editor resumes it. */
async function onStopped(stop: number): Promise<void> {
  stops++;
  if (stops === 1) {
    await waitFor(() => stoppedOf('stops while watched'));
  } else {
    // Nobody watches: the stop stays in the run's process.
    await sleep(1500);
    watchedAgainAt = Date.now();
    watched = true;
    await waitFor(() => stoppedOf('stops while nobody watches'));
  }
  await sleep(300);
  tell({ type: 'control', action: 'resume', stop });
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-stop-text-'));
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
          if (message?.type === 'test-begin') void onBegin(message.title[message.title.length - 1] ?? '');
          if (message?.type === 'stopped') void onStopped(message.stop);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));

  server = await startServer((req, res) => {
    const route = new URL(req.url, 'http://x').pathname;
    if (route === '/api/test-runs/setup') {
      return jsonRes(res, 200, { success: true, runId: RUN, projectId: 1, setupToken: 'setup-token', runUrl: PAGE });
    }
    if (route === `/api/test-runs/${RUN}/begin`) {
      metadata = (JSON.parse(req.body) as { metadata?: Record<string, unknown> }).metadata ?? {};
      return jsonRes(res, 200, { success: true, runId: RUN, streamToken: 'stream-token', runUrl: PAGE });
    }
    if (route === `/api/test-runs/${RUN}/events`) {
      const body = JSON.parse(req.body) as { testCases?: Array<Omit<Event, 'at'>> };
      for (const event of body.testCases ?? []) events.push({ at: Date.now(), ...event });
    }
    if (route === `/api/test-runs/${RUN}/finish`) {
      return jsonRes(res, 200, { success: true, runId: RUN, status: 'passed', runUrl: PAGE });
    }
    if (!watched) saidUnwatchedAt = Date.now();
    return jsonRes(res, 200, { success: true, watched });
  });

  fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(project, 'tests', 'stop.spec.cjs'), SPEC);
  fs.writeFileSync(
    path.join(project, 'fixture.cjs'),
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  fs.writeFileSync(
    path.join(project, 'playwright.config.cjs'),
    `const { defineConfig } = require('@playwright/test');
const { wrapConfig } = require(${JSON.stringify(dist)});
module.exports = wrapConfig(defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60000,
  workers: 1,
  reporter: 'line',
  use: { headless: true, trace: 'off' },
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'stop-text-spec', streamingBatchDelay: 50 });
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PROJECT_NAME', 'PIWI_LIVE_VIEW']) {
    delete env[name];
  }
  for (const name of ['PIWI_RECORD_CHANNEL', 'PIWI_EDITOR_SEND', 'PIWI_PAUSE_AT', 'PIWI_RUN_REF']) delete env[name];
  // A run outside CI: no variable a CI provider sets is left.
  for (const name of Object.keys(env)) if (detectCi({ [name]: env[name] })) delete env[name];
  Object.assign(env, {
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
  });
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [requireHere.resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 120_000 },
      (error, stdout, stderr) => {
        exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
}, 150_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  editor?.destroy();
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

describe('a stop told as text', () => {
  it('reaches the instance as it shows and as it ends, while someone watches', () => {
    expect(exitCode, output).toBe(0);
    const stopped = stoppedOf('stops while watched');
    expect(stopped, output).toMatchObject({
      title: 'stops while watched',
      stop: { reason: 'pause', file: 'tests/stop.spec.cjs', bar: false, pausedMs: 0 },
    });
    expect(stopped!.stop!.line).toBeGreaterThan(1);
    expect(stopped!.stop!.title).toEqual(expect.any(String));
    const resumed = events.find((e) => e.type === 'test-resumed' && e.title === 'stops while watched');
    // It stood stopped at least while the instance heard it and the editor waited.
    expect(resumed?.pausedMs).toBeGreaterThanOrEqual(300);
  });

  it('reaches it only once someone opens the run, while nobody watches', () => {
    const stopped = stoppedOf('stops while nobody watches');
    expect(stopped, output).toBeDefined();
    expect(stopped!.at).toBeGreaterThanOrEqual(watchedAgainAt);
    // It names when it stopped, before anyone watched.
    expect(Number(stopped!.stop!.since)).toBeLessThan(watchedAgainAt);
  });

  it('prints the page the instance names, and records the run’s own name', () => {
    expect(output).toContain(`View live progress: ${PAGE}`);
    expect(output).not.toContain(`${server.url}/test-runs/${RUN}`);
    expect(output.split(`View live progress: ${PAGE}`)).toHaveLength(2);
    expect(metadata.piwiRunRef).toBe(REF);
  });
});
