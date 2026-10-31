import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IDE_DISPATCH_GLOBAL,
  IDE_RECORDER_BINDING,
  formatRecordChannel,
  lineReader,
  parseHandoffToEditor,
  type HandoffToTest,
} from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { MAX_VIEW_FPS, MAX_VIEW_FRAME, type ViewInput } from '@piwitests/core/run-view';
import { PICK_AT_NEEDS } from '../src/internal/capture/pick-at.js';
import { jsonRes, playwrightAtLeast, startServer, type FakeServer } from './_helpers.js';

/**
 * The live view of a stopped page, the input played on it and Pick on the image, in a real Playwright run through the
 * built package: a fake editor service on the socket the run names (the run channel and the record channel, as the
 * editor names both) watches each stop as Piwi Picker's Runs window would, and plays a person's part through the view
 * alone. The page tells the fake editor where its elements and Piwi's overlays are, as a person sees them on the
 * view. Headless, the view shows a page nobody else sees: input clicks a button, a pick on the image names its
 * locator, Pick and Record run in the page through the view, and nothing of Piwi is left in it once the test goes on.
 * Headed, the view shows the page beside its pause bar. With a video recorded, the view leaves the video whole. Under
 * `xvfb-run -a` the headed project opens a window; without a display, Chromium runs it without one
 * (`--headless=new`). Firefox runs where it is installed.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-view-${process.pid}`);
const REF = 'ed-5ee5ee5e';
const TOKEN = 'run-view-token-0123456789';
const SEND_TOKEN = 'send-token-0123456789abcdef';
const WINDOWS = process.platform === 'linux' && !!process.env.DISPLAY;
/** How long the editor holds a watched stop past the test's timeout. */
const HOLD_MS = 2500;
const TEST_TIMEOUT_MS = 1500;
/** How long the editor watches an animated page, to count its frames. */
const WATCH_MS = 1500;
const requireHere = createRequire(import.meta.url);
const FIREFOX = (() => {
  try {
    const { firefox } = requireHere('@playwright/test') as { firefox: { executablePath(): string } };
    return fs.existsSync(firefox.executablePath());
  } catch {
    return false;
  }
})();

/**
 * A page of the app, its content below where the pause bar shows, without a hover or focus style a pick would leave:
 * it reports where its button, its note and Piwi's overlays are, as a person sees them in the view.
 */
const PAGE = (animated: boolean) => `<!doctype html><meta charset="utf-8"><title>view</title>
<style>body { margin: 0; padding: 120px 20px 20px; font: 16px sans-serif } button { all: unset; display: inline-block; padding: 8px 16px; background: #ddd }
#spin { width: 80px; height: 80px; background: linear-gradient(red, blue); animation: s 1s linear infinite } @keyframes s { to { transform: rotate(360deg) } }</style>
<h1>Shop</h1><section data-testid="cart" aria-label="Cart"><button id="go" onclick="document.querySelector('h1').textContent = 'Clicked'">Go</button></section>
<p id="note">A note to click on.</p><input id="field">${animated ? '<div id="spin"></div>' : ''}
<script>
const center = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
let dblclicked = false;
let ctrlClicked = false;
document.getElementById('note').addEventListener('dblclick', () => { dblclicked = true; });
document.getElementById('note').addEventListener('click', (e) => { if (e.ctrlKey) ctrlClicked = true; });
setInterval(() => {
  const buttons = [...document.querySelectorAll('button')];
  fetch('/where', { method: 'POST', body: JSON.stringify({
    go: center(document.getElementById('go')),
    note: center(document.getElementById('note')),
    picking: !!document.getElementById('__piwi_picker_banner'),
    skip: center(buttons.find((b) => b.textContent === 'Skip (Esc)')),
    choice: center(buttons.find((b) => /^getBy|^locator\\(/.test(b.textContent))),
    recorder: !!document.getElementById('piwi-record-hud-host'),
    heading: document.querySelector('h1').textContent,
    dblclicked,
    ctrlClicked,
  }) }).catch(() => {});
}, 100);
</script>`;

/** What the test checks once the stop ended: nothing of Piwi in the page, which looks as it did before the stop. */
const CLEAN = `
async function piwiLeft(page) {
  return page.evaluate(() => [...document.querySelectorAll('[id^="__piwi"], [id^="piwi-"]')].map((el) => el.id)
    .concat([...document.querySelectorAll('button')].filter((b) => /^Skip|^Use selected/.test(b.textContent)).map((b) => b.textContent)));
}
async function same(page, before) {
  const after = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  if (!after.equals(before)) throw new Error('the page looks other than before the stop');
}`;

