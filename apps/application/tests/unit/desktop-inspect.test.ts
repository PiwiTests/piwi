/**
 * The desktop app's **Inspect**: a lane's running test's pages read from its own trace on this machine
 * (`server/utils/desktop-inspect.ts`). First the reader, on the trace a real browser writes as it goes (Chromium
 * through `@playwright/test`, tracing with DOM snapshots into a folder of the test's): what it keeps of each call, what
 * it hides of the page's secrets, the resources it reads and those it never does, and a link it never follows. Then on
 * traces written by hand: where it starts as Inspect opens, and what it says of a trace without snapshots. Then the
 * lanes the windows have it open on: the attempt each follows, the worker's own sentence when it names no trace, the
 * next test letting go of the one before, and nothing kept once the last window closes it. Skipped where Chromium is
 * not installed.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LaneTrace, RunSession } from '@piwitests/editor/run-host';
import type { DesktopInspectEvent, DesktopInspectNotice } from '#shared/desktop-runs';
import {
  DESKTOP_INSPECT_WORDS,
  DesktopInspects,
  DesktopTraceReader,
  readDesktopInspectLane,
  readDesktopInspectMoment,
  type DesktopInspectSessions,
} from '../../server/utils/desktop-inspect';
import { InspectBudget, MAX_WORKER_SNAPSHOT_COUNT, RunInspect } from '../../server/utils/live-inspect';

const requireHere = createRequire(import.meta.url);
type Chromium = typeof import('@playwright/test').chromium;
const chromium = ((): Chromium | null => {
  try {
    const { chromium: browser } = requireHere('@playwright/test') as { chromium: Chromium };
    return fs.existsSync(browser.executablePath()) ? browser : null;
  } catch {
    return null;
  }
})();

const SECRET = 'hunter2-Secret!';
const UNREAD_FRAME =
  'The page is not shown: the desktop app could not read one of its frames whole (too deep, too large, or naming one it no longer holds), so it could not hide its secrets. Inspect shows it again from its next navigation.';
const MOVED =
  "Inspect stopped reading this test's trace: the runner's trace folder, a folder above it or its resources folder is a link or no longer a folder.";
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fe0dce4a5f0000000049454e44ae426082',
  'hex',
);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const PAGE = `<!doctype html><title>Shop</title><link rel="stylesheet" href="/style.css"><script src="/app.js"></script>
<h1>Shop</h1><img src="/logo.svg" alt="logo"><label>Password <input type="password" id="pw"></label>
<p id="echo"></p><button onclick="document.getElementById('echo').textContent = document.getElementById('pw').value">Show</button>`;

let root = '';
let server: http.Server;
let base = '';

beforeAll(async () => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-desktop-inspect-')));
  server = http.createServer((req, res) => {
    if (req.url === '/style.css') {
      return void res
        .writeHead(200, { 'content-type': 'text/css' })
        .end('body { background: url(/bg.png) } h1 { color: rgb(1, 2, 3) }');
    }
    if (req.url === '/bg.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    if (req.url === '/app.js')
      return void res.writeHead(200, { 'content-type': 'text/javascript' }).end('window.ran = 1;');
    if (req.url === '/logo.svg') return void res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(SVG);
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
  fs.rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | undefined | false | null, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Node's file system promises, as the reader calls them: a test holds or changes one of its calls. */
const fsPromises = requireHere('node:fs/promises') as Record<
  'open' | 'lstat' | 'readdir',
  (...args: unknown[]) => Promise<unknown>
>;

/**
 * Holds the next call `name` of the file system on `file` until `release` is called, `at` resolving as it is held: a
 * read of the reader in flight, at the moment the test chooses.
 */
function holdCall(name: 'open' | 'readdir', file: string): { at: Promise<void>; release: () => void } {
  const call = fsPromises[name];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const at = new Promise<void>((resolve) => (reached = resolve));
  fsPromises[name] = async (...args: unknown[]) => {
    if (args[0] === file) {
      fsPromises[name] = call;
      syncBuiltinESMExports();
      reached();
      await released;
    }
    return call(...args);
  };
  syncBuiltinESMExports();
  return { at, release };
}

/** A reader of the attempt `base` in `traces`, into a store of its own, with what it kept and said. */
function readerOf(traces: string, name: string, titleOf?: (call: string) => string | null) {
  const store = new RunInspect(undefined, DESKTOP_INSPECT_WORDS);
  const kept: DesktopInspectNotice[] = [];
  const refused: string[] = [];
  const reader = new DesktopTraceReader({
    trace: { traces, base: name },
    store,
    key: '0',
    worker: 3,
    test: 'shop › shows the password',
    titleOf,
    kept: (notice) => void kept.push(notice),
    refused: (text) => void refused.push(text),
    readMs: 20,
  });
  return { reader, store, kept, refused };
}

