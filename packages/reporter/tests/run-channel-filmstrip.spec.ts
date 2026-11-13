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
 * The filmstrip of a worker's lane view is masked as its frames are, in a real Playwright run through the built
 * package whose trace records the page's screencast: a fake editor service watches the worker's lane and asks for its
 * filmstrip, as a lane view of the Runs window does, while the test types into a password field and a card number's
 * field. Every image of the filmstrip is decoded, and its pixels checked: both fields are painted over, the plain
 * field beside them is not, and nothing of what the test typed shows, in the images or their titles. The images come
 * from the lane view's own frames, never from the trace's screencast, which records the fields as they are.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-filmstrip-${process.pid}`);
const REF = 'ed-f11f11f1';
const TOKEN = 'run-filmstrip-token-0123456789';
const SECRET = 'S3cr3t!Pw';
const CARD = '4111111111111111';
const requireHere = createRequire(import.meta.url);

/** Where each field sits in the page, in CSS pixels: green fields with blue text, on a red page. */
const FIELDS = {
  password: { x: 40, y: 40, width: 600, height: 120 },
  card: { x: 40, y: 220, width: 600, height: 120 },
  plain: { x: 40, y: 400, width: 600, height: 120 },
};
const FIELD_CSS = (box: { x: number; y: number; width: number; height: number }) =>
  `position: absolute; left: ${box.x}px; top: ${box.y}px; width: ${box.width}px; height: ${box.height}px; box-sizing: border-box; border: 0; padding: 0 12px; margin: 0; background: rgb(0, 255, 0); color: rgb(0, 0, 255); font: 72px monospace`;
const PAGE = `<!doctype html><meta charset="utf-8"><title>pay</title>
<style>body { margin: 0; background: rgb(255, 0, 0) }</style>
<input type="password" aria-label="Password" style="${FIELD_CSS(FIELDS.password)}">
<input autocomplete="cc-number" aria-label="Card number" style="${FIELD_CSS(FIELDS.card)}">
<input aria-label="Name" style="${FIELD_CSS(FIELDS.plain)}">`;

const SPEC = (base: string) => `const { test } = require('../fixture.cjs');
test('pays', async ({ page }) => {
  await page.goto('${base}/pay');
  await page.waitForTimeout(1500);
  await page.getByLabel('Password').fill('${SECRET}');
  await page.waitForTimeout(800);
  await page.getByLabel('Card number').fill('${CARD}');
  await page.waitForTimeout(800);
  await page.getByLabel('Name').fill('Ada Lovelace');
  await page.waitForTimeout(1500);
});
`;

const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) { this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message) }); }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

type Image = { width: number; height: number; data: Uint8Array };
const jpeg = (
  createRequire(requireHere.resolve('playwright-core/package.json'))('playwright-core/lib/utilsBundle') as {
    jpegjs: { decode(data: Buffer, options: { useTArray: true; formatAsRGBA: true }): Image };
  }
).jpegjs;

type Thumb = Extract<RunToHub, { type: 'lane-layer'; layer: 'filmstrip' }>;

let server: FakeServer;
let hub: net.Server;
let folder = '';
let socket: net.Socket | null = null;
const heard: RunToHub[] = [];
let tests: Array<{ title: string; status: string; errors: string[] }> = [];
let output = '';

const send = (message: HubToRun) => socket!.write(`${JSON.stringify(message)}\n`);
const thumbs = (): Thumb[] => heard.filter((m): m is Thumb => m.type === 'lane-layer' && m.layer === 'filmstrip');

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** Image pixels a CSS pixel: the viewport is 1280 pixels wide. */
const scaleOf = (image: Image): number => image.width / 1280;

/** The mean color of the inside of `box` (CSS pixels), a margin left out for the JPEG's blur. */
function meanColor(image: Image, box: { x: number; y: number; width: number; height: number }): number[] {
  const scale = scaleOf(image);
  const margin = 12;
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
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-filmstrip-'));
  const socketPath = path.join(folder, 'channel.sock');
  let requests = 0;
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
          // The editor's side: the lane view on, with its filmstrip, from the worker's start.
          if (message.type === 'run-attach') {
            send({ type: 'request', request: ++requests, what: 'view-lane', on: true });
            send({ type: 'layers', layers: ['filmstrip'] });
          }
        },
        () => connection.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));
  server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  write('tests/pay.spec.cjs', SPEC(server.url));
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
  use: { headless: true, viewport: { width: 1280, height: 720 }, trace: 'on' },
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
      { cwd: project, env, timeout: 120_000 },
      (_error, stdout, stderr) => {
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'results.json');
  tests = fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [];
}, 150_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  socket?.destroy();
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

describe('the filmstrip of a worker’s lane view', () => {
  it('lets the test pass, and sends an image for each call that typed', () => {
    expect(
      tests.map((t) => [t.title, t.status]),
      output,
    ).toEqual([['pays', 'passed']]);
    const titles = thumbs().map((m) => m.thumb.title);
    for (const field of ["'Password'", "'Card number'", "'Name'"]) {
      expect(
        titles.some((title) => title.includes(field)),
        JSON.stringify(titles),
      ).toBe(true);
    }
  });

  it('paints over the password and the card number in every image, and leaves the plain field as it is', () => {
    const shown = thumbs().filter((m) => /'(?:Password|Card number|Name)'/.test(m.thumb.title));
    expect(shown.length).toBeGreaterThanOrEqual(3);
    const unpainted: string[] = [];
    for (const { thumb, data } of shown) {
      const image = jpeg.decode(Buffer.from(data, 'base64'), { useTArray: true, formatAsRGBA: true });
      expect(image.width).toBeLessThanOrEqual(320);
      for (const name of ['password', 'card'] as const) {
        const count = fieldPixels(image, FIELDS[name]);
        const mean = meanColor(image, FIELDS[name]);
        const gray = mean.every((channel) => Math.abs(channel - 96) < 30);
        if (count > 0 || !gray) {
          unpainted.push(`${thumb.title} (${image.width}x${image.height}): ${name} ${count} field pixels, ${mean}`);
        }
      }
      const [r, g, b] = meanColor(image, FIELDS.plain);
      expect(g, thumb.title).toBeGreaterThan(160);
      expect(r! + b!, thumb.title).toBeLessThan(200);
    }
    expect(unpainted, `base64 of the first: ${shown[0]?.data}`).toEqual([]);
  });

  it('says nothing the test typed into a secret field', () => {
    const said = JSON.stringify(thumbs().map((m) => m.thumb));
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain(CARD);
  });
});