const HEADLESS_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
${CLEAN}
test('clicked through the view', async ({ page }) => {
  await page.goto('${base}/still');
  await expect(page.locator('#go')).toBeVisible(); // bp
  await expect(page.locator('h1')).toHaveText('Clicked');
});
test('picked through the view', async ({ page }) => {
  await page.goto('${base}/still');
  await page.mouse.move(1, 1);
  const before = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await expect(page.locator('#go')).toBeVisible(); // bp
  const left = await piwiLeft(page);
  if (left.length) throw new Error('left in the page: ' + left.join(', '));
  await page.mouse.move(1, 1);
  await same(page, before);
});
test('region picked through the view', async ({ page }) => {
  await page.goto('${base}/still');
  await page.mouse.move(1, 1);
  const before = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await expect(page.locator('#go')).toBeVisible(); // bp
  const left = await piwiLeft(page);
  if (left.length) throw new Error('left in the page: ' + left.join(', '));
  await page.mouse.move(1, 1);
  await same(page, before);
});
test('recorded through the view', async ({ page }) => {
  await page.goto('${base}/still');
  await page.mouse.move(1, 1);
  const before = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await expect(page.locator('#go')).toBeVisible(); // bp
  const left = await piwiLeft(page);
  if (left.length) throw new Error('left in the page: ' + left.join(', '));
  await page.mouse.move(1, 1);
  await same(page, before);
});
test('held past its timeout while watched', async ({ page }) => {
  test.setTimeout(${TEST_TIMEOUT_MS});
  await page.goto('${base}/animated');
  await expect(page.locator('#go')).toBeVisible(); // bp
});
`;

const HEADED_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('watched at a headed stop', async ({ page }) => {
  await page.goto('${base}/still');
  await expect(page.locator('#go')).toBeVisible(); // bp
  await expect(page.locator('h1')).toHaveText('Clicked');
});
`;

const VIDEO_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('recorded on video while watched', async ({ page }) => {
  await page.goto('${base}/animated');
  await expect(page.locator('#go')).toBeVisible(); // bp
  await page.waitForTimeout(300);
});
`;

const SHARP_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('picked on a sharper image', async ({ page }) => {
  await page.goto('${base}/still');
  await expect(page.locator('#go')).toBeVisible(); // bp
});
`;

/**
 * A page of noise, which no JPEG makes small: at 1280 by 720 its frames are over the view's limit, a lighter image
 * of it not; at 1920 by 1080, with a video recorded at that size, the lighter image is over it too.
 */
const NOISY = (width: number, height: number) => `<!doctype html><style>body { margin: 0 }</style>
<button id="go" style="position:absolute;left:10px;top:10px">Go</button><canvas id="c" width="${width}" height="${height}"></canvas>
<script>
const context = document.getElementById('c').getContext('2d');
const noise = context.createImageData(${width}, ${height});
for (let i = 0; i < noise.data.length; i++) noise.data[i] = i % 4 === 3 ? 255 : Math.random() * 255;
context.putImageData(noise, 0, 0);
</script>`;

const HEAVY_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('watched on a page too heavy for its frames', async ({ page }) => {
  await page.goto('${base}/noisy');
  await expect(page.locator('#go')).toBeVisible(); // bp
});
`;

const HEAVIER_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('watched on a page too heavy for a lighter image', async ({ page }) => {
  await page.goto('${base}/noisier');
  await expect(page.locator('#go')).toBeVisible(); // bp
});
`;

