import * as path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { compressCallLog, MAX_LIVE_CALL_LOG_LINES, type LiveBox, type LiveCallLog } from '@piwitests/core/live-view';
import {
  hideSecretsInLog,
  hideSecretsInText,
  hideTypedText,
  isSecretLocator,
  namesSecretField,
} from '@piwitests/core/mask';
import { internalCall } from './quiet-capture.js';

/**
 * The call a test is in, as Playwright logs it while it runs, for the run page's live view of a CI run
 * (`@piwitests/core/live-view`'s `call-log`). Three sources, each checked before use:
 *
 * - Playwright's call stream (`context.debugger`'s internal `_enable` and its `apicallsupdated` event): each running
 *   call's title, place, status, call log lines, the point an input action acts on, and its error, every half second.
 *   Turning it on tells the calls running then, with their log so far. Once on, it stays on in its context and moves
 *   where the debugger stops an action (before its input rather than before its wait), so `live-view.ts` turns it on
 *   only in a CI run nothing pauses; its calls are followed from then until the context goes, so a viewer who comes
 *   later sees the call shown at once.
 * - The worker's Playwright instrumentation (`trackCalls`): when each call began and the selector of a locator call,
 *   which the call stream does not give, matched to the stream's calls by the id the runner gives each call.
 * - While a call has waited a second, the elements its selector matches, read once a second through `internalCall`:
 *   how many, the first one's box and whether it is enabled. They are read only while the watched page is its
 *   context's one page, so the call is on it, and left out when the call found an element the read finds none of (a
 *   call on a frame of the page); a read that fails leaves the last one.
 *
 * Each text has what may be a secret hidden (`hideTypedText`, `hideSecretsInLog`, `hideSecretsInText`) before it is
 * cut, and the log's lines go folded as Playwright folds a failed call's (`compressCallLog`).
 */

/** How long a call runs before the elements its locator matches are read, and how often they are read again. */
const TARGET_EVERY_MS = 1000;
/** The most lines of a call's log kept, folded before they are sent: a minute of an action's retries. */
const KEPT_LINES = 1000;
/** The longest line of a call's log kept, once what may be a secret in it is hidden. */
const MAX_LINE = 600;
/** The longest title kept, once the text it types is hidden. */
const MAX_TITLE = 500;
/** The most calls the instrumentation is heard running at once; past it, the ones heard first are forgotten. */
const MAX_HEARD = 200;

/** One update of Playwright's call stream, as Playwright 1.64 writes it. */
interface CallUpdate {
  id?: unknown;
  title?: unknown;
  location?: { file?: unknown; line?: unknown } | null;
  newLogEntries?: unknown;
  actionPoint?: { x?: unknown; y?: unknown } | null;
  status?: unknown;
  error?: unknown;
}

type CallListener = (calls: CallUpdate[]) => void;

/** The part of a context's debugger the call stream needs. */
interface CallStream {
  _enable(): Promise<void>;
  on(event: 'apicallsupdated', listener: CallListener): unknown;
  off(event: 'apicallsupdated', listener: CallListener): unknown;
}

/** A context's call stream; null on a Playwright without one. */
function callStreamOf(context: BrowserContext): CallStream | null {
  const dbg = (context as unknown as { debugger?: Partial<CallStream> }).debugger;
  return typeof dbg?._enable === 'function' && typeof dbg.on === 'function' && typeof dbg.off === 'function'
    ? (dbg as CallStream)
    : null;
}

/** A call of the worker's Playwright as its instrumentation heard it begin. */
interface HeardCall {
  /** The call's zone, on which the runner writes the id the call stream names it by (`callId`). */
  zone: { callId?: unknown };
  selector: string | null;
  began: number;
}

/** The calls of the worker's Playwright running now, by their zone. */
const heard = new Map<object, HeardCall>();
/** The Playwright instances whose calls are heard: one listener each. */
const tracked = new WeakSet<object>();

/**
 * Hear each call of the worker's Playwright as it begins (when, and a locator call's selector), and forget it as it
 * ends. The instrumentation never hears an internal call, so none of Piwi's own.
 */