/** A frame-snapshot line of the frame `frame` of `page` (its main frame unless `main` is false), at `call`'s `phase`. */
function snapshotLine(
  call: string,
  phase: string,
  html: unknown,
  frame = 'frame@1',
  page = 'page@1',
  main = true,
): string {
  return JSON.stringify({
    type: 'frame-snapshot',
    snapshot: {
      callId: call,
      phase,
      pageId: page,
      frameId: frame,
      frameUrl: 'https://shop.test/',
      html,
      viewport: { width: 800, height: 600 },
      wallTime: 1_794_487_222_117,
      isMainFrame: main,
    },
  });
}

/** A `before` line of the call `call`, of the method `method` with `params`. */
function beforeLine(call: string, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'before', callId: call, method, params });
}

describe.skipIf(!chromium)('the reader of a lane’s trace, on a trace a browser writes', () => {
  it('keeps each call’s page as its trace took it, its secrets hidden, its styles and images in it, no script', async () => {
    const traces = path.join(root, 'live', '.playwright-artifacts-0', 'traces');
    const browser = await chromium!.launch({ tracesDir: traces });
    try {
      const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
      await context.tracing.start({ snapshots: true, screenshots: false, name: 'attempt' });
      const page = await context.newPage();
      await page.goto(base);
      await page.getByLabel('Password').fill(SECRET);
      await page.getByRole('button', { name: 'Show' }).click();
      expect(await page.locator('#echo').textContent()).toBe(SECRET);

      // The trace grows as the test runs: read it now, without stopping it.
      const own = readerOf(traces, 'attempt', (call) => (call === 'never' ? 'never' : null));
      await own.reader.turn();
      await own.reader.turn();
      const clicked = await waitFor(() => own.kept.find((n) => n.title === 'click' && n.phase === 'after'));
      expect(clicked).toMatchObject({
        type: 'snapshot',
        shard: null,
        worker: 3,
        main: true,
        test: 'shop › shows the password',
      });
      expect(new Set(own.kept.map((n) => n.title))).toEqual(new Set(['goto', 'fill', 'click', 'textContent']));
      const rendered = await own.store.render('0', clicked.call, 'after');
      if ('status' in rendered) throw new Error(rendered.message);
      expect(rendered.viewport).toEqual({ width: 800, height: 600 });
      expect(rendered.html).toContain('Shop');
      // What the password field held is hidden, in it and wherever the page shows it.
      expect(rendered.html).not.toContain(SECRET);
      expect(rendered.html).toContain('<p id="echo">&lt;hidden></p>');
      // Its stylesheet and the image it names are in the page as data; the script and the SVG are not.
      expect(rendered.html).toContain('rgb(1, 2, 3)');
      expect(rendered.html).toContain('data:image/png;base64,');
      expect(rendered.html).not.toMatch(/<script/i);
      expect(rendered.html).not.toContain('window.ran');
      expect(rendered.html).not.toContain('alert(1)');
      expect(own.store.size().counts.resources).toBe(2);
      // The text the test typed hides the same value in a page taken before it showed anywhere else.
      const filled = own.kept.find((n) => n.title === 'fill' && n.phase === 'after')!;
      const before = await own.store.render('0', filled.call, 'after');
      expect('html' in before && before.html).not.toContain(SECRET);
      own.reader.close();

      // A runner's title of a call, as the lane's layers named it, names its pages; the text it types hidden.
      const titled = readerOf(traces, 'attempt', () => `Fill "${SECRET}" getByLabel('Password')`);
      await titled.reader.turn();
      await titled.reader.turn();
      await waitFor(() => titled.kept.length >= own.kept.length);
      expect(titled.kept.every((n) => !n.title.includes(SECRET))).toBe(true);
      titled.reader.close();
    } finally {
      await browser.close();
    }
  });

  it('reads no file through a link, and no resource but from the trace folder’s own resources', async () => {
    const traces = path.join(root, 'linked', '.playwright-artifacts-0', 'traces');
    const browser = await chromium!.launch({ tracesDir: traces });
    try {
      const context = await browser.newContext();
      await context.tracing.start({ snapshots: true, screenshots: false, name: 'real' });
      const page = await context.newPage();
      await page.goto(base);
      // The attempt's file is a link to the real trace: nothing of it is read.
      fs.symlinkSync(path.join(traces, 'real.trace'), path.join(traces, 'linked.trace'));
      fs.symlinkSync(path.join(traces, 'real.network'), path.join(traces, 'linked.network'));
      const linked = readerOf(traces, 'linked');
      await linked.reader.turn();
      expect(linked.kept).toEqual([]);
      linked.reader.close();
      // A resources folder that is a link stops the reading, saying why: nothing of the trace is kept.
      const moved = path.join(root, 'linked', 'resources-elsewhere');
      fs.renameSync(path.join(traces, 'resources'), moved);
      fs.symlinkSync(moved, path.join(traces, 'resources'));
      const real = readerOf(traces, 'real');
      await real.reader.turn();
      expect(real.refused).toEqual([MOVED]);
      expect(real.kept).toEqual([]);
      expect(real.store.size().counts).toEqual({ snapshots: 0, resources: 0 });
      real.reader.close();
    } finally {
      await browser.close();
    }
  });
});

