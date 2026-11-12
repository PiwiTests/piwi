import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { LaneText } from '@piwitests/core/live-layers';
import {
  LaneFilmstrip,
  LaneTexts,
  attemptTraceFile,
  layersTestBegan,
  layersTestEnded,
  takeLaneText,
} from '../src/internal/capture/lane-layers.js';
import { followCallLog, listenCalls, trackCalls } from '../src/internal/capture/live-call-log.js';
import { readServerLogs } from '../src/internal/capture/run-events.js';
import { playwrightAtLeast } from './_helpers.js';

/**
 * The page's text a lane view sends, read from a real browser and its real growing trace: the trace's latest snapshot
 * of the lane's page alone, masked with every value a secret field held at a read of the attempt and the values its
 * calls typed into a field named for a secret, and no text when a page's fields cannot all be read. A wire takes one
 * text at a time, once a second at most. And what the worker hears of each call costs no lookup nor hiding until a view
 * is told it, nor throws into the call.
 */

/** The trace writes ARIA snapshots from Playwright 1.64 on. */
const TRACE_ARIA = playwrightAtLeast('1.64');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let browser: Browser;
let folder = '';
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ tracesDir: (folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-lane-text-'))) });
});

afterEach(() => layersTestEnded());

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
});

/** A context whose trace writes ARIA snapshots, named `base`, and the test whose layers are of it. */
async function tracedContext(base: string): Promise<BrowserContext> {
  const context = await browser.newContext();
  contexts.push(context);
  await context.tracing.start({ name: base, snapshots: { aria: true } } as never);
  layersTestBegan({
    id: base,
    began: Date.now(),
    titleOf: () => null,
    fixtureCall: () => false,
    trace: { dir: folder, base },
  });
  return context;
}

/** The text a take gave, or why none came. */
function textOf(taken: LaneText | { refused: string } | null): string {
  if (!taken) return 'none';
  return 'refused' in taken ? `refused: ${taken.refused}` : taken.text;
}

describe('the page’s text of a lane', () => {
  it.runIf(TRACE_ARIA)(
    'reads the trace’s latest snapshot of the lane’s page alone, not a later one of another',
    async () => {
      const context = await tracedContext('pages');
      const page = await context.newPage();
      await page.setContent('<h1>Lane page</h1>');
      await page.locator('h1').click();
      const other = await context.newPage();
      await other.setContent('<h1>Other page</h1>');
      await other.locator('h1').click();
      await sleep(300);
      const text = textOf(await takeLaneText(page, [], false));
      expect(text).toContain('Lane page');
      expect(text).not.toContain('Other page');
    },
  );

  it.runIf(TRACE_ARIA)(
    'hides a value a secret field held at an earlier read of the attempt, though it holds it no more',
    async () => {
      const context = await tracedContext('union');
      const page = await context.newPage();
      await page.setContent('<label>Phrase <input id="p" type="password"></label>');
      await page.locator('#p').fill('hunter2xyz');
      await sleep(300);
      const first = textOf(await takeLaneText(page, [], false));
      expect(first).toMatch(/textbox "Phrase": <hidden>/);
      // The field turns plain: a read now finds no secret, and the trace's snapshot still shows its value.
      await page.locator('#p').evaluate((field) => {
        (field as unknown as { type: string }).type = 'text';
      });
      await sleep(300);
      const later = textOf(await takeLaneText(page, [], false));
      expect(later).toMatch(/textbox "Phrase": <hidden>/);
      expect(later).not.toContain('hunter2xyz');
    },
  );

  it('hides a value a call typed into a field named for a secret, or with the keyboard', async () => {
    const hooks: Array<Record<string, (...args: unknown[]) => void>> = [];
    trackCalls({ _instrumentation: { addListener: (listener: (typeof hooks)[number]) => hooks.push(listener) } });
    layersTestBegan({ id: 'typed', began: Date.now(), titleOf: () => null, fixtureCall: () => false, trace: null });
    for (const [method, params] of [
      ['fill', { selector: 'internal:label="PIN"i', value: '7319' }],
      ['fill', { selector: '#note', value: 'kept-note' }],
      ['keyboardType', { text: 'typed-by-keys' }],
    ] as const) {
      hooks[0]!.onApiCallBegin!({}, { method, params });
    }
    const page = await browser.newPage();
    await page.setContent(
      '<label>Note <input value="7319"></label><label>Memo <input value="kept-note"></label><label>Other <input value="typed-by-keys"></label>',
    );
    const text = textOf(await takeLaneText(page, [], true));
    await page.close();
    expect(text).toMatch(/textbox "Note" \[ref=\w+\]: <hidden>/);
    expect(text).toMatch(/textbox "Memo" \[ref=\w+\]: kept-note/);
    expect(text).toMatch(/textbox "Other" \[ref=\w+\]: <hidden>/);
  });

  it('sends no text when a page’s secret fields cannot all be read', async () => {
    layersTestBegan({ id: 'frames', began: Date.now(), titleOf: () => null, fixtureCall: () => false, trace: null });
    const page = await browser.newPage();
    const frames = Array.from({ length: 40 }, (_, i) => `<iframe srcdoc="<input type=password value=f${i}>"></iframe>`);
    await page.setContent(`<label>Phrase <input type="password" value="hunter2xyz"></label>${frames.join('')}`);
    const taken = await takeLaneText(page, [], true);
    await page.close();
    expect(taken).toEqual({ refused: expect.stringMatching(/could not be read/) });
  });

  it('takes one text at a time, once a second at most, the asks that came meanwhile taken once', async () => {
    const takes: boolean[] = [];
    let release = (): void => undefined;
    const texts = new LaneTexts(async (snapshot) => {
      takes.push(snapshot);
      await new Promise<void>((resolve) => (release = resolve));
    });
    texts.ask(false);
    texts.ask(false);
    texts.ask(true);
    texts.ask(false);
    expect(takes).toEqual([false]);
    release();
    await sleep(100);
    expect(takes).toEqual([false]);
    await sleep(1000);
    expect(takes).toEqual([false, true]);
    release();
    await sleep(1100);
    expect(takes).toEqual([false, true]);
    texts.close();
  });
});

