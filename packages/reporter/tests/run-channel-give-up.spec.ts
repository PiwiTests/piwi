import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { playwrightAtLeast, startServer, type FakeServer, withoutCi } from './_helpers.js';

/**
 * End the test while a Pause waits for its call, in a real Playwright run through the built package: a fake editor
 * service on the run channel pauses each test until it hears the test wait in its long call (`waiting`), answering a
 * stop the Pause reaches first with Resume, and ends the test there (`give-up`). A locator call that carries the end
 * signal is given up at once; a wait that does not is let finish, the test skipped at its next locator call. The
 * page's button tells the server when it is clicked.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-channel-give-up-${process.pid}`);
const REF = 'ed-0e0d0e0e';
const TOKEN = 'run-channel-give-up-token-012345';

const PAGE = `<!doctype html><title>a</title><h1>A</h1><button>Go</button>
<script>document.querySelector('button').addEventListener('click', () => fetch('/clicked'));</script>`;

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('waits on a locator', async ({ page }) => {
  await page.goto('${base}/a');
  await page.getByRole('button', { name: 'Never' }).click({ timeout: 20000 }); // waits
  await fetch('${base}/body?title=waits on a locator');
});
test('waits in a timeout', async ({ page }) => {
  await page.goto('${base}/a');
  await page.waitForTimeout(1500); // waits
  await page.getByRole('button', { name: 'Go' }).click();
});
test('moves between waits', async ({ page }) => {
  await page.goto('${base}/a');
  await page.waitForTimeout(1000); // first wait
  await page.waitForTimeout(1500); // second wait
  await expect(page.getByRole('heading', { name: 'A' })).toBeVisible(); // stops
});
`;

let server: FakeServer;
let hub: net.Server;
let folder = '';
const heard: RunToHub[] = [];
const sockets: net.Socket[] = [];
let output = '';
let elapsedMs = 0;
/** The test running now, the titles of the tests, those heard waiting in a long call, and those the hub ended. */
let running = '';
const titles = new Map<string, string>();
const waitedLong = new Set<string>();
const ended = new Set<string>();
/** The test the hub lets go on through its waits, to hear each call it waits in. */
const MOVES = 'moves between waits';
/** The calls the tests wait in: the click on a button that never shows, and the timeout. */
const LONG_CALL = /Never|wait/i;
const clicked: string[] = [];
const bodies: string[] = [];
const waitsAt: number[] = [];
/** The lines of the waits the test that moves on waits in, and of the call it stops at. */
const marks: Record<string, number> = {};

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-give-up-'));
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((socket) => {
    sockets.push(socket);
    const send = (message: HubToRun) => socket.write(`${JSON.stringify(message)}\n`);
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunToHub(line);
          if (!message) return;
          heard.push(message);
          // Each test is paused until it waits in its long call, and ended there.
          const pauseSoon = () => setTimeout(() => send({ type: 'control', action: 'pause' }), 300);
          if (message.type === 'test-begin') {
            running = message.testId;
            titles.set(running, message.title[message.title.length - 1] ?? '');
            pauseSoon();
          }
          if (message.type === 'stopped') {
            send({ type: 'control', action: 'resume', stop: message.stop });
            if (!waitedLong.has(running)) pauseSoon();
          }
          if (message.type === 'waiting' && LONG_CALL.test(message.title ?? '')) {
            waitedLong.add(running);
            if (titles.get(running) !== MOVES && !ended.has(running)) {
              ended.add(running);
              send({ type: 'control', action: 'give-up', testId: running });
            }
          }
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));
  server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/clicked') clicked.push('Go');
    else if (url.pathname === '/body') bodies.push(url.searchParams.get('title') ?? '');
    else {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
    }
    res.end();
  });
  const spec = SPEC(server.url);
  spec.split('\n').forEach((text, i) => {
    if (text.endsWith('// waits')) waitsAt.push(i + 1);
    const mark = /\/\/ (first wait|second wait|stops)$/.exec(text)?.[1];
    if (mark) marks[mark] = i + 1;
  });
  write('tests/give-up.spec.cjs', spec);
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
  timeout: 30000,
  workers: 1,
  reporter: [['list']],
  use: { headless: true },
});
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
  };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_RECORD_CHANNEL', 'PIWI_EDITOR_SEND', 'PIWI_PAUSE_AT']) {
    delete env[name];
  }
  withoutCi(env);
  const started = Date.now();
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 90_000 },
      (_error, stdout, stderr) => {
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  elapsedMs = Date.now() - started;
}, 120_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

const waiting = () => heard.filter((m): m is Extract<RunToHub, { type: 'waiting' }> => m.type === 'waiting');
const endOf = (title: string) => {
  const begin = heard.findIndex((m) => m.type === 'test-begin' && m.title[m.title.length - 1] === title);
  return heard.slice(begin).find((m): m is Extract<RunToHub, { type: 'test-end' }> => m.type === 'test-end');
};

describe('End the test while a Pause waits for its call', () => {
  it.skipIf(!playwrightAtLeast('1.62'))('gives up a locator call that carries the end signal, at once', () => {
    const locator = waiting().find((m) => m.title?.includes("'Never'"));
    expect(locator, output).toMatchObject({
      title: expect.stringContaining("getByRole('button', { name: 'Never' })"),
      place: { file: 'tests/give-up.spec.cjs', line: waitsAt[0] },
      endable: true,
    });
    expect(locator!.ms).toBeGreaterThanOrEqual(0);
    expect(locator!.ms).toBeLessThan(20_000);
    expect(endOf('waits on a locator')).toMatchObject({ status: 'skipped' });
    expect(bodies).not.toContain('waits on a locator');
    // Given up, not waited out: the whole run took well under the click's 20 s.
    expect(elapsedMs).toBeLessThan(20_000);
    expect(output).toContain('the call is given up, and the test is skipped');
  });

  it('lets a wait without the end signal finish, and skips the test at its next locator call', () => {
    const wait = waiting().find((m) => m.place?.line === waitsAt[1]);
    expect(wait, output).toMatchObject({ title: expect.stringMatching(/wait/i), endable: false });
    expect(endOf('waits in a timeout')).toMatchObject({ status: 'skipped' });
    expect(clicked).toEqual([]);
    expect(output).toContain('the test is skipped as the call returns');
  });

  it('says each call a Pause waits in as the test moves on, and stops at its next call that can', () => {
    const begin = heard.findIndex((m) => m.type === 'test-begin' && m.title[m.title.length - 1] === MOVES);
    const end = heard.findIndex((m, i) => i > begin && m.type === 'test-end');
    const ofTest = heard.slice(begin, end);
    const lines = ofTest.flatMap((m) => (m.type === 'waiting' && m.title ? [m.place?.line] : []));
    expect(lines, output).toContain(marks['first wait']);
    expect(lines.indexOf(marks['second wait']!)).toBeGreaterThan(lines.indexOf(marks['first wait']!));
    const stops = ofTest.filter((m) => m.type === 'stopped');
    expect(stops[stops.length - 1]).toMatchObject({
      reason: 'pause',
      place: { line: marks.stops },
    });
    expect(endOf(MOVES)).toMatchObject({ status: 'passed' });
  });
});
