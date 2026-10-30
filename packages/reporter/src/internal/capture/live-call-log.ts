import * as path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { compressCallLog, MAX_LIVE_CALL_LOG_LINES, type LiveBox, type LiveCallLog } from '@piwitests/core/live-view';
import { hideSecretsInText, hideTypedText, hideTypedTextInLog } from '@piwitests/core/mask';
import { internalCall } from './quiet-capture.js';

/**
 * The call a test is in, as Playwright logs it while it runs, for the run page's live view of a CI run
 * (`@piwitests/core/live-view`'s `call-log`). Three sources, each checked before use:
 *
 * - Playwright's call stream (`context.debugger`'s internal `_enable` and its `apicallsupdated` event): each running
 *   call's title, place, status, call log lines, the point an input action acts on, and its error, every half second.
 *   Once on, it stays on in its context and moves where the debugger stops an action (before its input rather than
 *   before its wait), so `live-view.ts` turns it on only in a CI run, where nothing pauses.
 * - The worker's Playwright instrumentation (`trackLocatorCalls`): the selector of the locator call running, which the
 *   call stream does not give.
 * - While a call has waited a second, the elements its selector matches, read once a second through `internalCall`:
 *   how many, the first one's box and whether it is enabled. A read that fails leaves the last one.
 *
 * The log's lines go folded as Playwright folds a failed call's (`compressCallLog`). Every text goes through
 * `hideTypedText` or `hideTypedTextInLog`, then `hideSecretsInText`.
 */

/** How long a call runs before the elements its locator matches are read, and how often they are read again. */
const TARGET_EVERY_MS = 1000;
/** The most lines of a call's log kept, folded before they are sent: a minute of an action's retries. */
const KEPT_LINES = 1000;
/** The longest line of a call's log kept; the instance cuts it shorter still. */
const MAX_LINE = 600;
/** The longest title kept. */
const MAX_TITLE = 500;

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

/** The locator call running in the worker: the zone Playwright's instrumentation names it by, and its selector. */
let locatorCall: { zone: object; selector: string } | null = null;
/** The Playwright instances whose calls are heard: one listener each. */
const tracked = new WeakSet<object>();

/**
 * Hear the selector of each locator call of the worker's Playwright as it begins, and forget it as it ends. The
 * instrumentation never hears an internal call, so none of Piwi's own.
 */
export function trackLocatorCalls(playwright: unknown): void {
  const instrumentation = (playwright as { _instrumentation?: { addListener?: (listener: object) => void } } | null)
    ?._instrumentation;
  if (!playwright || tracked.has(playwright as object) || typeof instrumentation?.addListener !== 'function') return;
  tracked.add(playwright as object);
  instrumentation.addListener({
    onApiCallBegin: (zone: object, channel?: { params?: { selector?: unknown } }) => {
      const selector = channel?.params?.selector;
      if (typeof selector === 'string' && selector) locatorCall = { zone, selector };
    },
    onApiCallEnd: (zone: object) => {
      if (locatorCall?.zone === zone) locatorCall = null;
    },
  });
}

/** A call's file relative to the working directory, with forward slashes; null for one outside it or in a package. */
function userFile(file: unknown): string | null {
  if (typeof file !== 'string' || !file || /[\\/]node_modules[\\/]/.test(file)) return null;
  const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null;
}

interface Following {
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
  target: LiveCallLog['target'];
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
 * Follow the calls of `page`'s context as Playwright logs them, telling `onLog` each change of the call shown: the
 * call that began last, until the next one begins. Resolves with what stops following, or null on a Playwright without
 * the call stream.
 */
export async function followCallLog(page: Page, onLog: (log: LiveCallLog) => void): Promise<(() => void) | null> {
  const context = page.context();
  const stream = callStreamOf(context);
  if (!stream) return null;
  try {
    await internalCall(context, () => stream._enable());
  } catch {
    return null;
  }
  let current: Following | null = null;
  let stopped = false;
  let reading = false;

  const tell = (): void => {
    if (stopped || !current) return;
    const now = Date.now();
    onLog({
      id: current.id,
      call: { title: hideSecretsInText(hideTypedText(current.title)), file: current.file, line: current.line },
      status: current.status,
      lines: compressCallLog(current.lines)
        .slice(-MAX_LIVE_CALL_LOG_LINES)
        .map((line) => hideSecretsInText(hideTypedTextInLog(line))),
      point: current.point,
      target: current.target,
      viewport: page.viewportSize(),
      ms: (current.ended ?? now) - current.began,
      error: current.error && hideSecretsInText(hideTypedTextInLog(current.error)),
    });
  };

  const listener: CallListener = (calls) => {
    if (stopped || !Array.isArray(calls)) return;
    for (const update of calls) {
      if (typeof update?.id !== 'string' || typeof update.title !== 'string') continue;
      const status = update.status === 'running' ? 'running' : update.status === 'error' ? 'failed' : 'passed';
      if (!current || current.id !== update.id) {
        // A call that began shows from now on; the end of one shown before it, or of a call never shown, does not.
        if (current && status !== 'running') continue;
        current = {
          id: update.id,
          title: update.title.slice(0, MAX_TITLE),
          file: userFile(update.location?.file),
          line: typeof update.location?.line === 'number' ? update.location.line : null,
          status,
          lines: [],
          point: null,
          error: null,
          began: Date.now(),
          ended: null,
          target: null,
        };
      }
      if (Array.isArray(update.newLogEntries)) {
        for (const line of update.newLogEntries)
          if (typeof line === 'string') current.lines.push(line.slice(0, MAX_LINE));
        if (current.lines.length > KEPT_LINES) current.lines.splice(0, current.lines.length - KEPT_LINES);
      }
      const point = update.actionPoint;
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        current.point = { x: point.x as number, y: point.y as number };
      }
      if (typeof update.error === 'string' && update.error) current.error = update.error.split('\n')[0]!.slice(0, 1000);
      current.status = status;
      if (status !== 'running' && current.ended === null) {
        current.ended = Date.now();
        current.target = null;
      }
    }
    tell();
  };
  stream.on('apicallsupdated', listener);

  // While the call shown has waited a second, the elements its locator matches.
  const timer = setInterval(() => {
    const shown = current;
    const selector = locatorCall?.selector;
    if (stopped || reading || !shown || shown.status !== 'running' || !selector) return;
    if (Date.now() - shown.began < TARGET_EVERY_MS) return;
    reading = true;
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
        if (current !== shown || shown.status !== 'running') return;
        shown.target = matches;
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
    stream.off('apicallsupdated', listener);
  };
}
