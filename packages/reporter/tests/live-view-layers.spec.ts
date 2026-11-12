import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LANE_THUMB_HEIGHT, LANE_THUMB_WIDTH, MAX_LANE_THUMB } from '@piwitests/core/live-layers';
import {
  LIVE_FRAME_TYPE,
  MAX_LIVE_FRAME,
  decodeLiveMessage,
  readLiveWorkerPost,
  readWorkerToInstance,
  type LiveCallLog,
  type LiveWorkerThumb,
  type WorkerToInstance,
} from '@piwitests/core/live-view';
import { jsonRes, startServer, type FakeServer, withoutCi } from './_helpers.js';

/**
 * The layers of the team's live view, in a real run outside CI shared from its start (`PIWI_SHARE_LIVE`) through the
 * built package, against a fake instance whose viewer asks for every layer: the call a click waits in comes from
 * Playwright's in-process instrumentation (the run may be paused, so the call stream stays off), the page's events go
 * as they happen, its text is taken as the instance asks with its password and the project's masked IBAN hidden, and
 * the test's filmstrip is the view's own images, scaled down, sent again as the instance asks again. Nothing goes once
 * nobody watches.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.live-view-layers-${process.pid}`);
const RUN = 44;
const KEY = `pdl_${'d'.repeat(43)}`;
const SECRET = 'S3cr3t!Pw';
const IBAN = 'DE89370400440532013000';
const requireHere = createRequire(import.meta.url);

const SHOP = `<!doctype html><meta charset="utf-8"><title>shop</title>
<style>body { margin: 0; padding: 20px; font: 16px sans-serif }</style>
<label>Password <input type="password"></label>
<label>IBAN <input></label>
<button onclick="setTimeout(() => { document.getElementById('pay').disabled = false; }, 2500)">Check</button>
<button id="pay" disabled>Pay</button>`;

const SPEC = (base: string) => `const { test } = require('../fixture.cjs');
test('pay', async ({ page }) => {
  await page.goto('${base}/shop');
  await fetch('${base}/watch');
  await page.waitForTimeout(1000);
  await page.getByLabel('Password').fill('${SECRET}');
  await page.getByLabel('IBAN').fill('${IBAN}');
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByRole('button', { name: 'Pay' }).click();
  await page.evaluate(() => {
    console.error('cart broke');
    void fetch('/api/missing');
  });
  await page.waitForTimeout(1200);
  await fetch('${base}/text');
  await page.waitForTimeout(1200);
  await fetch('${base}/resend');
  await page.waitForTimeout(2500);
  await fetch('${base}/unwatch');
  await page.evaluate(() => console.error('nobody watches'));
  await page.waitForTimeout(800);
});
`;

type Post = { at: number; message: WorkerToInstance | LiveWorkerThumb };

let server: FakeServer;
const streams: http.ServerResponse[] = [];
const posts: Post[] = [];
const moments: Record<'watch' | 'text' | 'resend' | 'unwatch', number> = {
  watch: Infinity,
  text: Infinity,
  resend: Infinity,
  unwatch: Infinity,
};
let run = { exitCode: null as number | null, output: '' };

function say(message: Record<string, unknown>): void {
  for (const res of streams) if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`);
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

const of = <T extends Post['message']['type']>(type: T) =>
  posts.filter((p) => p.message.type === type) as Array<{ at: number; message: Extract<Post['message'], { type: T }> }>;

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  server = await startServer((req, res) => {
    const route = new URL(req.url, 'http://x').pathname;
    if (route === '/shop') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(SHOP);
    }
    if (route === '/api/missing') {
      const logs = gzipSync(JSON.stringify([{ level: 'error', message: 'Payment provider timed out' }]));
      res.writeHead(500, { 'x-piwi-logs': logs.toString('base64') });
      return res.end();
    }
    if (route.slice(1) in moments) {
      moments[route.slice(1) as keyof typeof moments] = Date.now();
      if (route === '/watch') say({ type: 'viewers', count: 1 });
      if (route === '/text') say({ type: 'text' });
      if (route === '/resend') say({ type: 'resend' });
      if (route === '/unwatch') say({ type: 'viewers', count: 0 });
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
        res.write(`data: ${JSON.stringify({ type: 'masks', locators: ["getByLabel('IBAN')"] })}\n\n`);
        const view = {
          type: 'view',
          width: 640,
          height: 400,
          fps: 4,
          full: true,
          layers: ['events', 'text', 'filmstrip'],
        };
        res.write(`data: ${JSON.stringify(view)}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'viewers', count: 0 })}\n\n`);
        streams.push(res);
        return;
      }
      if ((req.headers['content-type'] ?? '').startsWith(LIVE_FRAME_TYPE)) {
        const message = decodeLiveMessage(new Uint8Array(req.bytes), { maxData: MAX_LIVE_FRAME });
        const read = typeof message === 'string' ? message : readLiveWorkerPost(message);
        if (typeof read === 'string') return jsonRes(res, 400, { message: read });
        if (read.type === 'thumb') posts.push({ at: Date.now(), message: read });
        return jsonRes(res, 200, { success: true });
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
  write('tests/live.spec.cjs', SPEC(server.url));
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
  reporter: [['line']],
  use: { headless: true, viewport: { width: 1280, height: 720 }, trace: 'off' },
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'live-view-layers-spec', streamingBatchDelay: 50 });
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
      { cwd: project, env, timeout: 120_000 },
      (error, stdout, stderr) => {
        run = { exitCode: error ? ((error as { code?: number }).code ?? 1) : 0, output: `${stdout}\n${stderr}` };
        resolve();
      },
    );
  });
  for (const res of streams) res.end();
}, 150_000);

afterAll(async () => {
  await server?.close();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('the layers of the team’s live view', () => {
  it('lets the test pass, as without them', () => {
    expect(run.exitCode, run.output).toBe(0);
  });

  it('tells why a click waits in a run outside CI, from the in-process instrumentation', () => {
    const logs: LiveCallLog[] = of('call-log').map(({ message }) => message.log);
    const waiting = logs.find((log) => log.call.title.includes("'Pay'") && log.target?.enabled === false);
    expect(waiting, JSON.stringify(logs.map((log) => [log.call.title, log.status]))).toBeDefined();
    expect(waiting!.lines.join('\n')).toMatch(/not enabled/);
  });

  it('posts the page’s events while asked, the backend’s logged error among them', () => {
    const events = of('page-event').map(({ message }) => message.event);
    expect(events).toContainEqual({ kind: 'console', text: 'cart broke' });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'backend', status: 500, level: 'error', text: 'Payment provider timed out' }),
    );
    expect(of('page-event').every(({ message }) => message.test === 'pay')).toBe(true);
  });

  it('takes the page’s text as asked, its password and the project’s masked element hidden', () => {
    const texts = of('text').flatMap(({ at, message }) => ('text' in message ? [{ at, text: message.text }] : []));
    const asked = texts.find(({ at, text }) => at >= moments.text && text.text.includes('IBAN'));
    expect(asked, JSON.stringify(of('text'))).toBeDefined();
    expect(asked!.text.source).toBe('snapshot');
    expect(asked!.text.text).toMatch(/textbox "Password"(?: \[[^\]]*\])*: <hidden>/);
    expect(asked!.text.text).toMatch(/textbox "IBAN"(?: \[[^\]]*\])*: <hidden>/);
  });

  it('posts the filmstrip from the view’s own images, scaled down, and all of it again as asked again', () => {
    const thumbs = of('thumb');
    const first = thumbs.filter(({ at }) => at < moments.resend);
    expect(first.length, JSON.stringify(thumbs.map(({ message }) => message.thumb.title))).toBeGreaterThanOrEqual(2);
    for (const { message } of thumbs) {
      expect(message.image.length).toBeLessThanOrEqual(MAX_LANE_THUMB);
      expect(message.thumb.width).toBeLessThanOrEqual(LANE_THUMB_WIDTH);
      expect(message.thumb.height).toBeLessThanOrEqual(LANE_THUMB_HEIGHT);
      expect(message.test).toBe('pay');
    }
    const again = thumbs.filter(({ at }) => at >= moments.resend).map(({ message }) => message.thumb.call);
    expect(again).toEqual(expect.arrayContaining(first.map(({ message }) => message.thumb.call)));
  });

  it('posts no layer before anyone watches, nor once nobody does, and never a secret the test typed', () => {
    const layered = [...of('page-event'), ...of('text'), ...of('thumb')];
    expect(layered.every(({ at }) => at >= moments.watch && at <= moments.unwatch + 500)).toBe(true);
    expect(
      of('page-event').some(
        ({ message }) => message.event.kind === 'console' && message.event.text === 'nobody watches',
      ),
    ).toBe(false);
    const said = JSON.stringify(posts.map(({ message }) => ('image' in message ? message.thumb : message)));
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain(IBAN);
  });
});
