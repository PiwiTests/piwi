import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWorkerToInstance, type WorkerToInstance } from '@piwitests/core/live-view';
import { detectCi } from '../src/internal/support/ci.js';
import { jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * The live view's masking, in a real CI run through the built package against a fake instance that lists one element
 * of its own to mask (`masks`): every image the worker sends while someone watches has the page's secret fields (a
 * one-time code by its `autocomplete`, a password field in a child frame with a border and padding) and that element
 * painted over, and nothing else, through the page's screencast, then through images of the page once the test starts
 * its own screencast and resizes the viewport. Each image is decoded and its pixels checked. Images that show a masked
 * element go half a second apart at least, and nothing of it shows among the test's steps. A second test's instance
 * names a mask this reporter cannot read: no image goes, and the viewers hear why.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.live-view-mask-${process.pid}`);
const RUN = 44;
const KEY = `pdl_${'m'.repeat(43)}`;
const TEST_TITLE = 'fills a one-time code while watched';
const UNREADABLE_TITLE = 'is watched while its project masks what this reporter cannot read';
const requireHere = createRequire(import.meta.url);

/** Where each field sits in the page, in CSS pixels: all of them green, on a red page. */
const FIELDS = {
  code: { x: 40, y: 40, width: 360, height: 80 },
  iban: { x: 40, y: 200, width: 360, height: 80 },
  plain: { x: 40, y: 360, width: 360, height: 80 },
  /** The child frame's viewport: inside its iframe's 6px border and 12px padding. */
  frame: { x: 578, y: 58, width: 400, height: 200 },
};
const IFRAME_CSS =
  'position: absolute; left: 560px; top: 40px; width: 400px; height: 200px; border: 6px solid black; padding: 12px; margin: 0; box-sizing: content-box';
const FIELD_CSS = (box: { x: number; y: number; width: number; height: number }) =>
  `position: absolute; left: ${box.x}px; top: ${box.y}px; width: ${box.width}px; height: ${box.height}px; box-sizing: border-box; border: 0; padding: 0; margin: 0; background: rgb(0, 255, 0); color: rgb(0, 0, 255); font: 48px monospace`;
/** A password field filling the child frame. */
const CHILD = `<style>body { margin: 0; background: rgb(255, 0, 0) }</style><input type="password" value="hunter2" style="position: absolute; left: 0; top: 0; width: 400px; height: 200px; border: 0; padding: 0; background: rgb(0, 255, 0); font: 48px monospace">`;
const PAGE = `<!doctype html><meta charset="utf-8"><title>sign in</title>
<style>body { margin: 0; background: rgb(255, 0, 0) } #spin { position: absolute; left: 860px; top: 560px; width: 60px; height: 60px; background: white; animation: s 1s linear infinite } @keyframes s { to { transform: rotate(360deg) } }</style>
<input id="code" autocomplete="one-time-code" style="${FIELD_CSS(FIELDS.code)}">
<input aria-label="IBAN" value="FR76 3000 6000" style="${FIELD_CSS(FIELDS.iban)}">
<input aria-label="Name" value="Ada" style="${FIELD_CSS(FIELDS.plain)}">
<iframe srcdoc='${CHILD}' style="${IFRAME_CSS}"></iframe>
<div id="spin"></div>`;

const SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('${TEST_TITLE}', async ({ page }) => {
  await page.goto('${base}/sign-in');
  await page.locator('#code').fill('424242');
  await fetch('${base}/watch');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  // The view goes on with images of the page, the viewport they show changing under it.
  await page.screencast.start({ onFrame: () => {} });
  await page.setViewportSize({ width: 1000, height: 800 });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await page.screencast.stop();
  await fetch('${base}/unwatch');
  await expect(page.locator('#code')).toHaveValue('424242');
});
test('${UNREADABLE_TITLE}', async ({ page }) => {
  await page.goto('${base}/sign-in');
  await fetch('${base}/watch?masks=unreadable');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await fetch('${base}/unwatch');
});
`;

/** Each test's result and steps, as the run's own reporter writes them. */
const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const titles = (steps) => steps.flatMap((s) => [s.title, ...titles(s.steps)]);
    this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message), steps: titles(result.steps) });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

type Image = { width: number; height: number; data: Uint8Array };
const jpeg = (
  createRequire(requireHere.resolve('playwright-core/package.json'))('playwright-core/lib/utilsBundle') as {
    jpegjs: { decode(data: Buffer, options: { useTArray: true; formatAsRGBA: true }): Image };
  }
).jpegjs;

let server: FakeServer;
const streams: http.ServerResponse[] = [];
const posts: Array<{ at: number; message: WorkerToInstance }> = [];
let run = {
  exitCode: null as number | null,
  output: '',
  tests: [] as Array<{ title: string; status: string; errors: string[]; steps: string[] }>,
};