export function trackCalls(playwright: unknown): void {
  const instrumentation = (playwright as { _instrumentation?: { addListener?: (listener: object) => void } } | null)
    ?._instrumentation;
  if (!playwright || tracked.has(playwright as object) || typeof instrumentation?.addListener !== 'function') return;
  tracked.add(playwright as object);
  instrumentation.addListener({
    onApiCallBegin: (zone: object, channel?: { method?: unknown; params?: { selector?: unknown } }) => {
      if (channel?.method === '__waitInfo__') return;
      const selector = channel?.params?.selector;
      heard.set(zone, {
        zone,
        selector: typeof selector === 'string' && selector ? selector : null,
        began: Date.now(),
      });
      if (heard.size > MAX_HEARD) heard.delete(heard.keys().next().value!);
    },
    onApiCallEnd: (zone: object) => {
      heard.delete(zone);
    },
  });
}

/** The call heard under the id the call stream names it by. */
function heardAs(id: string): HeardCall | null {
  for (const call of heard.values()) if (call.zone.callId === id) return call;
  return null;
}

/** A call's file relative to the working directory, with forward slashes; null for one outside it or in a package. */
function userFile(file: unknown): string | null {
  if (typeof file !== 'string' || !file || /[\\/]node_modules[\\/]/.test(file)) return null;
  const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null;
}

/** A call of a context as its call stream told it so far. */
interface Call {
  id: string;
  title: string;
  file: string | null;
  line: number | null;
  status: LiveCallLog['status'];
  lines: string[];
  point: { x: number; y: number } | null;
  error: string | null;
  began: number;
  ended: number | null;
  /** The order the stream told it in, among its context's calls. */
  order: number;
  selector: string | null;
  /** Its locator names a field that holds a secret: the values its assertion quotes are hidden. */
  secretField: boolean;
}

/** A context's calls, followed from the first view of one of its pages until the context goes. */
interface ContextCalls {
  calls: Map<string, Call>;
  told: number;
  /** Each view that follows them, told of each change. */
  views: Set<() => void>;
}

const followed = new WeakMap<BrowserContext, Promise<ContextCalls | null>>();

/** Take one update of the call stream into its call. */
function take(state: ContextCalls, update: CallUpdate): void {
  if (typeof update?.id !== 'string' || typeof update.title !== 'string') return;
  const status = update.status === 'running' ? 'running' : update.status === 'error' ? 'failed' : 'passed';
  let call = state.calls.get(update.id);
  if (!call) {
    const heardOne = heardAs(update.id);
    call = {
      id: update.id,
      title: hideSecretsInText(hideTypedText(update.title)).slice(0, MAX_TITLE),
      file: userFile(update.location?.file),
      line: typeof update.location?.line === 'number' ? update.location.line : null,
      status,
      lines: [],
      point: null,
      error: null,
      began: heardOne?.began ?? Date.now(),
      ended: null,
      order: ++state.told,
      selector: heardOne?.selector ?? null,
      secretField: heardOne?.selector ? isSecretLocator(heardOne.selector) : false,
    };
    state.calls.set(update.id, call);
  }
  if (Array.isArray(update.newLogEntries)) {
    for (const entry of update.newLogEntries) {
      if (typeof entry !== 'string') continue;
      call.secretField ||= namesSecretField(entry);
      call.lines.push(hideSecretsInText(hideSecretsInLog(entry, call.secretField)).slice(0, MAX_LINE));
    }
    if (call.lines.length > KEPT_LINES) call.lines.splice(0, call.lines.length - KEPT_LINES);
  }
  const point = update.actionPoint;
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    call.point = { x: point.x as number, y: point.y as number };
  }
  if (typeof update.error === 'string' && update.error) {
    const first = update.error.split('\n')[0]!;
    call.error = hideSecretsInText(hideSecretsInLog(first, call.secretField)).slice(0, MAX_LINE);
  }
  call.status = status;
  if (status !== 'running' && call.ended === null) call.ended = Date.now();
}

/** The call a view shows: the running call told last, else the call told last, ended. */
function shownCall(state: ContextCalls): Call | null {
  let shown: Call | null = null;
  for (const call of state.calls.values()) {
    if (!shown) {
      shown = call;
      continue;
    }
    const running = call.status === 'running';
    if (running !== (shown.status === 'running') ? running : call.order > shown.order) shown = call;
  }
  return shown;
}

