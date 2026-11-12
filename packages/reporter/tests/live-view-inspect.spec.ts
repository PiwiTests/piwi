import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIVE_FRAME_TYPE,
  LIVE_WORKER_POST_LIMITS,
  decodeLiveMessage,
  readLiveWorkerPost,
  type LiveWorkerPost,
  type LiveWorkerSnapshot,
} from '@piwitests/core/live-view';
import { INSPECT_TRACES_ITSELF } from '../src/internal/capture/live-inspect.js';
import { jsonRes, startServer, type FakeServer, withoutCi } from './_helpers.js';

/**
 * Inspect on the team's live view, in a real run outside CI shared from its start (`PIWI_SHARE_LIVE`) through the built
 * package, against a fake instance. A project the runner traces: nothing goes until a viewer opens Inspect; then the
 * page's snapshots since its last navigation, then each new call's, each stylesheet, font and image they name once and
 * never a script nor an SVG, never a secret the test typed or the page showed; nothing once Inspect closes, and why
 * none goes while the project masks elements. A project the runner does not trace: Piwi's own live trace while
 * Inspect is open, stopped and deleted as it closes, the response bodies it wrote with it, and the test's own
 * `tracing.start` going through meanwhile, whether Piwi's trace starts, runs or stops, its archive whole.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.live-view-inspect-${process.pid}`);
const RUN = 46;
const KEY = `pdl_${'i'.repeat(43)}`;
const SECRET = 'S3cr3t!Pw-9x';
const CARD = '4111111111111111';
const CSRF = 'q8Zt3kPLm2xR';
const LINK_TOKEN = 'rT5vB2nQ9wLk';
const TOKEN_BODY = '{"accessToken":"tok-S3CRET-123"}';
/** The file Playwright writes the token's response body to under a trace folder's `resources/`. */
const TOKEN_FILE = `${createHash('sha1').update(TOKEN_BODY).digest('hex')}.json`;
const requireHere = createRequire(import.meta.url);

const SHOP = `<!doctype html><html><head><meta charset="utf-8"><title>shop</title>
<meta name="csrf-token" content="${CSRF}">
<link rel="stylesheet" href="/app.css">
<script src="/app.js"></script>
</head><body>
<img src="/logo.png" alt="logo"><img src="/icon.svg" alt="icon"><img src="/fake.png" alt="fake">
<a id="reset" href="/reset?token=${LINK_TOKEN}">Reset</a>
<label>Password <input type="password" id="pw"></label>
<label>Card <input autocomplete="cc-number" id="cc"></label>
<button id="go" onclick="document.getElementById('out').textContent = document.getElementById('pw').value">Go</button>
<div id="out"></div>
</body></html>`;
const APP_CSS =
  '@import "/extra.css"; @font-face { font-family: Shop; src: url("/font.woff2") } body { font-family: Shop }';
const EXTRA_CSS = 'body { background: url("/bg.png") }';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const BG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
const ASSETS: Record<string, { type: string; body: string | Buffer }> = {
  '/shop': { type: 'text/html; charset=utf-8', body: SHOP },
  '/app.css': { type: 'text/css', body: APP_CSS },
  '/extra.css': { type: 'text/css', body: EXTRA_CSS },
  '/app.js': { type: 'application/javascript', body: 'window.shopScript = true;' },
  '/logo.png': { type: 'image/png', body: PNG },
  '/bg.png': { type: 'image/png', body: BG },
  '/icon.svg': { type: 'image/svg+xml', body: SVG },
  '/font.woff2': { type: 'font/woff2', body: Buffer.from('wOF2 not really a font') },
  '/fake.png': { type: 'image/png', body: SVG },
  '/token.json': { type: 'application/json', body: TOKEN_BODY },
};

