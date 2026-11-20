import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWorkerToInstance, type WorkerToInstance } from '@piwitests/core/live-view';
import { detectCi } from '../src/internal/support/ci.js';
import { jsonRes, orError, startServer, type FakeServer } from './_helpers.js';

/**
 * The run page's live view of tests that take no page from the `page` fixture, in a real CI run through the built
 * package against a fake instance whose viewer comes once the first test runs. A serial group's `beforeAll` opens one
 * authenticated context and page per portal from `browser`, as suites with several users do: a test of the group
 * shows the page opened last until its first call, then the page each of its calls lands on, from one context to the
 * other. A test of the group that takes the `page` fixture shows that page, whatever page its calls land on.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.live-view-pages-${process.pid}`);
const RUN = 43;
const KEY = `pdl_${'k'.repeat(43)}`;
const requireHere = createRequire(import.meta.url);
/** How long a test looks at each page. */
const LOOK_MS = 2000;
/** How long after the mark before a call the view may still show the page it leaves. */
const SETTLE_MS = 300;

/** The parts of the zip reader Playwright bundles (`yauzl`) that reading a trace uses. */
interface ZipEntry {
  fileName: string;
}
interface ZipFile {
  readEntry(): void;
  on(event: 'entry', listener: (entry: ZipEntry) => void): void;
  on(event: 'end' | 'error', listener: (error?: Error) => void): void;
  openReadStream(entry: ZipEntry, callback: (error: Error | null, stream: NodeJS.ReadableStream) => void): void;
}
interface Yauzl {
  open(file: string, options: { lazyEntries: true }, callback: (error: Error | null, zip: ZipFile) => void): void;
}
const requireCore = createRequire(requireHere.resolve('playwright-core/package.json'));
const utils = requireCore('playwright-core/lib/utilsBundle') as {
  jpegjs: {
    decode(
      data: Buffer,
      options: { useTArray: true; formatAsRGBA: true },
    ): { width: number; height: number; data: Uint8Array };
  };
  yauzl?: Yauzl;
};
const jpeg = utils.jpegjs;
/** Playwright's zip reader: in its utilities bundle, or in a zip bundle of its own on an older Playwright. */
const yauzl: Yauzl = utils.yauzl ?? (requireCore('playwright-core/lib/zipBundle') as { yauzl: Yauzl }).yauzl;

/** The text of each `.trace` file of a trace's zip. */
function traceFiles(file: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const texts: string[] = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(texts));
      zip.on('entry', (entry) => {
        if (!entry.fileName.endsWith('.trace')) return zip.readEntry();
        zip.openReadStream(entry, (failed, stream) => {
          if (failed) return reject(failed);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            texts.push(Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** A portal's page, of one color, a corner of it spinning so it paints all the time. */
const PAGE = (name: string, color: string) => `<!doctype html><meta charset="utf-8"><title>${name}</title>
<style>html, body { margin: 0; height: 100%; background: ${color} }
h1 { margin: 0; padding: 20px; color: ${color}; font: 16px sans-serif }
#spin { position: absolute; right: 10px; bottom: 10px; width: 40px; height: 40px; background: #888; animation: s 1s linear infinite } @keyframes s { to { transform: rotate(360deg) } }</style>
<h1>${name}</h1><div id="spin"></div>`;

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
const mark = (name) => fetch('${base}/mark?name=' + name);
const look = () => new Promise((resolve) => setTimeout(resolve, ${LOOK_MS}));
test.describe.configure({ mode: 'serial' });
let blue;
let red;
test.beforeAll(async ({ browser }) => {
  blue = await (await browser.newContext()).newPage();
  await blue.goto('${base}/blue');
  red = await (await browser.newContext()).newPage();
  await red.goto('${base}/red');
});
test.afterAll(async () => {
  await blue.context().close();
  await red.context().close();
});
test('moves between two portals', async () => {
  await mark('opened-last');
  await look();
  await mark('to-blue');
  await expect(blue.locator('h1')).toHaveText('Blue');
  await look();
  await mark('to-red');
  await red.locator('h1').click();
  await look();
  await mark('to-wait');
  // A wait on the client, which no navigation ends: the page it waits on shows meanwhile.
  await blue.waitForEvent('framenavigated', { timeout: ${LOOK_MS} }).catch(() => undefined);
  await mark('end');
});
test('takes the page fixture', async ({ page }) => {
  await page.goto('${base}/green');
  await blue.locator('h1').click();
  await mark('fixture');
  await look();
  await mark('fixture-end');
});
`;

interface Posted {
  at: number;
  message: WorkerToInstance;
}

/** A frame the worker posted, the test it belongs to (null outside one), and its color, or why it could not be read. */
interface DecodedFrame {
  at: number;
  test: string | null;
  color: ReturnType<typeof colorOf> | Error;
}

let server: FakeServer;
/** The worker's event streams, on which the fake instance says how many people watch. */
const streams: http.ServerResponse[] = [];
const posts: Posted[] = [];
/** The frames of `posts`, each decoded once the run ended. */
const decodedFrames: DecodedFrame[] = [];
const marks: Record<string, number> = {};
let exitCode: number | null = null;
let output = '';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** The color a frame shows left of its middle, away from the heading and the spinning corner: the page's background. */
function colorOf(data: Buffer): 'blue' | 'red' | 'green' | 'other' {
  const image = jpeg.decode(data, { useTArray: true, formatAsRGBA: true });
  const x = Math.floor(image.width * 0.3);
  const y = Math.floor(image.height * 0.5);
  const at = (y * image.width + x) * 4;
  const [r, g, b] = [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!];
  if (b > 150 && r < 80 && g < 80) return 'blue';
  if (r > 150 && g < 80 && b < 80) return 'red';
  if (g > 100 && r < 80 && b < 80) return 'green';
  return 'other';
}

/** The colors of the frames of `test` posted from `from`'s mark plus the time the view may take to `to`'s mark. */
function colorsBetween(test: string, from: string, to: string): string[] {
  const start = marks[from]! + SETTLE_MS;
  const end = marks[to]!;
  return decodedFrames
    .filter((f) => f.test === test && f.at >= start && f.at < end)
    .map(({ color }) => {
      if (color instanceof Error) throw color;
      return color;
    });
}

/** The view showed `color` in these frames: from the first of that color on, every one is. */
function shows(colors: string[], color: string): void {
  const first = colors.indexOf(color);
  expect(first, `${colors.join(', ')}\n${output}`).toBeGreaterThanOrEqual(0);
  expect(new Set(colors.slice(first)), colors.join(', ')).toEqual(new Set([color]));
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    if (route === '/mark') {
      const name = url.searchParams.get('name') ?? '';
      marks[name] = Date.now();
      // Someone opens Watch while the first test runs, before its first call.
      if (name === 'opened-last') {
        for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: 'viewers', count: 1 })}\n\n`);
      }
      return res.end();
    }
    const portal = { '/blue': ['Blue', '#0000ff'], '/red': ['Red', '#ff0000'], '/green': ['Green', '#00a000'] }[route];
    if (portal) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE(portal[0]!, portal[1]!));
    }
    if (route === '/api/test-runs/setup') {
      const body = JSON.parse(req.body) as { liveView?: unknown };
      return jsonRes(res, 200, {
        success: true,
        runId: RUN,
        projectId: 1,
        setupToken: 'setup-token',
        ...(body.liveView === true ? { liveView: { key: KEY } } : {}),
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
    if (route.startsWith('/api/')) return jsonRes(res, 200, { success: true });
    res.writeHead(404);
    res.end();
  });

  write('tests/portals.spec.cjs', SPEC(server.url));
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
const { wrapConfig } = require(${JSON.stringify(dist)});
module.exports = wrapConfig(defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 30000,
  workers: 1,
  reporter: [['list']],
  use: { headless: true, viewport: { width: 1280, height: 720 }, trace: 'on' },
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'live-view-pages-spec', streamingBatchDelay: 50 });
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
        exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  for (const { at, message } of posts) {
    if (message.type === 'frame' && 'data' in message) {
      const color = orError(() => colorOf(Buffer.from(message.data, 'base64')));
      decodedFrames.push({ at, test: message.test, color });
    }
  }
}, 150_000);