describe('the reader of a lane’s trace, on a trace written by hand', () => {
  it('starts from each page’s last navigation as Inspect opens, then keeps each new page', async () => {
    const traces = path.join(root, 'hand', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    const file = path.join(traces, 't1.trace');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'before', callId: 'c@1', method: 'goto', params: { url: 'https://shop.test/' } }),
        snapshotLine('c@1', 'after', ['HTML', {}, ['BODY', {}, 'First page']]),
        JSON.stringify({ type: 'before', callId: 'c@2', method: 'goto', params: { url: 'https://shop.test/b' } }),
        snapshotLine('c@2', 'after', ['HTML', {}, ['BODY', {}, 'Second page']]),
        JSON.stringify({ type: 'before', callId: 'c@3', method: 'click', params: { selector: 'text=Pay' } }),
        snapshotLine('c@3', 'before', ['HTML', {}, [[1, 1]]]),
        '',
      ].join('\n'),
    );
    const own = readerOf(traces, 't1');
    await own.reader.turn();
    expect(own.kept.map((n) => [n.call, n.phase, n.index, n.full])).toEqual([
      ['c@2', 'after', 1, true],
      ['c@3', 'before', 2, false],
    ]);
    const built = await own.store.render('0', 'c@3', 'before');
    expect('html' in built && built.html).toContain('Second page');
    // A later line, as the trace grows.
    fs.appendFileSync(file, `${snapshotLine('c@3', 'after', ['HTML', {}, ['BODY', {}, 'Paid']])}\n`);
    await own.reader.turn();
    expect(own.kept.at(-1)).toMatchObject({ call: 'c@3', phase: 'after', index: 3 });
    expect(own.refused).toEqual([]);
    own.reader.close();
  });

  it('stops reading, saying why, once the trace folder became a link', async () => {
    const folder = path.join(root, 'swapped');
    const traces = path.join(folder, '.playwright-artifacts-0', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    fs.writeFileSync(path.join(traces, 't1.trace'), `${snapshotLine('c@1', 'after', ['HTML', {}, 'Checked'])}\n`);
    const elsewhere = path.join(folder, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(
      path.join(elsewhere, 't1.trace'),
      [
        snapshotLine('c@1', 'after', ['HTML', {}, 'Checked']),
        snapshotLine('c@2', 'after', ['HTML', {}, 'Elsewhere']),
        '',
      ].join('\n'),
    );
    const own = readerOf(traces, 't1');
    await own.reader.turn();
    expect(own.kept.map((n) => n.call)).toEqual(['c@1']);
    fs.renameSync(traces, path.join(folder, 'moved'));
    fs.symlinkSync(elsewhere, traces);
    await own.reader.turn();
    expect(own.kept.map((n) => n.call)).toEqual(['c@1']);
    expect(own.refused).toEqual([MOVED]);
    await own.reader.turn();
    expect(own.refused).toEqual([MOVED]);
    own.reader.close();

    // Swapped as a read lists the folder: no file is opened through the link.
    fs.unlinkSync(traces);
    fs.renameSync(path.join(folder, 'moved'), traces);
    const late = readerOf(traces, 't1');
    const held = holdCall('readdir', traces);
    const turn = late.reader.turn();
    await held.at;
    fs.renameSync(traces, path.join(folder, 'moved'));
    fs.symlinkSync(elsewhere, traces);
    held.release();
    await turn;
    expect(late.kept).toEqual([]);
    expect(late.refused).toEqual([MOVED]);
    late.reader.close();
  });

  it('names a call’s pages by the runner’s title of its step, as the trace’s call names it', async () => {
    const traces = path.join(root, 'steps', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    fs.writeFileSync(
      path.join(traces, 't1.trace'),
      [
        JSON.stringify({ type: 'before', callId: 'call@5', stepId: 'step@9', method: 'click' }),
        snapshotLine('call@5', 'after', ['HTML', {}, ['BODY', {}, 'Paid']]),
        '',
      ].join('\n'),
    );
    const runner = new Map([['step@9', "Click getByRole('button', { name: 'Pay' })"]]);
    const own = readerOf(traces, 't1', (call) => runner.get(call) ?? null);
    await own.reader.turn();
    expect(own.kept.map((n) => [n.call, n.title])).toEqual([['step@9', "Click getByRole('button', { name: 'Pay' })"]]);
    own.reader.close();
  });

  it('says a trace takes no DOM snapshots once its calls came with none, and keeps nothing of another frame', async () => {
    const traces = path.join(root, 'none', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    fs.writeFileSync(
      path.join(traces, 't2.trace'),
      [
        ...['c@1', 'c@2', 'c@3'].map((call) => JSON.stringify({ type: 'before', callId: call, method: 'click' })),
        JSON.stringify({
          type: 'frame-snapshot',
          snapshot: {
            callId: 'c@3',
            phase: 'after',
            pageId: 'page@1',
            frameId: 'frame@9',
            html: ['HTML', {}],
            isMainFrame: false,
          },
        }),
        '',
      ].join('\n'),
    );
    const own = readerOf(traces, 't2');
    await own.reader.turn();
    expect(own.kept).toEqual([]);
    expect(own.refused).toEqual([]);
    fs.writeFileSync(
      path.join(traces, 't3.trace'),
      `${['c@1', 'c@2', 'c@3'].map((call) => JSON.stringify({ type: 'before', callId: call, method: 'click' })).join('\n')}\n`,
    );
    const none = readerOf(traces, 't3');
    await none.reader.turn();
    expect(none.refused).toEqual([
      "Inspect has no page to show: this test's trace takes no DOM snapshots (its trace option's snapshots, or their dom, is off).",
    ]);
    own.reader.close();
    none.reader.close();
  });
});

describe('the secrets a trace’s fields held', () => {
  const PASSWORD = 'S3cret-Passw0rd!';
  /** A page whose new password field holds it, filled through a locator that names no secret. */
  const FILLED = ['HTML', {}, ['BODY', {}, ['INPUT', { id: 'new', type: 'password', __playwright_value_: PASSWORD }]]];
  /** The page after it, which shows it as text. */
  const ECHOED = ['HTML', {}, ['BODY', {}, ['P', {}, `Your new password is ${PASSWORD}`]]];

  async function shown(traces: string, call: string, read: (own: ReturnType<typeof readerOf>) => Promise<void>) {
    const own = readerOf(traces, 't1');
    await read(own);
    const page = await own.store.render('0', call, 'after');
    own.reader.close();
    if ('status' in page) throw new Error(page.message);
    return { html: page.html, refused: own.refused };
  }

  it('are hidden in a page Inspect opens on after the page that held them navigated', async () => {
    const traces = path.join(root, 'held-before', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    fs.writeFileSync(
      path.join(traces, 't1.trace'),
      [
        beforeLine('c@1', 'fill', { selector: '#new', value: PASSWORD }),
        snapshotLine('c@1', 'after', FILLED),
        beforeLine('c@2', 'click', { selector: 'text=Save' }),
        snapshotLine('c@2', 'after', ECHOED),
        '',
      ].join('\n'),
    );
    const { html } = await shown(traces, 'c@2', (own) => own.reader.turn());
    expect(html).not.toContain(PASSWORD);
    expect(html).toContain('Your new password is &lt;hidden>');
  });

  it('are hidden in a page that navigated in the same read as the page that held them', async () => {
    const traces = path.join(root, 'held-same-read', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    const file = path.join(traces, 't1.trace');
    fs.writeFileSync(
      file,
      `${snapshotLine('c@0', 'after', ['HTML', {}, ['BODY', {}, ['INPUT', { id: 'new', type: 'password' }]]])}\n`,
    );
    const { html } = await shown(traces, 'c@2', async (own) => {
      await own.reader.turn();
      fs.appendFileSync(
        file,
        [
          beforeLine('c@1', 'fill', { selector: '#new', value: PASSWORD }),
          snapshotLine('c@1', 'after', FILLED),
          snapshotLine('c@2', 'after', ECHOED),
          '',
        ].join('\n'),
      );
      await own.reader.turn();
    });
    expect(html).not.toContain(PASSWORD);
  });

  it('are hidden in the main frame when a frame in it held them', async () => {
    const traces = path.join(root, 'held-in-frame', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    fs.writeFileSync(
      path.join(traces, 't1.trace'),
      [
        beforeLine('c@1', 'fill', { selector: 'iframe >> internal:control=enter-frame >> #f1', value: PASSWORD }),
        snapshotLine(
          'c@1',
          'after',
          [
            'HTML',
            {},
            ['BODY', {}, ['LABEL', { for: 'f1' }, 'PIN'], ['INPUT', { id: 'f1', __playwright_value_: PASSWORD }]],
          ],
          'frame@2',
          'page@1',
          false,
        ),
        snapshotLine('c@1', 'after', ['HTML', {}, ['BODY', {}, ['IFRAME', {}], ['P', {}, `Code: ${PASSWORD}`]]]),
        '',
      ].join('\n'),
    );
    const { html } = await shown(traces, 'c@1', (own) => own.reader.turn());
    expect(html).not.toContain(PASSWORD);
  });

  it('stop the main frame’s pages, saying why, while a frame in it cannot be read whole', async () => {
    const traces = path.join(root, 'unread-frame', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    const file = path.join(traces, 't1.trace');
    fs.writeFileSync(
      file,
      [
        snapshotLine('c@1', 'after', ['HTML', {}, ['BODY', {}, ['IFRAME', {}], ['P', {}, 'Before']]]),
        // A frame's snapshot that names a node of one the trace never held: what its fields hold cannot be read.
        snapshotLine(
          'c@2',
          'after',
          ['HTML', {}, ['BODY', {}, ['LABEL', { for: 'pin' }, [[3, 0]]], ['INPUT', { id: 'pin' }]]],
          'frame@2',
          'page@1',
          false,
        ),
        snapshotLine('c@2', 'after', ['HTML', {}, [[1, 3]], ['P', {}, 'After']]),
        '',
      ].join('\n'),
    );
    const own = readerOf(traces, 't1');
    await own.reader.turn();
    expect(own.kept.map((n) => n.call)).toEqual(['c@1']);
    expect(own.refused).toEqual([UNREAD_FRAME]);
    // Its next navigation shows it again.
    fs.appendFileSync(file, `${snapshotLine('c@3', 'after', ['HTML', {}, ['BODY', {}, 'Next']])}\n`);
    await own.reader.turn();
    expect(own.kept.map((n) => n.call)).toEqual(['c@1', 'c@3']);
    own.reader.close();
  });
});

describe('what a reader holds of the trace', () => {
  /** A page of `count` items: its snapshot's line is some 40 bytes an item. */
  function page(count: number, text: string): unknown[] {
    const body: unknown[] = ['BODY', {}, ['P', {}, text]];
    for (let i = 0; i < count; i++) body.push(['DIV', { class: `c${i % 50}` }, `item ${i}`]);
    return ['HTML', {}, body];
  }

  function readerWith(traces: string, budget: InspectBudget) {
    const store = new RunInspect(budget, DESKTOP_INSPECT_WORDS);
    const kept: DesktopInspectNotice[] = [];
    const refused: string[] = [];
    const reader = new DesktopTraceReader({
      trace: { traces, base: 't1' },
      store,
      key: '0',
      worker: 0,
      test: null,
      budget,
      kept: (notice) => void kept.push(notice),
      refused: (text) => void refused.push(text),
      readMs: 10_000,
    });
    return { reader, store, kept, refused };
  }

  /** What the store holds against the budget: its snapshots, resources and pages rendered. */
  const held = (store: RunInspect) => {
    const { snapshots, resources, pages } = store.size();
    return snapshots + resources + pages;
  };

  it('counts the snapshots it parsed against the budget every lane shares, and gives them back as it closes', async () => {
    const traces = path.join(root, 'counted', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    const line = snapshotLine('c@1', 'after', page(5000, 'Cart'));
    fs.writeFileSync(path.join(traces, 't1.trace'), `${line}\n`);
    const budget = new InspectBudget(256 * 1024 * 1024);
    const own = readerWith(traces, budget);
    await own.reader.turn();
    expect(own.kept.map((n) => n.call)).toEqual(['c@1']);
    // The parsed snapshot its frame's chain keeps for the references of the next counts some three times its line.
    expect(budget.used - held(own.store)).toBeGreaterThanOrEqual(3 * line.length);
    own.reader.close();
    expect(budget.used).toBe(held(own.store));
    own.store.clear();
    expect(budget.used).toBe(0);
  });

  it('keeps no page whose parsed snapshot the shared budget has no room for, saying why', async () => {
    const traces = path.join(root, 'no-room', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    const line = snapshotLine('c@1', 'after', page(5000, 'Cart'));
    fs.writeFileSync(path.join(traces, 't1.trace'), `${line}\n`);
    const own = readerWith(traces, new InspectBudget(2 * line.length));
    await own.reader.turn();
    expect(own.kept).toEqual([]);
    expect(own.refused).toEqual([
      'The page is not shown: the desktop app keeps no more pages for Inspect now. Inspect shows it again from its next navigation.',
    ]);
    own.reader.close();
  });

  it('remembers a bounded number of frames and of the stylesheets it read', async () => {
    const traces = path.join(root, 'frames', 'traces');
    fs.mkdirSync(path.join(traces, 'resources'), { recursive: true });
    const lines: string[] = [];
    const network: string[] = [];
    for (let i = 0; i < 1500; i++) {
      const sha1 = `${i.toString(16).padStart(40, '0')}.css`;
      fs.writeFileSync(path.join(traces, 'resources', sha1), `@import url(/n${i}.css); body { color: red }`);
      network.push(
        JSON.stringify({
          type: 'resource-snapshot',
          snapshot: {
            pageref: 'page@1',
            request: { url: `https://shop.test/s${i}.css` },
            response: { content: { _sha1: sha1, mimeType: 'text/css' } },
          },
        }),
      );
      lines.push(
        snapshotLine(`c@${i}`, 'after', ['HTML', {}, ['BODY', {}, `in frame ${i}`]], `frame@${i + 2}`, 'page@1', false),
      );
      lines.push(
        snapshotLine(`c@${i}`, 'after', [
          'HTML',
          {},
          ['HEAD', {}, ['LINK', { rel: 'stylesheet', href: `/s${i}.css` }]],
        ]),
      );
    }
    fs.writeFileSync(path.join(traces, 't1.network'), `${network.join('\n')}\n`);
    fs.writeFileSync(path.join(traces, 't1.trace'), `${lines.join('\n')}\n`);
    const own = readerOf(traces, 't1');
    await own.reader.turn();
    const state = own.reader as unknown as { frames: Map<string, unknown>; cssNames: Map<string, unknown> };
    expect(state.frames.size).toBeLessThanOrEqual(1024);
    expect(state.cssNames.size).toBeLessThanOrEqual(256);
    expect(own.kept.at(-1)).toMatchObject({ call: 'c@1499' });
    own.reader.close();
  });
});

describe('a long trace', () => {
  it('is caught up with in slices the server’s other work runs between, its latest pages kept', async () => {
    const traces = path.join(root, 'long', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    const file = path.join(traces, 't1.trace');
    const out = fs.openSync(file, 'w');
    const count = 100_000;
    fs.writeSync(out, `${snapshotLine('call@0', 'after', ['HTML', {}, ['P', {}, 'start']])}\n`);
    for (let from = 1; from <= count; from += 10_000) {
      const lines: string[] = [];
      for (let i = from; i < from + 10_000 && i <= count; i++) {
        lines.push(snapshotLine(`call@${i}`, 'after', ['HTML', {}, [[1, 1]], ['P', {}, `n${i}`]]));
      }
      fs.writeSync(out, `${lines.join('\n')}\n`);
    }
    fs.closeSync(out);
    const own = readerOf(traces, 't1');
    let last = performance.now();
    let longest = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 1);
    try {
      own.reader.start();
      await waitFor(() => own.kept.at(-1)?.call === `call@${count}`, 60_000);
    } finally {
      clearInterval(tick);
      own.reader.close();
    }
    expect(longest).toBeLessThan(150);
    // As many pages as the store keeps of a lane wait as Inspect opens: the navigation's, then the latest.
    expect(own.kept).toHaveLength(MAX_WORKER_SNAPSHOT_COUNT);
    expect(own.kept[0]).toMatchObject({ call: 'call@0', full: true });
    expect(own.kept[1]).toMatchObject({ call: `call@${count - MAX_WORKER_SNAPSHOT_COUNT + 2}` });
    const latest = await own.store.render('0', `call@${count}`, 'after');
    expect('html' in latest && latest.html).toContain(`n${count}`);
  }, 120_000);
});

describe.skipIf(process.platform === 'win32')('a file of the trace that is a named pipe as it opens', () => {
  it('is not read, and the reader goes on', async () => {
    const traces = path.join(root, 'pipe', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    const file = path.join(traces, 't1.trace');
    fs.writeFileSync(file, `${snapshotLine('c@1', 'after', ['HTML', {}, ['BODY', {}, 'Cart']])}\n`);
    const pipe = path.join(traces, 't1.network');
    execFileSync('mkfifo', [pipe]);
    // The pipe is a regular file when looked at, and a named pipe as it opens: a file renamed over it in between.
    const lstat = fsPromises.lstat;
    fsPromises.lstat = (...args: unknown[]) => lstat(args[0] === pipe ? file : args[0], ...args.slice(1));
    syncBuiltinESMExports();
    const own = readerOf(traces, 't1');
    try {
      const turn = own.reader.turn().then(() => 'read');
      const late = new Promise((resolve) => setTimeout(() => resolve('waiting on the pipe'), 2000));
      expect(await Promise.race([turn, late])).toBe('read');
      expect(own.kept.map((n) => n.call)).toEqual(['c@1']);
    } finally {
      fsPromises.lstat = lstat;
      syncBuiltinESMExports();
      own.reader.close();
      // A read still waiting on the pipe opens as a writer comes.
      try {
        fs.closeSync(fs.openSync(pipe, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
      } catch {
        // No read waits on it.
      }
    }
  });
});

describe('a reader that closes while it reads', () => {
  it('gives back to the shared budget whatever a read in flight brings', async () => {
    const traces = path.join(root, 'budget', 'traces');
    fs.mkdirSync(path.join(traces, 'resources'), { recursive: true });
    const sha1 = `${'d'.repeat(40)}.png`;
    const image = path.join(traces, 'resources', sha1);
    fs.writeFileSync(image, Buffer.concat([PNG, Buffer.alloc(64 * 1024)]));
    fs.writeFileSync(
      path.join(traces, 't1.network'),
      `${JSON.stringify({
        type: 'resource-snapshot',
        snapshot: {
          pageref: 'page@1',
          request: { url: 'https://shop.test/logo.png' },
          response: { content: { _sha1: sha1, mimeType: 'image/png' } },
        },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(traces, 't1.trace'),
      `${snapshotLine('c@1', 'after', ['HTML', {}, ['BODY', {}, ['IMG', { src: '/logo.png' }]]])}\n`,
    );
    const budget = new InspectBudget(256 * 1024 * 1024);
    const store = new RunInspect(budget, DESKTOP_INSPECT_WORDS);
    const reader = new DesktopTraceReader({
      trace: { traces, base: 't1' },
      store,
      key: '0',
      worker: 0,
      test: null,
      kept: () => undefined,
      refused: () => undefined,
      readMs: 10_000,
    });
    const held = holdCall('open', image);
    const turn = reader.turn();
    await held.at;
    // The lane stops reading as the image is read: the reader closes, then its store lets everything go.
    reader.close();
    store.clear();
    held.release();
    await turn;
    expect(budget.used).toBe(0);
    expect(store.size().counts).toEqual({ snapshots: 0, resources: 0 });
  });

  it('tells nothing of what the read in flight finds', async () => {
    const traces = path.join(root, 'closing', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    const file = path.join(traces, 't1.trace');
    fs.writeFileSync(
      file,
      `${['c@1', 'c@2', 'c@3'].map((call) => JSON.stringify({ type: 'before', callId: call, method: 'click' })).join('\n')}\n`,
    );
    const own = readerOf(traces, 't1');
    const held = holdCall('open', file);
    const turn = own.reader.turn();
    await held.at;
    own.reader.close();
    held.release();
    await turn;
    expect(own.refused).toEqual([]);
  });
});

/** A run `desktop-7` whose lane 0's worker runs the attempt `test` (none between tests). */
function sessionOf(test: { id: string; retry: number } | null, ended = false): RunSession {
  return {
    ref: 'desktop-7',
    root: '/home/dev/shop',
    ended,
    workers: [
      {
        worker: 5,
        parallelIndex: 0,
        state: test ? 'running' : 'between',
        test: test
          ? {
              ...test,
              title: ['shop', 'pays'],
              uri: 'file:///home/dev/shop/a.spec.ts',
              line: 1,
              project: '',
              cannotPause: null,
            }
          : null,
        stop: null,
        takes: [],
        watchable: true,
        layers: true,
        showsWindow: false,
        pausing: false,
      },
    ],
  } as unknown as RunSession;
}

describe('the lanes the windows have Inspect open on', () => {
  const VIEWER = 'a'.repeat(32);
  const OTHER = 'b'.repeat(32);

  function lanes(answers: Array<LaneTrace | { ok: false; message: string }>) {
    let session = sessionOf({ id: 't1', retry: 0 });
    const asked: number[] = [];
    const heard: Array<{ viewer: string; event: DesktopInspectEvent }> = [];
    const sessions: DesktopInspectSessions = {
      current: () => [session],
      laneTrace: async ({ lane }) => {
        asked.push(lane);
        return answers.shift() ?? { ok: false, message: 'No more answers.' };
      },
    };
    const inspects = new DesktopInspects({
      sessions,
      send: (viewer, event) => void heard.push({ viewer, event }),
      readMs: 20,
      askAgainMs: 30,
    });
    return {
      inspects,
      asked,
      heard,
      set: (next: RunSession) => {
        session = next;
        inspects.sessionChanged(next);
      },
    };
  }

  it('follows the lane’s attempt, says the worker’s sentence while it names no trace, and asks it again', async () => {
    const traces = path.join(root, 'lanes', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    fs.writeFileSync(
      path.join(traces, 't1.trace'),
      `${snapshotLine('c@1', 'after', ['HTML', {}, ['BODY', {}, 'Cart']])}\n`,
    );
    const untraced = "This test's attempt is not traced: its project's trace option records none of it.";
    const found: LaneTrace = {
      ok: true,
      root: '/home/dev/shop',
      traces,
      base: 't1',
      file: path.join(traces, 't1.trace'),
      worker: 5,
      test: { id: 't1', retry: 0 },
    };
    const own = lanes([{ ok: false, message: untraced }, found]);
    expect(own.inspects.open(VIEWER, 'desktop-7', 0)).toMatchObject({ ok: true });
    expect(own.heard[0]).toEqual({
      viewer: VIEWER,
      event: { type: 'inspect', ref: 'desktop-7', lane: 0, attempt: 't1#0' },
    });
    await waitFor(() => own.heard.find((h) => 'refused' in h.event && h.event.refused === untraced));
    // Asked again a while later, the trace is read: the window hears the page.
    const kept = await waitFor(() => own.heard.find((h) => 'snapshot' in h.event && h.event.snapshot));
    expect(kept.event).toMatchObject({
      attempt: 't1#0',
      snapshot: { call: 'c@1', phase: 'after', worker: 5, test: 'shop › pays' },
    });
    expect(own.asked).toEqual([0, 0]);
    expect(own.inspects.calls(VIEWER, 'desktop-7', 0)).toMatchObject({
      attempt: 't1#0',
      heard: [{ call: 'c@1', phase: 'after', worker: 5, shard: null }],
      refused: null,
    });
    const page = await own.inspects.page(VIEWER, 'desktop-7', 0, 'c@1', 'after');
    expect('html' in page && page.html).toContain('Cart');
    // A window that has it not open hears and reads none of it.
    expect(own.inspects.calls(OTHER, 'desktop-7', 0)).toBeNull();
    expect(await own.inspects.page(OTHER, 'desktop-7', 0, 'c@1', 'after')).toMatchObject({ status: 409 });
    expect(own.heard.every((h) => h.viewer === VIEWER)).toBe(true);
    expect(JSON.stringify(own.heard)).not.toContain(traces);

    // The test ends: what was kept of it goes, and the window hears the lane runs none.
    own.set(sessionOf(null));
    expect(own.heard.at(-1)!.event).toEqual({ type: 'inspect', ref: 'desktop-7', lane: 0, attempt: null });
    expect(await own.inspects.page(VIEWER, 'desktop-7', 0, 'c@1', 'after')).toEqual({
      status: 404,
      message: DESKTOP_INSPECT_WORDS.missing,
    });
    // The next test: its trace is asked for.
    own.set(sessionOf({ id: 't2', retry: 0 }));
    expect(own.heard.at(-1)!.event).toMatchObject({ attempt: 't2#0' });
    await waitFor(() => own.asked.length === 3);
    // The last window to close it stops it: nothing is asked again, and its pages are gone.
    own.inspects.close(VIEWER, 'desktop-7', 0);
    expect(own.inspects.calls(VIEWER, 'desktop-7', 0)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(own.asked).toHaveLength(3);
  });

  it('tells the windows nothing of an attempt’s trace once the lane follows the next one', async () => {
    const traces = path.join(root, 'next', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    const file = path.join(traces, 't1.trace');
    fs.writeFileSync(
      file,
      `${['c@1', 'c@2', 'c@3'].map((call) => JSON.stringify({ type: 'before', callId: call, method: 'click' })).join('\n')}\n`,
    );
    const untraced = "This test's attempt is not traced: its project's trace option records none of it.";
    const found: LaneTrace = {
      ok: true,
      root: '/home/dev/shop',
      traces,
      base: 't1',
      file,
      worker: 5,
      test: { id: 't1', retry: 0 },
    };
    const own = lanes([found, ...Array.from({ length: 20 }, () => ({ ok: false as const, message: untraced }))]);
    const held = holdCall('open', file);
    own.inspects.open(VIEWER, 'desktop-7', 0);
    await held.at;
    // The test ends and the next begins while the reader of the first one reads.
    own.set(sessionOf({ id: 't2', retry: 0 }));
    await waitFor(() => own.inspects.calls(VIEWER, 'desktop-7', 0)?.refused === untraced);
    held.release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(own.heard.filter((h) => h.event.refused).map((h) => [h.event.attempt, h.event.refused])).toEqual([
      ['t2#0', untraced],
    ]);
    expect(own.inspects.calls(VIEWER, 'desktop-7', 0)).toMatchObject({ attempt: 't2#0', refused: untraced });
    own.inspects.dispose();
  });

  it('ends with the run and with a window that leaves, and refuses a run that ended or a lane it has not', async () => {
    const own = lanes([]);
    expect(own.inspects.open(VIEWER, 'desktop-9', 0)).toEqual({ ok: false, message: 'The run has ended.' });
    expect(own.inspects.open(VIEWER, 'desktop-7', 4)).toEqual({ ok: false, message: 'This run has no worker 5 now.' });
    own.inspects.open(VIEWER, 'desktop-7', 0);
    own.inspects.open(OTHER, 'desktop-7', 0);
    own.inspects.leave(VIEWER);
    expect(own.inspects.calls(OTHER, 'desktop-7', 0)).not.toBeNull();
    own.set(sessionOf({ id: 't1', retry: 0 }, true));
    expect(own.heard.at(-1)).toEqual({
      viewer: OTHER,
      event: { type: 'inspect', ref: 'desktop-7', lane: 0, attempt: null },
    });
    expect(own.inspects.calls(OTHER, 'desktop-7', 0)).toBeNull();
    own.inspects.dispose();
  });

  it('reads the window, run, lane, call and moment a request names, one by one', () => {
    expect(readDesktopInspectLane({ viewer: 'a'.repeat(32), ref: 'desktop-7', lane: '2' })).toEqual({
      viewer: 'a'.repeat(32),
      ref: 'desktop-7',
      lane: 2,
    });
    for (const bad of [
      { viewer: 'A'.repeat(32), ref: 'desktop-7', lane: '2' },
      { viewer: 'a'.repeat(32), ref: '../x', lane: '2' },
      { viewer: 'a'.repeat(32), ref: 'desktop-7', lane: '-1' },
      { viewer: 'a'.repeat(32), ref: 'desktop-7', lane: '2x' },
    ]) {
      expect(readDesktopInspectLane(bad)).toBeNull();
    }
    expect(readDesktopInspectMoment({ call: 'call@4', phase: 'action' })).toEqual({ call: 'call@4', phase: 'action' });
    expect(readDesktopInspectMoment({ call: 'call@4', phase: 'during' })).toBeNull();
    expect(readDesktopInspectMoment({ call: '<x>', phase: 'after' })).toBeNull();
  });
});