/** Forget the calls that ended, but the one told last. */
function prune(state: ContextCalls): void {
  let last: Call | null = null;
  for (const call of state.calls.values()) if (!last || call.order > last.order) last = call;
  for (const [id, call] of state.calls) if (call.status !== 'running' && call !== last) state.calls.delete(id);
}

/**
 * Follow a context's calls from now until it goes: the call stream's listener first, since turning the stream on tells
 * the calls running then. Resolves null on a Playwright without the stream, or one that refuses to turn it on.
 */
async function followContext(context: BrowserContext): Promise<ContextCalls | null> {
  const stream = callStreamOf(context);
  if (!stream) return null;
  const state: ContextCalls = { calls: new Map(), told: 0, views: new Set() };
  const listener: CallListener = (updates) => {
    if (!Array.isArray(updates)) return;
    for (const update of updates) take(state, update);
    prune(state);
    for (const view of state.views) view();
  };
  stream.on('apicallsupdated', listener);
  try {
    await internalCall(context, () => stream._enable());
  } catch {
    stream.off('apicallsupdated', listener);
    return null;
  }
  return state;
}

/** The part of an element of the page the read below uses, as the page sees it. */
interface PageElement {
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  getAttribute(name: string): string | null;
  disabled?: unknown;
}

/** What the elements a selector matches read as: how many, the first one's box, and whether it is enabled. */
interface Matches {
  count: number;
  box: LiveBox | null;
  enabled: boolean | null;
}

/**
 * Follow the calls of `page`'s context as Playwright logs them, telling `onLog` the call shown (`shownCall`) at once
 * and at each change. Resolves with what stops following, or null on a Playwright without the call stream.
 */
export async function followCallLog(page: Page, onLog: (log: LiveCallLog) => void): Promise<(() => void) | null> {
  const context = page.context();
  let state = followed.get(context);
  if (!state) {
    state = followContext(context);
    followed.set(context, state);
  }
  const calls = await state;
  if (!calls) return null;
  let stopped = false;
  let reading = false;
  /** The elements the shown call's selector matched, and the call they were read for. */
  let target: { id: string; matches: Matches } | null = null;

  /** Whether the call's element and its point are on the watched page: it is its context's one page. */
  const onThisPage = (): boolean => !page.isClosed() && context.pages().length === 1;

  const tell = (): void => {
    const shown = shownCall(calls);
    if (stopped || !shown) return;
    const here = onThisPage();
    onLog({
      id: shown.id,
      call: { title: shown.title, file: shown.file, line: shown.line },
      status: shown.status,
      lines: compressCallLog(shown.lines).slice(-MAX_LIVE_CALL_LOG_LINES),
      point: here ? shown.point : null,
      target: here && shown.status === 'running' && target?.id === shown.id ? target.matches : null,
      viewport: page.viewportSize(),
      ms: (shown.ended ?? Date.now()) - shown.began,
      error: shown.error,
    });
  };
  calls.views.add(tell);
  tell();

  // While the call shown has waited a second, the elements its locator matches.
  const timer = setInterval(() => {
    const shown = shownCall(calls);
    const selector = shown?.selector;
    if (stopped || reading || !shown || shown.status !== 'running' || !selector || !onThisPage()) return;
    if (Date.now() - shown.began < TARGET_EVERY_MS) return;
    reading = true;
    // A selector into a frame matches in that frame: its box is the frame's, not the page's.
    const framed = selector.includes('internal:control=enter-frame');
    void internalCall(page, () =>
      page.locator(selector).evaluateAll((elements): Matches => {
        const first = elements[0] as unknown as PageElement | undefined;
        if (!first) return { count: 0, box: null, enabled: null };
        const rect = first.getBoundingClientRect();
        const disabled = first.disabled === true || first.getAttribute('aria-disabled') === 'true';
        return {
          count: elements.length,
          box: rect.width || rect.height ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          enabled: !disabled,
        };
      }),
    )
      .then((matches) => {
        if (stopped || shownCall(calls) !== shown || shown.status !== 'running') return;
        // The call found its element where this read found none: it runs in a frame of the page of its own.
        if (!matches.count && shown.lines.some((line) => line.includes('locator resolved to'))) return;
        target = { id: shown.id, matches: framed ? { ...matches, box: null } : matches };
        tell();
      })
      .catch(() => undefined)
      .finally(() => {
        reading = false;
      });
  }, TARGET_EVERY_MS);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
    calls.views.delete(tell);
  };
}
