import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIVE_FRAME_BYTE_RATE,
  LIVE_FRAME_TYPE,
  LIVE_TILE_FPS,
  LIVE_TILE_HEIGHT,
  LIVE_TILE_WIDTH,
  MAX_LIVE_FRAME,
  MAX_LIVE_VIEW_HEIGHT,
  MAX_LIVE_VIEW_WIDTH,
  decodeLiveMessage,
  readLiveWorkerFrame,
  type LiveWorkerFrame,
} from '@piwitests/core/live-view';
import { detectCi } from '../src/internal/support/ci.js';
import { jsonRes, playwrightAtLeast, startServer, type FakeServer } from './_helpers.js';

/**
 * The live view's frames as bytes, with their size from the viewers, in a real Playwright run through the built
 * package against a fake instance that says what its viewers ask (`view`). The worker posts each frame as one live
 * message (`LIVE_FRAME_TYPE`: a JSON header with its worker, call and test, then the JPEG), at the size the viewers
 * ask (the full view's, within 1280 by 800, then a tile's) and at their pace (a tile's one a second), and none once
 * nobody watches. The call log and the test's end go to a full view alone: a worker only tiles show posts neither.
 * `live-view.spec.ts` holds the run to an instance that never says `view`, which takes JSON.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.live-view-binary-${process.pid}`);
const RUN = 42;
const KEY = `pdl_${'b'.repeat(43)}`;
const requireHere = createRequire(import.meta.url);

/** A page that paints all the time, so the screencast sends frames all the time. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>shop</title>
<style>body { margin: 0; padding: 20px; font: 16px sans-serif }
#spin { width: 120px; height: 120px; background: linear-gradient(red, blue); animation: s 1s linear infinite } @keyframes s { to { transform: rotate(360deg) } }</style>
<h1>Shop</h1><div id="spin"></div>`;

const SPEC = (base: string) => `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
const test = extendPiwiFixtures(base);
test('watched in full, then as a tile', async ({ page }) => {
  await page.goto('${base}/page');
  await fetch('${base}/ready');
  await page.locator('#missing').click({ timeout: 2000 }).catch(() => {});
  await expect.poll(async () => (await (await fetch('${base}/done')).json()).done, { timeout: 30000 }).toBe(true);
});
test('watched as a tile to its end', async ({ page }) => {
  await page.goto('${base}/page');
  await fetch('${base}/tiles');
  await page.locator('#missing').click({ timeout: 2000 }).catch(() => {});
  await expect.poll(async () => (await (await fetch('${base}/tiled')).json()).done, { timeout: 30000 }).toBe(true);
});
`;

interface Posted {
  at: number;
  type: string | undefined;
  /** A frame posted as bytes, as the instance reads it; for JSON, the message's type. */
  frame: LiveWorkerFrame | string;
}

const posts: Posted[] = [];
const streams: http.ServerResponse[] = [];
/**
 * When the instance asked for the full view, then for tiles alone, then said nobody watches; then, in the next test,
 * when it asked for tiles alone until that test ended.
 */
