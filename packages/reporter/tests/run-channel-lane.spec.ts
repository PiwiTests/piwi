import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { MAX_VIEW_FPS } from '@piwitests/core/run-view';
import { startServer, type FakeServer, withoutCi } from './_helpers.js';

/**
 * The lane view of a worker, in a real Playwright run through the built package: a fake editor service on the socket
 * the run names asks the worker's lane once, as Piwi Picker's Runs window does when a person clicks Watch on a running
 * row, and hears its frames through the worker's tests and its stop, plays a click at the stop through them, sees the
 * page's secret field painted over, and hears no frame once it turned the view off.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-lane-${process.pid}`);
const REF = 'ed-1a4e1a4e';
const TOKEN = 'run-lane-token-0123456789';
/** How long each test looks at its page. */
const LOOK_MS = 1200;
const requireHere = createRequire(import.meta.url);
const jpeg = (
  createRequire(requireHere.resolve('playwright-core/package.json'))('playwright-core/lib/utilsBundle') as {
    jpegjs: {
      decode(
        data: Buffer,
        options: { useTArray: true; formatAsRGBA: true },
      ): { width: number; height: number; data: Uint8Array };
    };
  }
).jpegjs;

/** A page that paints all the time, and a button at `GO`, which the click through the view presses. */
const GO = { x: 90, y: 60 };
const ANIMATED = `<!doctype html><meta charset="utf-8"><style>body { margin: 0; font: 16px sans-serif }
#go { position: absolute; left: 40px; top: 40px; width: 100px; height: 40px }
#spin { position: absolute; left: 300px; top: 200px; width: 80px; height: 80px; background: linear-gradient(red, blue); animation: s 1s linear infinite } @keyframes s { to { transform: rotate(360deg) } }</style>
<h1 style="position:absolute;left:40px;top:100px">Shop</h1><button id="go" onclick="document.querySelector('h1').textContent = 'Clicked'">Go</button><div id="spin"></div>`;
/** A page that paints nothing once loaded. */
const STILL = `<!doctype html><meta charset="utf-8"><style>body { margin: 0 }</style><h1>Still</h1>`;
/** A page with a password field at `SECRET_BOX`, its value typed in. */
const SECRET_BOX = { x: 40, y: 200, width: 300, height: 60 };
const SECRET = `<!doctype html><meta charset="utf-8"><style>body { margin: 0; background: #fff }
#secret { position: absolute; left: ${SECRET_BOX.x}px; top: ${SECRET_BOX.y}px; width: ${SECRET_BOX.width}px; height: ${SECRET_BOX.height}px; box-sizing: border-box; border: 0; padding: 0 8px; background: #0c0; color: #00f; font: 32px sans-serif }</style>
<input type="password" id="secret" value="hunter2">`;

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('first', async ({ page }) => {
  await page.goto('${base}/animated');
  await page.waitForTimeout(${LOOK_MS});
});
test('stopped', async ({ page }) => {
  await page.goto('${base}/animated');
  await expect(page.locator('#go')).toBeVisible(); // bp
  await expect(page.locator('h1')).toHaveText('Clicked');
});
test('still', async ({ page }) => {
  await page.goto('${base}/still');
  await expect(page.locator('h1')).toHaveText('Still'); // bp
});
test('second', async ({ page }) => {
  await page.goto('${base}/secret');
  await page.waitForTimeout(${LOOK_MS});
});
test('third', async ({ page }) => {
  await page.goto('${base}/animated');
  await page.waitForTimeout(${LOOK_MS});
});
`;

const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) { this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message) }); }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

type Heard = { at: number; message: RunToHub };
type LaneFrame = Extract<RunToHub, { type: 'lane-frame'; data: string }>;

let server: FakeServer;
let hub: net.Server;
let folder = '';
const heard: Heard[] = [];
let socket: net.Socket | null = null;
/** Playwright's id of each test, by title. */
const ids: Record<string, string> = {};
/** What the worker answered each request, by what it asked. */
const answers: Record<string, unknown[]> = {};
/** When the editor heard the lane view off. */
let offAt = Infinity;
/** What the stop of the still page sent: its own view's frames, and the lane's frames naming it. */
const still: { viewFrames: number; laneFrames: number } = { viewFrames: 0, laneFrames: 0 };
let tests: Array<{ title: string; status: string; errors: string[] }> = [];
let output = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(20);
  }
}

let requests = 0;
async function ask(message: Record<string, unknown> & { what: string }): Promise<unknown> {
  const request = ++requests;
  socket!.write(`${JSON.stringify({ type: 'request', request, ...message } as HubToRun)}\n`);
  const answer = await waitFor(() => heard.find(({ message: m }) => m.type === 'answer' && m.request === request));
  const value = (answer.message as { value: unknown }).value;
  (answers[message.what] ??= []).push(value);
  return value;
}

/** The test the worker runs now, as the editor heard it. */
const connectionTest = (): string | null => {
  for (let i = heard.length - 1; i >= 0; i--) {
    const m = heard[i]!.message;
    if (m.type === 'test-begin') return m.testId;
    if (m.type === 'test-end') return null;
  }
  return null;
};

const laneFrames = (test?: string) =>
  heard.filter(
    ({ message: m }) => m.type === 'lane-frame' && 'data' in m && (test === undefined || m.test === test),
  ) as Array<{ at: number; message: LaneFrame }>;

/** The editor's side: the lane view on from the worker's attach, a click at the stop, and the view off at `third`. */
async function onMessage(message: RunToHub): Promise<void> {
  if (message.type === 'run-attach') {
    await ask({ what: 'view-lane', on: true });
    return;
  }
  if (message.type === 'test-end' && message.testId === ids.first) {
    // Asked again once the test ended: nothing of the ended test goes.
    await ask({ what: 'view-lane', on: true });
    return;
  }
  if (message.type === 'test-begin') {
    ids[message.title[message.title.length - 1]!] = message.testId;
    if (message.title[message.title.length - 1] === 'third') {
      await ask({ what: 'view-lane', on: false });
      offAt = Date.now();
    }
    return;
  }
  if (message.type !== 'stopped' || message.reason === 'failure') return;
  const stop = message.stop;
  if (connectionTest() === ids.still) {
    try {
      // On a page that paints nothing, the lane's latest frame names the stop, and a view of it starts with it.
      await waitFor(() => laneFrames(ids.still).some(({ message: m }) => m.stop === stop), 3000).catch(() => null);
      await ask({ what: 'view', stop, on: true });
      await waitFor(
        () => heard.some(({ message: m }) => m.type === 'frame' && m.stop === stop && 'data' in m),
        3000,
      ).catch(() => null);
      still.viewFrames = heard.filter(({ message: m }) => m.type === 'frame' && m.stop === stop).length;
      still.laneFrames = laneFrames(ids.still).filter(({ message: m }) => m.stop === stop).length;
    } finally {
      socket!.write(`${JSON.stringify({ type: 'control', action: 'resume', stop })}\n`);
    }
    return;
  }
  try {
    // The lane view shows the stop: its frames name it, and a click through them reaches the page.
    await waitFor(() => laneFrames().some(({ message: m }) => m.stop === stop));
    await ask({
      what: 'input',
      stop,
      events: [
        { type: 'mouse', action: 'move', ...GO },
        { type: 'mouse', action: 'click', ...GO, button: 'left', clickCount: 1 },
      ],
    });
  } finally {
    socket!.write(`${JSON.stringify({ type: 'control', action: 'resume', stop })}\n`);
  }
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-lane-'));
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
          heard.push({ at: Date.now(), message });
          void onMessage(message).catch(() => undefined);
        },
        () => connection.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));
  server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const route = new URL(req.url, 'http://x').pathname;
    res.end(route === '/secret' ? SECRET : route === '/still' ? STILL : ANIMATED);
  });
  const spec = SPEC(server.url);
  write('tests/lane.spec.cjs', spec);
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
  timeout: 15000,
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  use: { headless: true, viewport: { width: 1000, height: 640 } },
});
`,
  );
  const lines = spec
    .split('\n')
    .flatMap((text, i) => (text.endsWith('// bp') ? [`tests/lane.spec.cjs:${i + 1}`] : []))
    .join(';');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
    PIWI_PAUSE_AT: lines,
  };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_EDITOR_SEND', 'PIWI_RECORD_CHANNEL']) delete env[name];
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
}, 120_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  socket?.destroy();
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

