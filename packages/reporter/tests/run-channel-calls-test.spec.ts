import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { withoutCi } from './_helpers.js';

/**
 * The call log of a worker's lane view goes with the test it was made in, in a real Playwright run through the built
 * package: a fake editor service on the socket the run names watches the lane's calls, and stops reading the
 * connection while the first test calls on a page that paints all the time, so the call log the worker paces waits
 * until the second test, which opens no page, runs. The log that waited goes nowhere, and a viewer that comes later in
 * the second test is sent no log of the first.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-calls-test-${process.pid}`);
const REF = 'ed-ca115ca1';
const TOKEN = 'run-calls-test-token-0123456789';
const requireHere = createRequire(import.meta.url);

/** A page that paints noise in every frame, so the lane's frames back the connection up as soon as it is not read. */
const NOISE = `<!doctype html><meta charset="utf-8"><style>body { margin: 0 }</style>
<canvas id="c" width="1280" height="720"></canvas><script>
const c = document.getElementById('c').getContext('2d');
const image = c.createImageData(1280, 720);
(function paint() {
  for (let i = 0; i < image.data.length; i++) image.data[i] = (Math.random() * 256) | 0;
  c.putImageData(image, 0, 0);
  requestAnimationFrame(paint);
})();
</script>`;

const SPEC = `const { test } = require('../fixture.cjs');
test('first', async ({ page }) => {
  await page.setContent(${JSON.stringify(NOISE)});
  const until = Date.now() + 2500;
  while (Date.now() < until) await page.evaluate(() => 1);
});
test('second', async () => {
  await new Promise((resolve) => setTimeout(resolve, 5000));
});
`;

/** When the editor stops reading the connection, after the first test began, and for how long. */
const STOP_READING_AFTER_MS = 1200;
const STOP_READING_MS = 4500;

let hub: net.Server;
let folder = '';
let socket: net.Socket | null = null;
const heard: RunToHub[] = [];
const ids: Record<string, string> = {};
let output = '';
let askedAgain = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (message: HubToRun | Record<string, unknown>) => socket!.write(`${JSON.stringify(message)}\n`);
let requests = 0;
function ask(message: Record<string, unknown>): void {
  send({ type: 'request', request: ++requests, ...message });
}

async function onMessage(message: RunToHub): Promise<void> {
  if (message.type === 'run-attach') {
    ask({ what: 'view-lane', on: true });
    send({ type: 'layers', layers: ['calls'] });
    return;
  }
  if (message.type !== 'test-begin') return;
  const title = message.title[message.title.length - 1]!;
  ids[title] = message.testId;
  if (title === 'first') {
    await sleep(STOP_READING_AFTER_MS);
    socket?.pause();
    await sleep(STOP_READING_MS);
    socket?.resume();
    return;
  }
  // A viewer that comes later, while the second test runs.
  await sleep(1500);
  ask({ what: 'view-lane', on: true });
  send({ type: 'layers', layers: ['calls'] });
  askedAgain = true;
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-calls-test-'));
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((connection) => {
    socket = connection;
    connection.setEncoding('utf8');
    connection.on('error', () => connection.destroy());
    connection.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunToHub(line);
          if (!message) return;
          heard.push(message);
          void onMessage(message).catch(() => undefined);
        },
        () => connection.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));
  fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(project, 'tests', 'calls.spec.cjs'), SPEC);
  fs.writeFileSync(
    path.join(project, 'fixture.cjs'),
    `const { test: base } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
`,
  );
  fs.writeFileSync(
    path.join(project, 'playwright.config.cjs'),
    `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 30000,
  workers: 1,
  reporter: 'list',
  use: { headless: true, viewport: { width: 1280, height: 720 } },
});
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
  };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_EDITOR_SEND', 'PIWI_RECORD_CHANNEL', 'PIWI_PAUSE_AT']) {
    delete env[name];
  }
  withoutCi(env);
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [requireHere.resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 90_000 },
      (_error, stdout, stderr) => {
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
}, 120_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  socket?.destroy();
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
});

describe('the call log of a lane’s test', () => {
  it('goes with the test it was made in, never once that test ended', () => {
    expect(ids.first && ids.second, output).toBeTruthy();
    expect(askedAgain).toBe(true);
    const calls = heard.filter((m) => m.type === 'lane-layer' && m.layer === 'calls') as Array<
      Extract<RunToHub, { type: 'lane-layer' }>
    >;
    expect(calls.filter((m) => m.test === ids.first).length).toBeGreaterThan(0);
    // The second test opens no page: no call log is of it, neither the one that waited nor one sent again.
    expect(calls.filter((m) => m.test !== ids.first)).toEqual([]);
    const ended = heard.findIndex((m) => m.type === 'test-end' && m.testId === ids.first);
    expect(ended).toBeGreaterThan(-1);
    expect(heard.slice(ended).filter((m) => m.type === 'lane-layer' && m.layer === 'calls')).toEqual([]);
  });
});