function sayViewers(count: number): void {
  for (const res of streams)
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'viewers', count })}\n\n`);
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** The images the worker posted for `test`, decoded, with when each came. */
const images = (test = TEST_TITLE): Array<{ at: number; image: Image }> =>
  posts.flatMap((p) =>
    p.message.type === 'frame' && 'data' in p.message && p.message.test === test
      ? [
          {
            at: p.at,
            image: jpeg.decode(Buffer.from(p.message.data, 'base64'), { useTArray: true, formatAsRGBA: true }),
          },
        ]
      : [],
  );

/** Image pixels a CSS pixel: the viewport is 1280 by 720 (16:9), then 1000 by 800 (5:4). */
const scaleOf = (image: Image): number => image.width / (image.width / image.height > 1.5 ? 1280 : 1000);

/** The mean color of the inside of `box` (CSS pixels), a margin left out for the JPEG's blur. */
function meanColor(image: Image, box: { x: number; y: number; width: number; height: number }): number[] {
  const scale = scaleOf(image);
  const margin = 8;
  let sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.ceil((box.y + margin) * scale); y < Math.floor((box.y + box.height - margin) * scale); y++) {
    for (let x = Math.ceil((box.x + margin) * scale); x < Math.floor((box.x + box.width - margin) * scale); x++) {
      const i = (y * image.width + x) * 4;
      sum = [sum[0]! + image.data[i]!, sum[1]! + image.data[i + 1]!, sum[2]! + image.data[i + 2]!];
      n++;
    }
  }
  return sum.map((v) => Math.round(v / n));
}

/** How many pixels inside `box` are a field's green, or its text's blue. */
function fieldPixels(image: Image, box: { x: number; y: number; width: number; height: number }): number {
  const scale = scaleOf(image);
  let count = 0;
  for (let y = Math.ceil(box.y * scale); y < Math.floor((box.y + box.height) * scale); y++) {
    for (let x = Math.ceil(box.x * scale); x < Math.floor((box.x + box.width) * scale); x++) {
      const i = (y * image.width + x) * 4;
      const [r, g, b] = [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
      if ((g > 160 && r < 100 && b < 100) || (b > 160 && r < 100 && g < 100)) count++;
    }
  }
  return count;
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    if (route === '/sign-in') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
    }
    if (route === '/watch') {
      if (url.searchParams.get('masks') === 'unreadable') {
        for (const stream of streams)
          stream.write(`data: ${JSON.stringify({ type: 'masks', locators: ["getByLabel('IBAN')", '#iban'] })}\n\n`);
      }
      sayViewers(1);
      return res.end();
    }
    if (route === '/unwatch') {
      sayViewers(0);
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
        res.write(`data: ${JSON.stringify({ type: 'viewers', count: 0 })}\n\n`);
        streams.push(res);
        return;
      }
      const message = readWorkerToInstance(JSON.parse(req.body));
      if (typeof message === 'string') return jsonRes(res, 400, { message });
      posts.push({ at: Date.now(), message });
      return jsonRes(res, 200, { success: true });
    }
    if (route.startsWith('/api/')) return jsonRes(res, 200, { success: true, watched: true });
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
  write('results-reporter.cjs', RESULTS_REPORTER);
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
const { wrapConfig } = require(${JSON.stringify(dist)});
module.exports = wrapConfig(defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 30000,
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  use: { headless: true, viewport: { width: 1280, height: 720 }, trace: 'off' },
}), { serverUrl: ${JSON.stringify(server.url)}, projectName: 'live-view-mask-spec', streamingBatchDelay: 50 });
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
        run.exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        run.output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'results.json');
  run = { ...run, tests: fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [] };
  for (const res of streams) res.end();
}, 180_000);

afterAll(async () => {
  await server?.close();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('the live view’s masking', () => {
  it('lets the test pass, as without it', () => {
    expect(run.exitCode, run.output).toBe(0);
    expect(run.tests.map((t) => [t.title, t.status, t.errors])).toEqual([
      [TEST_TITLE, 'passed', []],
      [UNREADABLE_TITLE, 'passed', []],
    ]);
  });

  it('paints over the secret fields and the project’s own element in every image, in every frame', () => {
    const sent = images();
    expect(sent.length, JSON.stringify(posts.map((p) => p.message.type))).toBeGreaterThanOrEqual(4);
    // Images of both viewports went.
    expect(new Set(sent.map(({ image }) => image.width / image.height > 1.5))).toEqual(new Set([true, false]));
    for (const { image } of sent) {
      for (const box of [FIELDS.code, FIELDS.iban, FIELDS.frame]) {
        expect(fieldPixels(image, box)).toBe(0);
        const [r, g, b] = meanColor(image, box);
        expect(Math.abs(r! - 96) + Math.abs(g! - 96) + Math.abs(b! - 96)).toBeLessThan(30);
      }
    }
  });

  it('leaves the rest of the page as it is', () => {
    for (const { image } of images()) {
      const [r, g, b] = meanColor(image, FIELDS.plain);
      expect(g).toBeGreaterThan(200);
      expect(r! + b!).toBeLessThan(120);
      const [pageR, pageG] = meanColor(image, { x: 440, y: 560, width: 200, height: 100 });
      expect(pageR).toBeGreaterThan(200);
      expect(pageG).toBeLessThan(60);
    }
  });

  it('sends the images that show a masked element half a second apart at least, each at its frame’s size', () => {
    const sent = images();
    for (let i = 1; i < sent.length; i++) expect(sent[i]!.at - sent[i - 1]!.at).toBeGreaterThanOrEqual(400);
    // The screencast's frames are the view's size; the images taken in its place, the page's.
    const screencast = sent.filter(({ image }) => image.width / image.height > 1.5);
    for (const { image } of screencast) expect(image.width).toBeLessThanOrEqual(640);
    for (const { image } of sent) expect(image.width).toBeLessThanOrEqual(1000);
  });

  it('sends no image while its project masks what this reporter cannot read, and says why', () => {
    expect(images(UNREADABLE_TITLE)).toEqual([]);
    const refused = posts.flatMap((p) =>
      p.message.type === 'frame' && 'refused' in p.message ? [p.message.refused] : [],
    );
    expect(refused).toContain(
      'The project masks elements this reporter cannot read: no image goes. Update @piwitests/reporter.',
    );
  });

  it('shows nothing of itself among the test’s steps', () => {
    const steps = run.tests[0]!.steps;
    expect(steps.filter((title) => /evaluate|screenshot|frameElement|bounding|Piwi capture/i.test(title))).toEqual([]);
  });
});