const TRACED = (base: string) => `const { test } = require('../fixture.cjs');
test('traced', async ({ page }) => {
  await page.goto('${base}/shop');
  await page.locator('#pw').fill('${SECRET}');
  await page.locator('#cc').fill('${CARD}');
  await page.locator('#go').click();
  await fetch('${base}/m/traced/watch');
  await page.waitForTimeout(1200);
  await fetch('${base}/m/traced/inspect');
  await page.waitForTimeout(2500);
  await fetch('${base}/m/traced/live');
  await page.getByRole('button', { name: 'Go' }).click();
  await page.waitForTimeout(1500);
  await fetch('${base}/m/traced/mask');
  await page.waitForTimeout(800);
  await page.locator('#out').click();
  await page.waitForTimeout(800);
  await fetch('${base}/m/traced/unmask');
  await page.waitForTimeout(1500);
  await fetch('${base}/m/traced/uninspect');
  await page.waitForTimeout(800);
  await fetch('${base}/m/traced/closed');
  await page.locator('#go').click();
  await page.waitForTimeout(1200);
  await fetch('${base}/m/traced/unwatch');
});
`;

const OWN = (base: string) => `const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('../fixture.cjs');
const own = (context) => fs.readdirSync(context.tracing._tracesDir).filter((name) => name.startsWith('piwi-inspect-'));
const resources = (context) => {
  try {
    return fs.readdirSync(path.join(context.tracing._tracesDir, 'resources')).sort();
  } catch {
    return [];
  }
};
const token = () => fetch('/token.json', { cache: 'no-store' }).then((response) => response.text());
const tell = (what, value) => fetch('${base}/m/own/' + what + '?value=' + encodeURIComponent(JSON.stringify(value)));
test('own', async ({ page, context }, testInfo) => {
  await page.goto('${base}/shop');
  await fetch('${base}/m/own/watch');
  await tell('resources-before', resources(context));
  await fetch('${base}/m/own/inspect');
  await page.waitForTimeout(1200);
  await page.evaluate(token);
  await page.locator('#pw').fill('${SECRET}');
  await page.locator('#go').click();
  await page.waitForTimeout(1500);
  await tell('while-open', own(context));
  await tell('resources-open', resources(context));
  await fetch('${base}/m/own/uninspect');
  await page.waitForTimeout(800);
  await tell('after-close', own(context));
  await tell('resources-after', resources(context));
  await fetch('${base}/m/own/inspect');
  await page.waitForTimeout(1200);
  await tell('reopened', own(context));
  await context.tracing.start({ snapshots: true });
  await page.evaluate(token);
  await page.locator('#go').click();
  const archive = testInfo.outputPath('mine.zip');
  await context.tracing.stop({ path: archive });
  const saved = fs.existsSync(archive);
  await tell('mine', { saved, own: own(context), token: saved && fs.readFileSync(archive).includes('${TOKEN_FILE}') });
  await fetch('${base}/m/own/unwatch');
});
`;

/** The test's own trace started and stopped as Piwi's own trace starts and as it stops, each step a few ms apart. */
const RACE = (base: string) => `const { test } = require('../fixture.cjs');
test('race', async ({ page, context }) => {
  await page.goto('${base}/shop');
  await fetch('${base}/m/race/watch');
  const errors = [];
  const own = async (side, i) => {
    try {
      await context.tracing.start({ snapshots: true });
      await context.tracing.stop();
    } catch (error) {
      errors.push(side + ' ' + i + ': ' + String(error.message).split('\\n')[0]);
    }
  };
  for (let i = 0; i < 5; i++) {
    await fetch('${base}/m/race/inspect');
    await page.waitForTimeout(900);
    await fetch('${base}/m/race/uninspect');
    await new Promise((resolve) => setTimeout(resolve, i * 4));
    await own('as it stops', i);
  }
  for (let i = 0; i < 5; i++) {
    await fetch('${base}/m/race/inspect');
    await new Promise((resolve) => setTimeout(resolve, i * 4));
    await own('as it starts', i);
    await page.waitForTimeout(600);
    await fetch('${base}/m/race/uninspect');
    await page.waitForTimeout(600);
  }
  await fetch('${base}/m/race/report?value=' + encodeURIComponent(JSON.stringify(errors)));
  await fetch('${base}/m/race/unwatch');
});
`;