const FIREFOX_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test('watched in Firefox', async ({ page }) => {
  await page.goto('${base}/animated');
  await expect(page.locator('#go')).toBeVisible(); // bp
  await expect(page.locator('h1')).toHaveText('Clicked');
});
`;

/**
 * A recorder for the hand-off, as the editor's would be loaded: a panel of its own, each click a person makes in the
 * page sent over the binding, and gone once the recording stops.
 */
const FAKE_RECORDER = `(() => {
  if (globalThis.__fakeRecorderLoaded) return;
  globalThis.__fakeRecorderLoaded = true;
  const host = document.createElement('div');
  host.id = 'piwi-record-hud-host';
  host.textContent = 'Recording';
  host.style.cssText = 'position:fixed;right:0;bottom:0;background:#c00;color:#fff;padding:4px;z-index:2147483647';
  document.documentElement.appendChild(host);
  const onClick = (e) => {
    if (!e.isTrusted || host.contains(e.target)) return;
    globalThis.${IDE_RECORDER_BINDING}({ kind: 'message', message: { type: 'fake-click', on: e.target.id || e.target.tagName } });
  };
  document.addEventListener('click', onClick, true);
  globalThis.${IDE_DISPATCH_GLOBAL} = (message) => {
    if (!message || message.type !== 'piwi-recording-stopped') return;
    host.remove();
    document.removeEventListener('click', onClick, true);
    delete globalThis.${IDE_DISPATCH_GLOBAL};
    delete globalThis.__fakeRecorderLoaded;
  };
})();`;

/** Each test's result and attachments, as the run's own reporter writes them. */
const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const step = (s) => ({ title: s.title, steps: s.steps.map(step) });
    this.tests.push({ title: test.title, status: result.status, errors: result.errors.map((e) => e.message), attachments: result.attachments.map((a) => ({ name: a.name, path: a.path })), steps: result.steps.map(step) });
  }
  onStdOut(chunk) { process.stdout.write(chunk); }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

type Point = { x: number; y: number };
interface Where {
  go: Point | null;
  note: Point | null;
  picking: boolean;
  skip: Point | null;
  choice: Point | null;
  recorder: boolean;
  heading: string;
  dblclicked: boolean;
  ctrlClicked: boolean;
}

/** A worker's run connection, as the fake editor service holds it: what it heard, when, and its test. */
interface Connection {
  socket: net.Socket;
  heard: Array<{ at: number; message: RunToHub }>;
  test: string | null;
}

type Stopped = Extract<RunToHub, { type: 'stopped' }>;
type Answered = { ok: boolean; message: string; locator?: string | null };

let server: FakeServer;
let hub: net.Server;
let folder = '';
let bundle = '';
const connections: Connection[] = [];
const picks: unknown[] = [];
/** What the fake recorder sent over the binding, and the hand-offs the editor heard. */
const recorded: unknown[] = [];
const handoffs: unknown[] = [];
let where: Where | null = null;
/** What each test's stop was answered, by test, in order. */
const said: Record<string, Answered[]> = {};
/** Each test's stop, the image the editor asked of it, and what it measured of its frames. */
const stops: Record<string, Stopped> = {};
const images: Record<string, { width?: number; height?: number; data: string } | null> = {};
/** Where a client showing the image of a page with a device scale factor of 2 clicked, and the point it sent. */
const sharp: { natural?: { width: number; height: number } | null; clicked?: Point; sent?: Point } = {};
const watched: Record<
  string,
  { frames: number; bytes: number; ms: number; firstJpeg: Buffer | null; lastJpeg: Buffer | null }
> = {};
/** Whether the frame a view sent again, asked again, was the one it sent last. */
const resent: boolean[] = [];
/** What the view of a page too heavy for a lighter image said, each time. */
const heavy: { refusals?: string[] } = {};
interface DumpedStep {
  title: string;
  steps: DumpedStep[];
}
let tests: Array<{
  title: string;
  status: string;
  errors: string[];
  attachments: Array<{ name: string; path?: string }>;
  steps: DumpedStep[];
}> = [];
let exitCode: number | null = null;
let output = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | undefined, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(20);
  }
}

function send(connection: Connection, message: HubToRun): void {
  connection.socket.write(`${JSON.stringify(message)}\n`);
}

let requests = 0;
/** Asks the worker at a stop, and waits for its answer. */
async function ask(connection: Connection, message: Record<string, unknown> & { what: string }): Promise<Answered> {
  const request = ++requests;
  send(connection, { type: 'request', request, ...message } as HubToRun);
  const answer = await waitFor(() =>
    connection.heard.find(({ message: m }) => m.type === 'answer' && m.request === request),
  );
  return (answer.message as { value: Answered }).value;
}

type FrameHeard = Extract<RunToHub, { type: 'frame'; data: string }>;

const frames = (connection: Connection, stop: number) =>
  connection.heard.filter(({ message: m }) => m.type === 'frame' && m.stop === stop && 'data' in m) as Array<{
    at: number;
    message: FrameHeard;
  }>;

/** Why the view of a stop sent no frame, each time it said so. */
const refusals = (connection: Connection, stop: number) =>
  connection.heard.flatMap(({ message: m }) => (m.type === 'frame' && m.stop === stop && 'refused' in m ? [m] : []));

const click = (at: Point): ViewInput[] => [
  { type: 'mouse', action: 'move', x: at.x, y: at.y },
  { type: 'mouse', action: 'click', x: at.x, y: at.y, button: 'left', clickCount: 1 },
];

/** The editor's side of each stop: what a person does through Piwi Picker's view. */
async function onStopped(connection: Connection, stop: Stopped): Promise<void> {
  if (stop.reason === 'failure') return send(connection, { type: 'control', action: 'resume', stop: stop.stop });
  const test = connection.test!;
  stops[test] = stop;
  // What the page of the test before said is not this one's.
  where = null;
  const answers = (said[test] ??= []);
  const view = (on: boolean) => ask(connection, { what: 'view', stop: stop.stop, on });
  const play = (events: ViewInput[]) => ask(connection, { what: 'input', stop: stop.stop, events });
  const watch = async (ms: number) => {
    const before = frames(connection, stop.stop).length;
    const start = Date.now();
    await sleep(ms);
    const seen = frames(connection, stop.stop).slice(before);
    const first = frames(connection, stop.stop)[0]?.message.data;
    const last = seen[seen.length - 1]?.message.data;
    watched[test] = {
      frames: seen.length,
      bytes: seen.reduce((sum, f) => sum + (f.message.data.length * 3) / 4, 0),
      ms: Date.now() - start,
      firstJpeg: first ? Buffer.from(first, 'base64') : null,
      lastJpeg: last ? Buffer.from(last, 'base64') : null,
    };
  };
  try {
    if (test === 'clicked through the view' || test === 'watched at a headed stop' || test === 'watched in Firefox') {
      if (test === 'clicked through the view') {
        // Nobody watches yet: the old refusals stand.
        answers.push(await ask(connection, { what: 'pick', stop: stop.stop }));
        answers.push(await play(click({ x: 5, y: 5 })));
      }
      answers.push(await view(true));
      await waitFor(() => frames(connection, stop.stop).length > 0);
      if (test === 'clicked through the view') {
        // The view asked again, for a viewer that comes: the page paints nothing, the frame sent last comes again.
        const seen = frames(connection, stop.stop);
        answers.push(await view(true));
        const again = await waitFor(() => frames(connection, stop.stop)[seen.length], 3000);
        resent.push(again.message.data === seen[seen.length - 1]!.message.data);
      }
      if (test === 'watched in Firefox') await watch(WATCH_MS);
      const at = await waitFor(() => where?.go ?? undefined);
      answers.push(await play(click(at)));
      await waitFor(() => where?.heading === 'Clicked');
      if (test === 'clicked through the view') {
        // A double click as a viewer's browser counted it, 320 ms apart, and a click with Control held.
        const note = await waitFor(() => where?.note ?? undefined);
        const press = (clickCount: number): ViewInput[] => [
          { type: 'mouse', action: 'down', ...note, button: 'left', clickCount },
          { type: 'mouse', action: 'up', ...note, button: 'left', clickCount },
        ];
        answers.push(await play(press(1)));
        await sleep(320);
        answers.push(await play(press(2)));
        await waitFor(() => where?.dblclicked);
        answers.push(
          await play([
            { type: 'key', action: 'down', key: 'Control' },
            ...click(note).slice(1),
            { type: 'key', action: 'up', key: 'Control' },
          ]),
        );
        await waitFor(() => where?.ctrlClicked);
      }
      answers.push(await ask(connection, { what: 'pick-at', stop: stop.stop, x: at.x, y: at.y }));
      const image = await ask(connection, { what: 'image' });
      images[test] = image as unknown as { width?: number; height?: number; data: string } | null;
      answers.push(await view(false));
    } else if (test === 'picked through the view' || test === 'region picked through the view') {
      const region = test === 'region picked through the view';
      const picked = picks.length;
      answers.push(await view(true));
      answers.push(await ask(connection, { what: region ? 'assert-region' : 'pick', stop: stop.stop }));
      await waitFor(() => where?.picking);
      answers.push(await play(click(await waitFor(() => where?.go ?? undefined))));
      // The anchors step: Escape skips it, as on a keyboard.
      await waitFor(() => where?.skip ?? undefined);
      answers.push(await play([{ type: 'key', action: 'press', key: 'Escape' }]));
      answers.push(await play(click(await waitFor(() => where?.choice ?? undefined))));
      if (region) await waitFor(() => connection.heard.some(({ message: m }) => m.type === 'region'));
      else await waitFor(() => picks.length > picked);
    } else if (test === 'recorded through the view') {
      answers.push(await view(true));
      answers.push(await ask(connection, { what: 'record', stop: stop.stop }));
      await waitFor(() => where?.recorder);
      answers.push(await play(click(await waitFor(() => where?.note ?? undefined))));
      await waitFor(() => recorded.length > 0);
      // The editor stops the recording; its panel leaves the page.
      await waitFor(() => where && !where.recorder);
    } else if (test === 'held past its timeout while watched') {
      answers.push(await view(true));
      await watch(HOLD_MS);
      answers.push(await view(false));
    } else if (test === 'picked on a sharper image') {
      // The image is in device pixels; the point goes in CSS pixels of the page, as the image's viewport names them.
      const image = (await ask(connection, { what: 'image' })) as unknown as {
        width: number;
        height: number;
        data: string;
      };
      sharp.natural = jpegSize(Buffer.from(image.data, 'base64'));
      const go = await waitFor(() => where?.go ?? undefined);
      sharp.clicked = {
        x: (go.x * sharp.natural!.width) / image.width,
        y: (go.y * sharp.natural!.height) / image.height,
      };
      sharp.sent = {
        x: (sharp.clicked.x * image.width) / sharp.natural!.width,
        y: (sharp.clicked.y * image.height) / sharp.natural!.height,
      };
      answers.push(await ask(connection, { what: 'pick-at', stop: stop.stop, ...sharp.sent }));
      answers.push(await view(true));
      await watch(300);
    } else if (test === 'recorded on video while watched') {
      answers.push(await view(true));
      await watch(WATCH_MS);
    } else if (test === 'watched on a page too heavy for its frames') {
      answers.push(await view(true));
      await waitFor(() => frames(connection, stop.stop).length > 0, 5000);
      await watch(500);
    } else if (test === 'watched on a page too heavy for a lighter image') {
      answers.push(await view(true));
      await waitFor(() => refusals(connection, stop.stop).length > 0, 5000);
      // The page paints again: it is said once.
      answers.push(await play([{ type: 'mouse', action: 'move', x: 600, y: 300 }]));
      await watch(1000);
      heavy.refusals = refusals(connection, stop.stop).map((m) => m.refused);
    }
  } catch (error) {
    answers.push({ ok: false, message: `the editor gave up: ${String(error)}` });
  }
  send(connection, { type: 'control', action: 'resume', stop: stop.stop });
}

/** The fake editor's side of a hand-off: it takes the recording of the test that records, and stops it after a click. */
function onHandoff(socket: net.Socket, first: string): void {
  const reply = (message: HandoffToTest) => socket.write(`${JSON.stringify(message)}\n`);
  const attach = parseHandoffToEditor(first);
  handoffs.push(attach);
  const recording = connections.some((c) => c.test === 'recorded through the view');
  if (attach?.type !== 'attach' || !recording) {
    socket.end(`${JSON.stringify({ type: 'refused', message: 'this editor records nothing here.' })}\n`);
    return;
  }
  reply({ type: 'load', bundle });
  return void socket.on(
    'data',
    lineReader(
      (line) => {
        const message = parseHandoffToEditor(line);
        if (message?.type !== 'binding') return;
        reply({ type: 'answer', call: message.call, value: { ok: true } });
        recorded.push(message.payload);
        reply({ type: 'dispatch', message: { type: 'piwi-recording-stopped' } });
        reply({ type: 'stop' });
        socket.end();
      },
      () => socket.destroy(),
    ),
  );
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

/** The line of the `// bp` in the test titled `title` of a spec. */
function breakpointOf(spec: string, title: string): number {
  const lines = spec.split('\n');
  const start = lines.findIndex((line) => line.includes(`test('${title}'`));
  return lines.findIndex((line, i) => i > start && line.endsWith('// bp')) + 1;
}