const phases: { full?: number; tiles?: number; none?: number; tiledFrom?: number } = {};
let done = false;
let tiled = false;
let server: FakeServer;
let exitCode: number | null = null;
let output = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Say a message on every worker's stream. */
function say(message: Record<string, unknown>): void {
  for (const res of streams) if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`);
}

/** The instance watches the test: in full at the largest size, then as a tile, then not at all. */
async function onReady(): Promise<void> {
  say({ type: 'view', width: 1920, height: 1200, fps: 4, full: true });
  say({ type: 'viewers', count: 1 });
  phases.full = Date.now();
  await sleep(2500);
  say({ type: 'view', width: LIVE_TILE_WIDTH, height: LIVE_TILE_HEIGHT, fps: LIVE_TILE_FPS, full: false });
  phases.tiles = Date.now();
  await sleep(4000);
  say({ type: 'viewers', count: 0 });
  phases.none = Date.now();
  await sleep(1500);
  done = true;
}

/** The next test, watched as a tile alone until it ends, while it waits on a locator that matches nothing. */
async function onTiles(): Promise<void> {
  phases.tiledFrom = Date.now();
  say({ type: 'view', width: LIVE_TILE_WIDTH, height: LIVE_TILE_HEIGHT, fps: LIVE_TILE_FPS, full: false });
  say({ type: 'viewers', count: 1 });
  await sleep(3500);
  tiled = true;
}

/** The JSON messages posted from `from` on, by type. */
function json(from: number): string[] {
  return posts.flatMap((p) => (p.at >= from && typeof p.frame === 'string' ? [p.frame] : []));
}

/** A JPEG's size in pixels, from its first frame header; null for none. */
function jpegSize(data: Uint8Array): { width: number; height: number } | null {
  const bytes = Buffer.from(data);
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/** The frames posted from `from` to `to`, read as the instance reads them. */
function frames(from: number, to: number): LiveWorkerFrame[] {
  return posts.flatMap((p) => (p.at >= from && p.at < to && typeof p.frame !== 'string' ? [p.frame] : []));
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  server = await startServer((req, res) => {
    const route = new URL(req.url, 'http://x').pathname;
    if (route === '/ready') {
      void onReady();
      return res.end();
    }
    if (route === '/done') return jsonRes(res, 200, { done });
    if (route === '/tiles') {
      void onTiles();
      return res.end();
    }
    if (route === '/tiled') return jsonRes(res, 200, { done: tiled });
    if (route === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
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
        // The instance takes frames as live messages: it says what its viewers ask, nobody yet.
        res.write(`data: ${JSON.stringify({ type: 'view', width: 640, height: 400, fps: 4 })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'viewers', count: 0 })}\n\n`);
        streams.push(res);
        return;
      }
      const type = req.headers['content-type'];
      if (type === LIVE_FRAME_TYPE) {
        const message = decodeLiveMessage(req.bytes, { maxData: MAX_LIVE_FRAME });
        const frame = typeof message === 'string' ? message : readLiveWorkerFrame(message);
        posts.push({ at: Date.now(), type, frame });
        return typeof frame === 'string' ? jsonRes(res, 400, { message: frame }) : jsonRes(res, 200, {});
      }
      // Every other message is JSON, as from any reporter.
      posts.push({ at: Date.now(), type, frame: String((JSON.parse(req.body) as { type?: unknown }).type) });
      return jsonRes(res, 200, { success: true });
    }
    if (route.startsWith('/api/')) return jsonRes(res, 200, { success: true });
    res.writeHead(404);
    res.end();
  });
  fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(project, 'tests', 'binary.spec.cjs'), SPEC(server.url));
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
  use: { headless: true, viewport: { width: 1280, height: 720 }, trace: 'off' },
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'live-view-binary-spec', streamingBatchDelay: 50 });
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
  for (const res of streams) res.end();
}, 180_000);

afterAll(async () => {
  await server?.close();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('the live view’s frames as bytes, sized by the viewers', () => {
  it('posts every frame as one live message the instance reads, each naming its worker, its call and its test', () => {
    expect(exitCode, output).toBe(0);
    const binary = posts.filter((p) => p.type === LIVE_FRAME_TYPE);
    expect(binary.length).toBeGreaterThan(3);
    expect(binary.filter((p) => typeof p.frame === 'string')).toEqual([]);
    const first = binary[0]!.frame as LiveWorkerFrame;
    expect(first).toMatchObject({
      type: 'frame',
      shard: null,
      worker: 0,
      slot: 0,
      test: 'watched in full, then as a tile',
    });
    expect(first.call?.file).toBe('tests/binary.spec.cjs');
    expect(Buffer.from(first.image.subarray(0, 2)).toString('hex')).toBe('ffd8');
    // No frame goes in base64 to an instance that takes bytes.
    expect(json(phases.full!).filter((type) => type === 'frame')).toEqual([]);
  });

  it('sends the full view at the largest size the viewers ask, within 1280 by 800, the viewport’s shape kept', () => {
    const full = frames(phases.full!, phases.tiles!);
    expect(full.length).toBeGreaterThan(2);
    const sizes = full.map((f) => jpegSize(f.image)!);
    expect(Math.max(...sizes.map((s) => s.width))).toBe(MAX_LIVE_VIEW_WIDTH);
    for (const size of sizes) {
      expect(size.width).toBeLessThanOrEqual(MAX_LIVE_VIEW_WIDTH);
      expect(size.height).toBeLessThanOrEqual(MAX_LIVE_VIEW_HEIGHT);
    }
    const bytes = full.reduce((sum, f) => sum + f.image.length, 0);
    expect(bytes / ((phases.tiles! - phases.full!) / 1000)).toBeLessThanOrEqual(LIVE_FRAME_BYTE_RATE * 1.2);
  });

  it('sends tiles alone at a tile’s size, one a second', () => {
    // The first frame after the change may still be of the full view's screencast.
    const from = phases.tiles! + 1200;
    const tiles = frames(from, phases.none!);
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      const size = jpegSize(tile.image)!;
      expect(size.width).toBeLessThanOrEqual(LIVE_TILE_WIDTH);
      expect(size.height).toBeLessThanOrEqual(LIVE_TILE_HEIGHT);
    }
    const seconds = (phases.none! - from) / 1000;
    expect(tiles.length / seconds).toBeLessThanOrEqual(LIVE_TILE_FPS + 0.5);
  });

  it('sends no frame once nobody watches', () => {
    expect(frames(phases.none! + 300, phases.tiledFrom!)).toEqual([]);
  });

  it.runIf(playwrightAtLeast('1.64'))('sends the call log the test waits in to a full view', () => {
    const fullLogs = posts.filter((p) => p.frame === 'call-log' && p.at >= phases.full! && p.at < phases.tiles!);
    expect(fullLogs.length).toBeGreaterThan(0);
  });

  it('sends a worker only tiles show no call log, though its test waits on a locator, and no end of it', () => {
    expect(frames(phases.tiledFrom!, Infinity).length).toBeGreaterThan(0);
    expect(json(phases.tiledFrom!).filter((type) => type === 'call-log' || type === 'ended')).toEqual([]);
  });
});