type Post = { at: number; test: string | null; message: LiveWorkerPost | { type: 'refused-post'; why: string } };

let server: FakeServer;
const streams: http.ServerResponse[] = [];
const posts: Post[] = [];
const bodies: Buffer[] = [];
const moments = new Map<string, number>();
const told = new Map<string, unknown>();
let run = { exitCode: null as number | null, output: '' };

/** When the test reached `name`: Infinity when it never did. */
const moment = (name: string) => moments.get(`${current}:${name}`) ?? Infinity;
/** The test whose moments `moment` reads. */
let current = 'traced';

function say(message: Record<string, unknown>): void {
  for (const res of streams) if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`);
}

const VIEW = { type: 'view', width: 640, height: 400, fps: 4, full: true, layers: [] };

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** The posts of the test `test` of the type `type`. */
function of<T extends LiveWorkerPost['type']>(test: string, type: T) {
  return posts.filter((post) => post.test === test && post.message.type === type) as Array<{
    at: number;
    test: string;
    message: Extract<LiveWorkerPost, { type: T }>;
  }>;
}

const snapshotsOf = (test: string) =>
  of(test, 'snapshot').filter(
    (post): post is { at: number; test: string; message: LiveWorkerSnapshot } => 'snapshot' in post.message,
  );

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  let testNow = 'traced';
  server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    const asset = ASSETS[route];
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      return res.end(asset.body);
    }
    const at = /^\/m\/(traced|own|race)\/([a-z-]+)$/.exec(route);
    if (at) {
      const [, test, name] = at as unknown as [string, string, string];
      testNow = test;
      moments.set(`${testNow}:${name}`, Date.now());
      const value = url.searchParams.get('value');
      if (value !== null) told.set(`${testNow}:${name}`, JSON.parse(value));
      if (name === 'watch') say({ type: 'viewers', count: 1 });
      if (name === 'inspect' || name === 'unmask') say({ ...VIEW, inspect: true });
      if (name === 'unmask') say({ type: 'masks', locators: [] });
      if (name === 'mask') say({ type: 'masks', locators: ["getByLabel('Card')"] });
      if (name === 'uninspect') say({ ...VIEW, inspect: false });
      if (name === 'unwatch') say({ type: 'viewers', count: 0 });
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
        res.write(`data: ${JSON.stringify({ type: 'masks', locators: [] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...VIEW, inspect: false })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'viewers', count: 0 })}\n\n`);
        streams.push(res);
        return;
      }
      bodies.push(req.bytes);
      if (!(req.headers['content-type'] ?? '').startsWith(LIVE_FRAME_TYPE)) return jsonRes(res, 200, { success: true });
      const message = decodeLiveMessage(new Uint8Array(req.bytes), LIVE_WORKER_POST_LIMITS);
      const read = typeof message === 'string' ? message : readLiveWorkerPost(message);
      if (typeof read === 'string') {
        posts.push({ at: Date.now(), test: testNow, message: { type: 'refused-post', why: read } });
        return jsonRes(res, 400, { message: read });
      }
      if (read.type !== 'frame' && read.type !== 'thumb') posts.push({ at: Date.now(), test: testNow, message: read });
      return jsonRes(res, 200, { success: true });
    }
    if (route.startsWith('/api/')) return jsonRes(res, 200, { success: true });
    res.writeHead(404);
    res.end();
  });
  write('tests/traced.spec.cjs', TRACED(server.url));
  write('tests/own.spec.cjs', OWN(server.url));
  write('tests/race.spec.cjs', RACE(server.url));
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
  timeout: 60000,
  workers: 1,
  reporter: [['line']],
  use: { headless: true, viewport: { width: 1280, height: 720 } },
  projects: [
    { name: 'traced', testMatch: 'traced.spec.cjs', use: { trace: 'on' } },
    { name: 'own', testMatch: 'own.spec.cjs', use: { trace: 'off' }, dependencies: ['traced'] },
    { name: 'race', testMatch: 'race.spec.cjs', use: { trace: 'off' }, dependencies: ['own'] },
  ],
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'live-view-inspect-spec', streamingBatchDelay: 50 });
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, PIWI_SHARE_LIVE: '1', PIWI_EDITOR: 'off' };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_API_KEY', 'PIWI_PROJECT_NAME', 'PIWI_LIVE_VIEW']) {
    delete env[name];
  }
  for (const name of ['PIWI_RUN_CHANNEL', 'PIWI_EDITOR_SEND', 'PIWI_RECORD_CHANNEL', 'PIWI_PAUSE_AT']) delete env[name];
  withoutCi(env);
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [requireHere.resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 200_000 },
      (error, stdout, stderr) => {
        run = { exitCode: error ? ((error as { code?: number }).code ?? 1) : 0, output: `${stdout}\n${stderr}` };
        resolve();
      },
    );
  });
  for (const res of streams) res.end();
}, 240_000);

afterAll(async () => {
  await server?.close();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('Inspect on the team’s live view, of a project the runner traces', () => {
  it('lets the tests pass, as without it', () => {
    expect(run.exitCode, run.output).toBe(0);
    expect(posts.filter(({ message }) => message.type === 'refused-post')).toEqual([]);
  });

  it('sends nothing until a viewer opens Inspect', () => {
    current = 'traced';
    expect(moment('watch')).toBeLessThan(Infinity);
    const early = posts.filter(({ test, at }) => test === 'traced' && at < moment('inspect'));
    expect(early).toEqual([]);
  });

  it('sends the page’s snapshots since its last navigation first, then each new call’s, numbered in their frame', () => {
    current = 'traced';
    const snapshots = snapshotsOf('traced').filter(({ at }) => at < moment('mask'));
    expect(snapshots.length, JSON.stringify(snapshots.map(({ message }) => message))).toBeGreaterThanOrEqual(8);
    const [first] = snapshots;
    // The navigation's full snapshot of the main frame, not the blank page's before it.
    expect(first!.message.snapshot).toMatchObject({ main: true, full: true, phase: 'after' });
    const backlog = snapshots.filter(({ at }) => at < moment('live'));
    const titles = backlog.map(({ message }) => message.snapshot.title);
    expect(titles.some((title) => title.startsWith('Fill'))).toBe(true);
    expect(titles.some((title) => title.startsWith('Click'))).toBe(true);
    const phases = new Set(backlog.map(({ message }) => message.snapshot.phase));
    expect([...phases].sort()).toEqual(['action', 'after', 'before']);
    // The click made once Inspect was open goes after the backlog, its snapshots as they come.
    const later = snapshots.filter(({ at }) => at >= moment('live'));
    expect(later.length).toBeGreaterThanOrEqual(2);
    const backlogCalls = new Set(backlog.map(({ message }) => message.snapshot.call));
    const click = later.filter(
      ({ message }) => message.snapshot.title.startsWith('Click') && !backlogCalls.has(message.snapshot.call),
    );
    expect(click.map(({ message }) => message.snapshot.phase)).toEqual(['before', 'action', 'after']);
    const indexes = snapshots.map(({ message }) => message.snapshot.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(snapshots.every(({ message }) => message.test === 'traced')).toBe(true);
  });

  it('sends each stylesheet, font and image a snapshot names once, never a script, an SVG nor bytes of another kind', () => {
    const resources = of('traced', 'resource').map(({ message }) => message.resource);
    const types = resources.map((resource) => resource.contentType).sort();
    expect(types).toEqual(['font/woff2', 'image/png', 'image/png', 'text/css', 'text/css']);
    expect(new Set(resources.map((resource) => resource.sha1)).size).toBe(resources.length);
    const sent = new Map(of('traced', 'resource').map(({ message }) => [message.resource.sha1, message.data]));
    const css = [...sent.values()].map((data) => Buffer.from(data).toString('utf8'));
    expect(css).toContain(APP_CSS);
    expect(css).toContain(EXTRA_CSS);
    const named = snapshotsOf('traced').flatMap(({ message }) => message.snapshot.resources);
    for (const asset of ['/app.css', '/extra.css', '/font.woff2', '/logo.png', '/bg.png']) {
      const one = named.find((resource) => resource.url.endsWith(asset));
      expect(one, asset).toBeDefined();
      expect(sent.has(one!.sha1), asset).toBe(true);
    }
    expect(named.some((resource) => /\.(?:js|svg)$|\/fake\.png$/.test(resource.url))).toBe(false);
    for (const data of sent.values())
      expect(Buffer.from(data).toString('utf8').trimStart().startsWith('<')).toBe(false);
  });

  it('never sends a secret the test typed or the page showed, nor a credential its markup holds', () => {
    const all = Buffer.concat(bodies);
    expect(all.includes(SECRET)).toBe(false);
    expect(all.includes(CARD)).toBe(false);
    expect(all.includes(CSRF)).toBe(false);
    expect(all.includes(LINK_TOKEN)).toBe(false);
    const out = snapshotsOf('traced').map(({ message }) => Buffer.from(message.data).toString('utf8'));
    expect(out.some((json) => json.includes('"id":"out"},"<hidden>"'))).toBe(true);
  });

  it('says why no snapshot goes while the project masks elements, and sends them again once it does not', () => {
    current = 'traced';
    const refusals = of('traced', 'snapshot').filter(({ message }) => 'refused' in message);
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    expect(refusals.every(({ at }) => at >= moment('mask'))).toBe(true);
    expect((refusals[0]!.message as { refused: string }).refused).toMatch(/masks elements/);
    const masked = snapshotsOf('traced').filter(({ at }) => at >= moment('mask') + 300 && at < moment('unmask'));
    expect(masked).toEqual([]);
    const again = snapshotsOf('traced').filter(({ at }) => at >= moment('unmask') && at < moment('uninspect'));
    expect(again[0]?.message.snapshot).toMatchObject({ main: true, full: true });
  });

  it('sends nothing once Inspect closes', () => {
    current = 'traced';
    expect(moment('closed')).toBeLessThan(Infinity);
    const late = posts.filter(({ test, at }) => test === 'traced' && at >= moment('closed'));
    expect(late).toEqual([]);
  });
});

describe('Inspect on the team’s live view, of a project the runner does not trace', () => {
  it('sends the snapshots of Piwi’s own live trace while Inspect is open', () => {
    current = 'own';
    const snapshots = snapshotsOf('own').filter(({ at }) => at < moment('uninspect'));
    expect(snapshots.length, JSON.stringify(of('own', 'snapshot'))).toBeGreaterThanOrEqual(3);
    expect(snapshots.some(({ message }) => message.snapshot.title.startsWith('Click'))).toBe(true);
    expect(told.get('own:while-open')).toEqual(expect.arrayContaining([expect.stringMatching(/\.trace$/)]));
  });

  it('stops it unsaved and deletes it as Inspect closes, with the response bodies it wrote', () => {
    expect(told.get('own:after-close')).toEqual([]);
    expect(told.get('own:resources-open')).toContain(TOKEN_FILE);
    expect(told.get('own:resources-after')).toEqual(told.get('own:resources-before'));
  });

  it('gives way to the test’s own tracing, whose archive is saved whole, and says why no more comes', () => {
    current = 'own';
    expect(told.get('own:reopened')).toEqual(expect.arrayContaining([expect.stringMatching(/\.trace$/)]));
    expect(told.get('own:mine')).toEqual({ saved: true, own: [], token: true });
    const refusals = of('own', 'snapshot').filter(
      ({ at, message }) => 'refused' in message && at >= moment('reopened'),
    );
    expect(refusals.map(({ message }) => (message as { refused: string }).refused)).toContain(INSPECT_TRACES_ITSELF);
  });

  it('lets the test’s own tracing start whether Piwi’s starts, runs or stops', () => {
    expect(told.get('race:report')).toEqual([]);
  });
});