afterAll(async () => {
  for (const stream of streams) stream.end();
  await server?.close();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('the live view of tests without the `page` fixture', () => {
  it('runs the suite', () => {
    expect(exitCode, output).toBe(0);
  });

  it('shows the page opened last until the first call, then the page of each call or wait, from one context to the other', () => {
    const test = 'moves between two portals';
    const openedLast = colorsBetween(test, 'opened-last', 'to-blue');
    const onBlue = colorsBetween(test, 'to-blue', 'to-red');
    const onRed = colorsBetween(test, 'to-red', 'to-wait');
    const waitingOnBlue = colorsBetween(test, 'to-wait', 'end');
    shows(openedLast, 'red');
    shows(onBlue, 'blue');
    shows(onRed, 'red');
    shows(waitingOnBlue, 'blue');
  });

  it('never tells the viewer who came mid-test that the test has no page', () => {
    const frames = posts.map((p) => p.message).filter((m) => m.type === 'frame');
    expect(frames.some((m) => 'data' in m && m.test === 'moves between two portals')).toBe(true);
    expect(frames.map((m) => ('refused' in m ? m.refused : null))).not.toContain('This test has no page to show yet.');
  });

  it('shows none of the view’s calls among the actions of the test’s trace', async () => {
    const results = path.join(project, 'test-results');
    const folder = fs.readdirSync(results).find((name) => name.includes('moves-between-two-portals'));
    expect(folder, fs.readdirSync(results).join(', ')).toBeTruthy();
    // The actions of the contexts, beside the runner's steps (`Test`).
    const actions: string[] = [];
    for (const text of await traceFiles(path.join(results, folder!, 'trace.zip'))) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as { type?: string; class?: string; method?: string };
        if (event.type === 'before' && event.class !== 'Test') actions.push(`${event.class}.${event.method}`);
      }
    }
    // The test's assertion, click and wait (its begin and end, named as each Playwright names them), and what its
    // `beforeAll` did.
    const own = ['BrowserContext.newPage', 'Frame.click', 'Frame.expect', 'Frame.goto'];
    const waits = ['Page.__waitInfo__', 'Page.waitForEventInfo'];
    expect(actions).toContain('Frame.expect');
    expect(actions).toContain('Frame.click');
    expect([...new Set(actions)].sort(), actions.join(', ')).toEqual(
      [...own, ...waits].filter((action) => actions.includes(action)).sort(),
    );
  });

  it('shows the `page` fixture of a test that takes it, whatever page its calls land on', () => {
    shows(colorsBetween('takes the page fixture', 'fixture', 'fixture-end'), 'green');
  });
});