describe('the running attempt’s trace file', () => {
  /** A test whose trace the runner writes in `folder` under `base`, as `traced` says it traces it. */
  const began = (base: string, traced?: () => boolean | null) =>
    layersTestBegan({
      id: base,
      began: Date.now(),
      titleOf: () => null,
      fixtureCall: () => false,
      trace: { dir: folder, base },
      traced,
    });

  it('names the attempt’s first context’s file, of its files alone', async () => {
    for (const name of ['owned-recording3.trace', 'owned-recording1.trace', 'owned-other.trace', 'own.trace']) {
      fs.writeFileSync(path.join(folder, name), '{}\n');
    }
    began('owned', () => true);
    expect(await attemptTraceFile()).toEqual({ file: path.join(folder, 'owned-recording1.trace') });
  });

  it('says why there is none: no test, an attempt not traced, one traced before its first context, or not known', async () => {
    layersTestEnded();
    expect(await attemptTraceFile()).toEqual({ none: 'no-test' });
    began('untraced', () => false);
    expect(await attemptTraceFile()).toEqual({ none: 'not-traced' });
    began('early', () => true);
    expect(await attemptTraceFile()).toEqual({ none: 'not-yet' });
    began('unknown', () => null);
    expect(await attemptTraceFile()).toEqual({ none: 'unknown' });
    began('unsaid');
    expect(await attemptTraceFile()).toEqual({ none: 'unknown' });
  });
});

describe('the calls a lane hears', () => {
  it('looks no step up for a call that ends while nobody watches the lane', () => {
    const hooks: Array<Record<string, (...args: unknown[]) => void>> = [];
    trackCalls({ _instrumentation: { addListener: (listener: (typeof hooks)[number]) => hooks.push(listener) } });
    const titleOf = vi.fn(() => 'Click');
    const fixtureCall = vi.fn(() => false);
    layersTestBegan({ id: 'strip', began: Date.now(), titleOf, fixtureCall, trace: null });
    const strip = new LaneFilmstrip(
      () => null,
      () => undefined,
    );
    const zone = { callId: 'pw:api@1' };
    hooks[0]!.onApiCallBegin!(zone, { method: 'click', params: { selector: 'button' } });
    hooks[0]!.onApiCallEnd!(zone);
    strip.close();
    expect(titleOf).not.toHaveBeenCalled();
    expect(fixtureCall).not.toHaveBeenCalled();
  });

  it('hides a call’s title and log as a view is told them, and never throws into the call', async () => {
    const hooks: Record<string, (...args: unknown[]) => void> = {};
    const impl = {
      instrumentation: {
        addListener: (listener: typeof hooks) => Object.assign(hooks, listener),
        removeListener: () => undefined,
      },
    };
    const context = { _connection: { toImpl: () => impl }, once: () => undefined, pages: () => [] };
    const titleOf = vi.fn((id: string) => (id === 'call@1' ? 'Fill "hunter2xyz" getByLabel(\'Password\')' : null));
    listenCalls(context as unknown as BrowserContext, titleOf);
    const meta = { id: 'call@1', method: 'fill', params: { selector: 'internal:label="Password"i' } };
    hooks.onBeforeCall!({ metadata: meta }, {}, undefined);
    hooks.onCallLog!({}, meta, 'api', '  - fill("hunter2xyz")');
    expect(titleOf).not.toHaveBeenCalled();
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('a shape this listener does not know');
        },
      },
    );
    for (const hook of ['onBeforeCall', 'onCallLog', 'onBeforeInputAction', 'onAfterCall']) {
      expect(() => hooks[hook]!(throwing, throwing, 'api', 'x')).not.toThrow();
    }
    const page = { context: () => context, isClosed: () => false, viewportSize: () => null } as unknown as Page;
    const told: unknown[] = [];
    const stop = await followCallLog(page, 0, (log) => told.push(log), { source: 'listener', titleOf });
    stop?.();
    expect(titleOf).toHaveBeenCalledWith('call@1');
    expect(JSON.stringify(told)).toContain('fill(\\"<hidden>\\")');
    expect(JSON.stringify(told)).not.toContain('hunter2xyz');
    const track: Array<Record<string, (...args: unknown[]) => void>> = [];
    trackCalls({ _instrumentation: { addListener: (listener: (typeof track)[number]) => track.push(listener) } });
    expect(() => track[0]!.onApiCallBegin!({}, throwing)).not.toThrow();
  });
});

describe('a backend’s log of a request', () => {
  it('reads none past its bound once gunzipped', () => {
    const small = [{ level: 'error', message: 'boom' }];
    expect(readServerLogs(gzipSync(JSON.stringify(small)).toString('base64'))).toEqual(small);
    const large = [{ level: 'error', message: 'x'.repeat(8 * 1024 * 1024) }];
    expect(readServerLogs(gzipSync(JSON.stringify(large)).toString('base64'))).toBeUndefined();
  });
});
