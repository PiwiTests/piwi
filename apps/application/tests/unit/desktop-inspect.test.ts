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
import { RunInspect } from '../../server/utils/live-inspect';

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

/** Node's file system promises, as the reader calls them: a test holds one of its calls with `holdOpen`. */
const fsPromises = requireHere('node:fs/promises') as { open: (...args: unknown[]) => Promise<unknown> };

/**
 * Holds the next opening of `file` until `release` is called, `at` resolving as it is held: a read of the reader in
 * flight, at the moment the test chooses.
 */
function holdOpen(file: string): { at: Promise<void>; release: () => void } {
  const open = fsPromises.open;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const at = new Promise<void>((resolve) => (reached = resolve));
  fsPromises.open = async (...args: unknown[]) => {
    if (args[0] === file) {
      fsPromises.open = open;
      syncBuiltinESMExports();
      reached();
      await released;
    }
    return open(...args);
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

/** A frame-snapshot line of the main frame `frame` of `page`, at `call`'s `phase`. */
function snapshotLine(call: string, phase: string, html: unknown, frame = 'frame@1', page = 'page@1'): string {
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
      isMainFrame: true,
    },
  });
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
      // A resources folder that is a link is never read: the page shows without its styles.
      const moved = path.join(root, 'linked', 'resources-elsewhere');
      fs.renameSync(path.join(traces, 'resources'), moved);
      fs.symlinkSync(moved, path.join(traces, 'resources'));
      const real = readerOf(traces, 'real');
      await real.reader.turn();
      const shown = await waitFor(() => real.kept.find((n) => n.title === 'goto'));
      const rendered = await real.store.render('0', shown.call, shown.phase);
      expect('html' in rendered && rendered.html).toContain('Shop');
      expect('html' in rendered && rendered.html).not.toContain('rgb(1, 2, 3)');
      expect(real.store.size().counts.resources).toBe(0);
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

describe('a reader that closes while it reads', () => {
  it('tells nothing of what the read in flight finds', async () => {
    const traces = path.join(root, 'closing', 'traces');
    fs.mkdirSync(traces, { recursive: true });
    const file = path.join(traces, 't1.trace');
    fs.writeFileSync(
      file,
      `${['c@1', 'c@2', 'c@3'].map((call) => JSON.stringify({ type: 'before', callId: call, method: 'click' })).join('\n')}\n`,
    );
    const own = readerOf(traces, 't1');
    const held = holdOpen(file);
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
    const held = holdOpen(file);
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
