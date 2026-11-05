import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunMainToHub, parseRunToHub, type RunMainToHub } from '@piwitests/core/run-channel';
import { withoutCi } from './_helpers.js';

/**
 * The run's own connection to the hub, in a real Playwright run through the built package: a fake editor service on
 * the socket the run names hears, on a connection apart from the workers', how many tests the run holds, each that
 * ended for good, and how the run ended with its first failure.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-hub-link-${process.pid}`);
const TOKEN = 'run-hub-link-token-0123456789';
const requireHere = createRequire(import.meta.url);

const SPEC = `const { test, expect } = require('../fixture.cjs');
test('passes', async () => {});
test('passes the second time', async ({}, testInfo) => {
  expect(testInfo.retry, 'the first attempt fails').toBe(1);
});
test('fails', async () => {
  expect(1, 'signed in at https://shop:hunter2@shop.example/').toBe(2);
});
test.skip('is skipped', async () => {});
`;

/** What each connection said, by the kind of its first line. */
const runs: RunMainToHub[][] = [];
let workerConnections = 0;
let hub: net.Server;
let folder = '';
let output = '';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-hub-link-'));
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    let heard: RunMainToHub[] | null = null;
    let first = true;
    socket.on(
      'data',
      lineReader(
        (line) => {
          if (first) {
            first = false;
            if (parseRunToHub(line)?.type === 'run-attach') {
              workerConnections++;
              return;
            }
            heard = [];
            runs.push(heard);
          }
          const message = parseRunMainToHub(line);
          if (heard && message) heard.push(message);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));
  write('tests/run.spec.cjs', SPEC);
  write(
    'fixture.cjs',
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  retries: 1,
  workers: 1,
  reporter: [[${JSON.stringify(dist)}, {}]],
});
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: 'ed-0a1b2c3d',
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
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
});

describe('the run’s own connection to the hub', () => {
  it('opens once, apart from the workers’, and says how many tests the run holds', () => {
    expect(runs, output).toHaveLength(1);
    expect(workerConnections).toBeGreaterThan(0);
    expect(runs[0]![0]).toMatchObject({
      type: 'run-begin',
      token: TOKEN,
      ref: 'ed-0a1b2c3d',
      cwd: project,
      total: 4,
      workers: 1,
      shard: null,
    });
  });

  it('counts each test once it ended for good, by its last attempt', () => {
    const progress = runs[0]!.filter((m) => m.type === 'run-progress');
    expect(progress.length).toBeGreaterThan(0);
    for (const [i, counts] of progress.entries()) {
      if (i > 0) expect(counts.done).toBeGreaterThanOrEqual(progress[i - 1]!.done);
    }
  });

  it('says how the run ended, its counts and its first failure, the failure’s credentials hidden', () => {
    const end = runs[0]![runs[0]!.length - 1];
    expect(end).toMatchObject({
      type: 'run-end',
      status: 'failed',
      done: 4,
      failed: 1,
      flaky: 1,
      skipped: 1,
      failure: { title: expect.stringContaining('fails') },
    });
    const error = (end as { failure: { error: string } }).failure.error;
    expect(error).toContain('shop.example');
    expect(error).not.toContain('hunter2');
  });
});