describe('the lane view of a worker', () => {
  it('lets every test pass, and says it shows its lane as it attaches', () => {
    expect(
      tests.map((t) => [t.title, t.status]),
      output,
    ).toEqual([
      ['first', 'passed'],
      ['stopped', 'passed'],
      ['still', 'passed'],
      ['second', 'passed'],
      ['third', 'passed'],
    ]);
    const attach = heard.find(({ message: m }) => m.type === 'run-attach')?.message;
    expect(attach).toMatchObject({ features: ['view-lane', 'give-up'] });
  });

  it('sends the frames of each test it runs from one request, each naming its test, at the view’s pace', () => {
    expect(answers['view-lane']?.[0]).toEqual({ ok: true, message: 'The live view is on.' });
    for (const title of ['first', 'stopped', 'second']) {
      expect(laneFrames(ids[title]).length, title).toBeGreaterThan(0);
    }
    const first = laneFrames(ids.first);
    const span = first[first.length - 1]!.at - first[0]!.at;
    expect(first.length).toBeGreaterThan(2);
    expect(first.length - 1).toBeLessThanOrEqual(Math.ceil((span / 1000) * MAX_VIEW_FPS) + 1);
    for (const { message } of first) expect(message).toMatchObject({ stop: null, width: 1000, height: 640 });
  });

  it('sends no frame between two tests, asked again or not, nor one of a test that ended', () => {
    let running: string | null = null;
    for (const { message } of heard) {
      if (message.type === 'test-begin') running = message.testId;
      if (message.type === 'test-end') running = null;
      if (message.type === 'lane-frame' && 'data' in message) expect(message.test).toBe(running);
    }
    expect(answers['view-lane']?.[1]).toEqual({ ok: true, message: 'The live view is on.' });
  });

  it('names a stop on a still page in its latest frame, which a view of the stop starts with', () => {
    expect(still.laneFrames).toBeGreaterThan(0);
    expect(still.viewFrames).toBeGreaterThan(0);
  });

  it('goes on through a stop, its frames naming it, and takes a click there through them', () => {
    const stop = heard.find(({ message: m }) => m.type === 'stopped')?.message as { stop: number };
    expect(laneFrames(ids.stopped).some(({ message: m }) => m.stop === stop.stop)).toBe(true);
    expect(answers.input?.[0]).toMatchObject({ ok: true });
    // No other view of that stop was asked: the lane's showed it.
    const viewOf = (m: RunToHub) => m.type === 'answer' && m.what === 'view';
    expect(heard.filter(({ message: m }) => viewOf(m))).toHaveLength(1);
  });

  it('paints a secret field over in every frame', () => {
    const frames = laneFrames(ids.second);
    for (const { message } of [frames[0]!, frames[frames.length - 1]!]) {
      const image = jpeg.decode(Buffer.from(message.data, 'base64'), { useTArray: true, formatAsRGBA: true });
      const scale = image.width / 1000;
      let green = 0;
      for (let y = Math.ceil(SECRET_BOX.y * scale); y < Math.floor((SECRET_BOX.y + SECRET_BOX.height) * scale); y++) {
        for (let x = Math.ceil(SECRET_BOX.x * scale); x < Math.floor((SECRET_BOX.x + SECRET_BOX.width) * scale); x++) {
          const i = (y * image.width + x) * 4;
          const [r, g, b] = [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
          if ((g > 160 && r < 100 && b < 100) || (b > 160 && r < 100 && g < 100)) green++;
        }
      }
      expect(green).toBe(0);
    }
  });

  it('sends no frame once the view is off', () => {
    expect(answers['view-lane']?.[2]).toEqual({ ok: true, message: 'The live view is off.' });
    expect(laneFrames().filter(({ at }) => at > offAt + 200)).toEqual([]);
    expect(laneFrames(ids.third)).toEqual([]);
  });
});