/** A JPEG's size in pixels, from its first frame header; null for none. */
function jpegSize(data: Buffer): { width: number; height: number } | null {
  for (let i = 2; i + 9 < data.length;) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1]!;
    const length = data.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return null;
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-view-'));
  bundle = path.join(folder, 'fake-recorder.js');
  fs.writeFileSync(bundle, FAKE_RECORDER);
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((socket) => {
    const connection: Connection = { socket, heard: [], test: null };
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    let first = true;
    const read = lineReader(
      (line) => {
        if (first) {
          first = false;
          if (parseHandoffToEditor(line)?.type === 'attach') {
            socket.removeListener('data', read);
            return onHandoff(socket, line);
          }
          connections.push(connection);
        }
        const message = parseRunToHub(line);
        if (!message) return;
        connection.heard.push({ at: Date.now(), message });
        if (message.type === 'test-begin') connection.test = message.title[message.title.length - 1]!;
        if (message.type === 'stopped') void onStopped(connection, message);
      },
      () => socket.destroy(),
    );
    socket.on('data', read);
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));

  server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/where') {
      where = JSON.parse(req.body) as Where;
      return res.end();
    }
    if (url.pathname === '/piwi/send') {
      picks.push({ authorization: req.headers.authorization, body: JSON.parse(req.body) });
      return jsonRes(res, 200, { inserted: true, file: null });
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (url.pathname === '/noisy') return res.end(NOISY(1280, 720));
    if (url.pathname === '/noisier') return res.end(NOISY(1920, 1080));
    res.end(PAGE(url.pathname === '/animated'));
  });

  write('tests/headless.spec.cjs', HEADLESS_SPEC(server.url));
  write('tests/headed.spec.cjs', HEADED_SPEC(server.url));
  write('tests/video.spec.cjs', VIDEO_SPEC(server.url));
  write('tests/sharp.spec.cjs', SHARP_SPEC(server.url));
  write('tests/heavy.spec.cjs', HEAVY_SPEC(server.url));
  write('tests/heavier.spec.cjs', HEAVIER_SPEC(server.url));
  write('tests/firefox.spec.cjs', FIREFOX_SPEC(server.url));
  write(
    'fixture.cjs',
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  write('results-reporter.cjs', RESULTS_REPORTER);
  const headed = `{ headless: false, viewport: { width: 1000, height: 640 }, launchOptions: { args: ${WINDOWS ? '[]' : "['--headless=new']"} } }`;
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 10000,
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  use: { viewport: { width: 1000, height: 640 } },
  projects: [
    { name: 'headless', testMatch: 'headless.spec.cjs', use: { headless: true } },
    { name: 'headed', testMatch: 'headed.spec.cjs', use: ${headed}, dependencies: ['headless'] },
    { name: 'video', testMatch: 'video.spec.cjs', use: { headless: true, video: 'on' }, dependencies: ['headed'] },
    { name: 'sharp', testMatch: 'sharp.spec.cjs', use: { headless: true, deviceScaleFactor: 2 }, dependencies: ['video'] },
    { name: 'heavy', testMatch: 'heavy.spec.cjs', use: { headless: true, viewport: { width: 1280, height: 720 } }, dependencies: ['sharp'] },
    { name: 'heavier', testMatch: 'heavier.spec.cjs', use: { headless: true, viewport: { width: 1920, height: 1080 }, video: { mode: 'on', size: { width: 1920, height: 1080 } } }, dependencies: ['heavy'] },
    ${FIREFOX ? "{ name: 'firefox', testMatch: 'firefox.spec.cjs', use: { browserName: 'firefox', headless: true }, dependencies: ['heavier'] }," : ''}
  ],
});
`,
  );
  const breakpoints = (spec: string, text: string) =>
    text
      .split('\n')
      .flatMap((line, i) => (line.endsWith('// bp') ? [`tests/${spec}:${i + 1}`] : []))
      .join(';');
  const channel = formatRecordChannel({ path: socketPath, token: TOKEN });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: channel,
    PIWI_RECORD_CHANNEL: channel,
    PIWI_EDITOR_SEND: `${server.url}/piwi/send#${SEND_TOKEN}`,
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
    PIWI_PAUSE_AT: [
      breakpoints('headless.spec.cjs', HEADLESS_SPEC(server.url)),
      breakpoints('headed.spec.cjs', HEADED_SPEC(server.url)),
      breakpoints('video.spec.cjs', VIDEO_SPEC(server.url)),
      breakpoints('sharp.spec.cjs', SHARP_SPEC(server.url)),
      breakpoints('heavy.spec.cjs', HEAVY_SPEC(server.url)),
      breakpoints('heavier.spec.cjs', HEAVIER_SPEC(server.url)),
      breakpoints('firefox.spec.cjs', FIREFOX_SPEC(server.url)),
    ].join(';'),
  };
  for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL']) delete env[name];
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [requireHere.resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 150_000 },
      (error, stdout, stderr) => {
        exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'results.json');
  tests = fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [];
}, 180_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  for (const connection of connections) connection.socket.destroy();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

