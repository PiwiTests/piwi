import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { startServer, type FakeServer, withoutCi } from './_helpers.js';

/**
 * What watching a running test costs its worker, in a real Playwright run through the built package: one worker runs
 * the same test on the same pages twice, unwatched, then with a fake editor service watching its lane (`view-lane`),
 * as Piwi Picker's Runs window does when a person clicks Watch on a running row. Each test measures its worker's CPU
 * time (`process.cpuUsage`) over the same stretch of wall time, on a page that paints all the time, then on one that
 * also shows a typed password field, which every image is masked for. The watched test's CPU time stays within its
 * page's `BUDGET_MS_PER_S` of the unwatched one's, per second of the stretch.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-lane-cpu-${process.pid}`);
const REF = 'ed-c9ac9ac9';
const TOKEN = 'run-lane-cpu-token-0123456789';
const requireHere = createRequire(import.meta.url);
const VIEWPORT = { width: 1000, height: 640 };
/** How long each test lets a page settle, the lane view opening on it, before it measures. */
const SETTLE_MS = 500;
/** How long each test measures on each page. */
const MEASURE_MS = 3000;
/**
 * The most CPU time watching adds to the worker, in ms a second of the measured stretch, by page. On a 4-core Linux
 * machine, idle or with every core kept busy by other processes, it measured at most 160 on the painting page (10
 * frames a second) and 350 on the masked page (2 images a second at most, each decoded, painted and encoded again at
 * 1000 by 640 pixels); masking every image the masked page paints measured 840 to 920.
 */
const BUDGET_MS_PER_S = { animated: 400, masked: 600 } as const;

/** A page that paints all the time. */
const ANIMATED = `<!doctype html><meta charset="utf-8"><style>body { margin: 0; font: 16px sans-serif }
#spin { position: absolute; left: 300px; top: 200px; width: 80px; height: 80px; background: linear-gradient(red, blue); animation: s 1s linear infinite } @keyframes s { to { transform: rotate(360deg) } }</style>
<h1 style="position:absolute;left:40px;top:40px">Shop</h1><div id="spin"></div>`;
/** The same page with a password field, its value typed in: every image of it that goes is masked. */
const MASKED = ANIMATED.replace(
  '<div id="spin">',
  '<input type="password" value="hunter2" style="position:absolute;left:40px;top:400px;width:300px;height:40px"><div id="spin">',
);

const SPEC = (base: string) => `const fs = require('node:fs');
const { test } = require('../fixture.cjs');
/** The worker's CPU time over ${MEASURE_MS} ms on \`route\`, in ms, with the wall time it took. */
async function measure(page, route) {
  await page.goto('${base}' + route);
  await page.waitForTimeout(${SETTLE_MS});
  const wall = performance.now();
  const cpu = process.cpuUsage();
  await page.waitForTimeout(${MEASURE_MS});
  const used = process.cpuUsage(cpu);
  return { cpuMs: (used.user + used.system) / 1000, wallMs: performance.now() - wall };
}
for (const title of ['unwatched', 'watched']) {
  test(title, async ({ page }) => {
    const animated = await measure(page, '/animated');
    const masked = await measure(page, '/masked');
    fs.writeFileSync(require('node:path').join(__dirname, '..', title + '.json'), JSON.stringify({ animated, masked }));
  });
}
`;

const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) { this.tests.push({ title: test.title, status: result.status }); }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

type Measured = Record<'animated' | 'masked', { cpuMs: number; wallMs: number }>;

let server: FakeServer;
let hub: net.Server;
let folder = '';
let socket: net.Socket | null = null;
const heard: RunToHub[] = [];
/** The test the worker runs, by Playwright's id. */
const titles: Record<string, string> = {};
/** How many lane frames the editor heard of each test, by title. */
const frames: Record<string, number> = {};
let tests: Array<{ title: string; status: string }> = [];
let measured: Record<'unwatched' | 'watched', Measured> | null = null;
let output = '';

let requests = 0;
function ask(message: Record<string, unknown> & { what: string }): void {
  socket!.write(`${JSON.stringify({ type: 'request', request: ++requests, ...message } as HubToRun)}\n`);
}

/** The editor's side: the lane watched from the end of the unwatched test on. */
function onMessage(message: RunToHub): void {
  if (message.type === 'test-begin') titles[message.testId] = message.title[message.title.length - 1]!;
  if (message.type === 'test-end' && titles[message.testId] === 'unwatched') ask({ what: 'view-lane', on: true });
  if (message.type === 'lane-frame' && 'data' in message && message.test) {
    const title = titles[message.test]!;
    frames[title] = (frames[title] ?? 0) + 1;
  }
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

const read = (file: string) => JSON.parse(fs.readFileSync(path.join(project, file), 'utf8'));

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-lane-cpu-'));
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
          onMessage(message);
        },
        () => connection.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));
  server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(new URL(req.url, 'http://x').pathname === '/masked' ? MASKED : ANIMATED);
  });
  write('tests/cpu.spec.cjs', SPEC(server.url));
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
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 30000,
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  use: { headless: true, viewport: ${JSON.stringify(VIEWPORT)} },
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
  const results = path.join(project, 'results.json');
  tests = fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [];
  if (tests.every((t) => t.status === 'passed')) {
    measured = { unwatched: read('unwatched.json'), watched: read('watched.json') };
  }
}, 120_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  socket?.destroy();
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

describe('the CPU time watching a running test costs its worker', () => {
  it('runs the test unwatched, then watched, its lane’s frames going only while watched', () => {
    expect(
      tests.map((t) => [t.title, t.status]),
      output,
    ).toEqual([
      ['unwatched', 'passed'],
      ['watched', 'passed'],
    ]);
    expect(frames.unwatched ?? 0).toBe(0);
    // Ten frames a second at most on the painting page, two on the masked one: more than one a second in all.
    expect(frames.watched ?? 0).toBeGreaterThan((2 * MEASURE_MS) / 1000);
  });

  it.each(['animated', 'masked'] as const)(
    'adds at most its budget of CPU time to the worker while watched, on the %s page',
    (page) => {
      const { unwatched, watched } = measured!;
      const perSecond = (m: { cpuMs: number; wallMs: number }) => (m.cpuMs * 1000) / m.wallMs;
      const added = perSecond(watched[page]) - perSecond(unwatched[page]);
      expect(added, JSON.stringify(measured)).toBeLessThanOrEqual(BUDGET_MS_PER_S[page]);
    },
  );
});