const NEEDS_BAR =
  "Pick a locator needs the pause bar in the test's window, and this stop shows none: run the test headed.";
const ON = { ok: true, message: 'The live view is on.' };
const OFF = { ok: true, message: 'The live view is off.' };
const PLAYED_2 = { ok: true, message: 'Played 2 events.' };
const GO = "getByRole('button', { name: 'Go' })";
/** Pick on the image needs Playwright 1.60 (the snapshot's boxes): below it, it is refused, saying so. */
const PICKS_AT = playwrightAtLeast('1.60');
const PICKED_AT = PICKS_AT
  ? { ok: true, message: `${GO} went to the editor, in place of the locator on the stopped line.`, locator: GO }
  : { ok: false, message: PICK_AT_NEEDS, locator: null };

/** What Pick on the image sends where a pick goes, at the stop of the headless test `title`. */
function pickSent(title: string) {
  const at = { file: 'tests/headless.spec.cjs', line: breakpointOf(HEADLESS_SPEC(server.url), title) };
  return { authorization: `Bearer ${SEND_TOKEN}`, body: { kind: 'locator', text: GO, at } };
}

describe('the live view of a stopped page', () => {
  it('lets every test pass, and says it takes the view, its input and a pick on the image as it attaches', () => {
    expect(exitCode, output).toBe(0);
    expect(tests.map((t) => [t.title, t.status, t.errors])).toEqual([
      ['clicked through the view', 'passed', []],
      ['picked through the view', 'passed', []],
      ['region picked through the view', 'passed', []],
      ['recorded through the view', 'passed', []],
      ['held past its timeout while watched', 'passed', []],
      ['watched at a headed stop', 'passed', []],
      ['recorded on video while watched', 'passed', []],
      ['picked on a sharper image', 'passed', []],
      ['watched on a page too heavy for its frames', 'passed', []],
      ['watched on a page too heavy for a lighter image', 'passed', []],
      ...(FIREFOX ? [['watched in Firefox', 'passed', []]] : []),
    ]);
    expect(connections[0]!.heard[0]!.message).toMatchObject({
      type: 'run-attach',
      takes: expect.arrayContaining(['view', 'input', 'pick-at']),
    });
  });

  it('refuses Pick and input on a headless stop nobody watches, then plays a click through the view', () => {
    expect(said['clicked through the view']).toEqual([
      { ok: false, message: NEEDS_BAR },
      { ok: false, message: 'The input needs the live view of this stop: watch it first.' },
      ON,
      ON,
      PLAYED_2,
      // The double click, its clicks 320 ms apart, and the click with Control: the page heard both as a person's.
      PLAYED_2,
      PLAYED_2,
      { ok: true, message: 'Played 3 events.' },
      PICKED_AT,
      OFF,
    ]);
  });

  it('sends the frame it sent last again as the view is asked again, for a viewer that comes to a still page', () => {
    expect(resent).toEqual([true]);
  });

  it('sends frames of the stop it watches alone, at most the view’s pace, and none once the stop ended', () => {
    // Each frame names the viewport of its page: the noisy pages' own, else the config's.
    const viewports: Record<string, { width: number; height: number }> = {
      'watched on a page too heavy for its frames': { width: 1280, height: 720 },
      'watched on a page too heavy for a lighter image': { width: 1920, height: 1080 },
    };
    for (const connection of connections) {
      const running = new Map(
        connection.heard.flatMap(({ at, message }) => (message.type === 'running' ? [[message.stop, at]] : [])),
      );
      for (const { at, message } of connection.heard) {
        if (message.type !== 'frame') continue;
        expect(running.get(message.stop) ?? Infinity, `a frame of stop ${message.stop}`).toBeGreaterThanOrEqual(at);
        if (!('data' in message)) continue;
        expect({ width: message.width, height: message.height }).toEqual(
          viewports[connection.test!] ?? { width: 1000, height: 640 },
        );
      }
    }
    const held = watched['held past its timeout while watched']!;
    expect(held.frames).toBeGreaterThan(1);
    expect(held.frames).toBeLessThanOrEqual(Math.ceil((held.ms / 1000) * MAX_VIEW_FPS) + 1);
  });

  it('holds a watched stop past the test’s timeout, as any stop', () => {
    expect(watched['held past its timeout while watched']!.ms).toBeGreaterThan(TEST_TIMEOUT_MS);
    expect(said['held past its timeout while watched']).toEqual([ON, OFF]);
  });

  it('sends an image that names the page’s viewport in CSS pixels, which a point on it is mapped to', () => {
    expect(images['clicked through the view']).toMatchObject({ width: 1000, height: 640 });
  });

  it.runIf(PICKS_AT)('names the locator of the element under a point of the page, sent where a pick goes', () => {
    expect(picks).toContainEqual(pickSent('clicked through the view'));
  });

  it.runIf(!PICKS_AT)('refuses Pick on the image without the snapshot’s boxes, and sends no pick', () => {
    expect(said['picked on a sharper image']).toEqual([PICKED_AT, ON]);
    expect(picks).not.toContainEqual(pickSent('clicked through the view'));
  });

  it('picks headless through the view, the anchors step and the choice included, leaving nothing behind', () => {
    expect(said['picked through the view']).toEqual([
      ON,
      { ok: true, message: "Pick an element in the test's window: the locator goes to the editor." },
      PLAYED_2,
      { ok: true, message: 'Played 1 event.' },
      PLAYED_2,
    ]);
    expect(picks).toContainEqual({
      authorization: `Bearer ${SEND_TOKEN}`,
      body: {
        kind: 'locator',
        text: GO,
        at: {
          file: 'tests/headless.spec.cjs',
          line: breakpointOf(HEADLESS_SPEC(server.url), 'picked through the view'),
        },
      },
    });
  });

  it('picks a region headless through the view, its ARIA snapshot sent for the editor to write', () => {
    expect(said['region picked through the view']).toEqual([
      ON,
      {
        ok: true,
        message: "Pick the region in the test's window: the editor writes its ARIA snapshot above the stopped line.",
      },
      PLAYED_2,
      { ok: true, message: 'Played 1 event.' },
      PLAYED_2,
    ]);
    const region = connections.flatMap((c) => c.heard.map(({ message }) => message)).find((m) => m.type === 'region');
    expect(region).toEqual({
      type: 'region',
      stop: stops['region picked through the view']!.stop,
      locator: GO,
      snapshot: '- button "Go"',
    });
  });

  it('records headless through the view, the person’s click trusted, its recorder gone once it stops', () => {
    expect(said['recorded through the view']).toEqual([
      ON,
      { ok: true, message: "Recording in the test's window: the editor writes the steps above the stopped line." },
      PLAYED_2,
    ]);
    expect(recorded).toEqual([{ kind: 'message', message: { type: 'fake-click', on: 'note' } }]);
    expect(handoffs).toContainEqual(
      expect.objectContaining({
        type: 'attach',
        token: TOKEN,
        line: breakpointOf(HEADLESS_SPEC(server.url), 'recorded through the view'),
      }),
    );
  });

  it('shows a headed stop too, and plays its input there', () => {
    expect(said['watched at a headed stop']).toEqual([ON, PLAYED_2, PICKED_AT, OFF]);
    expect(stops['watched at a headed stop']).toMatchObject({ bar: true });
  });

  it('leaves the test’s video whole, its first client’s size the view’s', () => {
    const video = tests
      .find((t) => t.title === 'recorded on video while watched')!
      .attachments.find((a) => a.name === 'video');
    expect(video?.path).toBeTruthy();
    const file = fs.readFileSync(video!.path!);
    // A WebM file: its EBML header.
    expect(file.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video!.path!],
      {
        encoding: 'utf8',
      },
    );
    if (!probe.error && probe.status === 0) {
      expect(Number(probe.stdout.trim())).toBeGreaterThan(WATCH_MS / 1000);
    }
    const seen = watched['recorded on video while watched']!;
    expect(seen.frames).toBeGreaterThan(1);
    // The video asked first, at its own size: the view's frames come at that size, not the view's. A view that joins
    // the page's screencast first gets the last frame it painted, which can predate the page's viewport: the size is
    // read from the frames the view watched.
    expect(jpegSize(seen.lastJpeg!)).toEqual({ width: 800, height: 512 });
  });

  it('sends an image in device pixels that names the viewport in CSS pixels', () => {
    // Twice the viewport's CSS pixels: the device scale factor.
    expect(sharp.natural).toEqual({ width: 2000, height: 1280 });
    // The view names the same viewport, whatever its frames' own size.
    const seen = watched['picked on a sharper image']!;
    expect(seen.firstJpeg && jpegSize(seen.firstJpeg)).toEqual({ width: 1000, height: 640 });
  });

  it.runIf(PICKS_AT)('maps a point of such an image to the page through the viewport it names', () => {
    expect(sharp.clicked!.x).toBeCloseTo(sharp.sent!.x * 2);
    expect(said['picked on a sharper image']).toEqual([PICKED_AT, ON]);
  });

  it('shows a lighter image of a page whose frames are too long, and says once why none goes when it is too', () => {
    expect(said['watched on a page too heavy for its frames']).toEqual([ON]);
    const lighter = watched['watched on a page too heavy for its frames']!;
    expect(lighter.firstJpeg!.length).toBeLessThanOrEqual(MAX_VIEW_FRAME);
    expect(jpegSize(lighter.firstJpeg!)).toEqual({ width: 1280, height: 720 });
    expect(said['watched on a page too heavy for a lighter image']).toEqual([ON, { ok: true, message: 'Played 1 event.' }]);
    expect(heavy.refusals).toEqual([
      'This page is too heavy for the live view: each image of it is over 384 KB, a lighter one included. The image of the stop still shows it.',
    ]);
    expect(watched['watched on a page too heavy for a lighter image']!.frames).toBe(0);
  });

  it.skipIf(!FIREFOX)('shows a page in Firefox, its frames at the view’s pace', () => {
    expect(said['watched in Firefox']).toEqual([ON, PLAYED_2, PICKED_AT, OFF]);
    const seen = watched['watched in Firefox']!;
    expect(seen.frames).toBeGreaterThan(1);
    expect(seen.frames).toBeLessThanOrEqual(Math.ceil((seen.ms / 1000) * MAX_VIEW_FPS) + 1);
  });

  it('shows none of its own calls among the test’s steps', () => {
    const all = (steps: DumpedStep[]): DumpedStep[] => steps.flatMap((s) => [s, ...all(s.steps)]);
    const piwi =
      /Screencast|Mouse (click|down|up|wheel)|Press|Insert text|Keyboard|Aria snapshot|Normalize|Get by ref|Element handle|Count|Wait for function|Bring to front|Piwi capture/i;
    for (const result of tests) {
      expect(
        all(result.steps).map((s) => s.title),
        result.title,
      ).not.toContainEqual(expect.stringMatching(piwi));
    }
    // A test that reads its page itself in no way: every page call of the view, its input and its pick is Piwi's.
    const clicked = all(tests.find((t) => t.title === 'clicked through the view')!.steps).map((s) => s.title);
    expect(clicked).not.toContainEqual(expect.stringMatching(/Mouse|Screenshot|Evaluate/));
  });

  it('ends every stop it showed once, with `running`', () => {
    for (const connection of connections) {
      const stops = (type: 'stopped' | 'running') =>
        connection.heard.flatMap(({ message }) => (message.type === type ? [message.stop] : [])).sort((a, b) => a - b);
      expect(stops('running')).toEqual(stops('stopped'));
    }
  });
});
