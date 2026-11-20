import {
  BUG_EVIDENCE_LIMITS,
  reportedRequestUrl,
  type BugConsoleEntry,
  type BugFailedRequest,
} from '@piwitests/core/bug-report';
import { CDP_EVIDENCE_KEY, emptyCdpEvidence, type CdpEvidence, type DebuggingState } from '../shared/bug-storage.js';
import { sessionArea } from '../shared/session-area.js';
import type { FallbackReason } from '../shared/cdp-input.js';
import {
  acquireDebugger,
  holdsDebugger,
  onDebuggerEvent,
  onDebuggerLost,
  releaseDebugger,
  sendCommand,
  tabsHolding,
} from './debugger.js';

/**
 * A recording's evidence through the debugging protocol, in the tab the
 * report started in: the console and uncaught errors from the page's first
 * script (`Runtime`, `Log`), every request that failed or answered 400 or more,
 * documents, scripts and images included (`Network`), and screenshots at any
 * moment, across navigations (`Page.captureScreenshot`).
 *
 * Only this worker writes it, under its own key (`CDP_EVIDENCE_KEY`), which
 * `getBugEvidence` merges with what the page relays. A request keeps its
 * method, its URL without query values and its status: never a header or a
 * body. Only the recorded origin is reported, as the page's script reports
 * it: the console of the page's own scripts (the default execution contexts,
 * never an extension's isolated world) while the tab shows that origin, and
 * the requests of its documents, their URLs written against it. The session is
 * held while the recording runs, and let go when it stops; in Firefox, or when
 * attaching fails or is cancelled, the main-world script
 * (`bug-evidence-main.ts`) does the work.
 */

interface Collector {
  stop: () => void;
  /** The origin the recording was granted. */
  origin: string;
  /** The origin the tab's main frame shows: follows the tab's navigations. */
  frameOrigin: string;
  /** The page's path, for each entry: follows the tab's navigations. */
  page: string;
  /** The page's own execution contexts, where its scripts run, by id. */
  contexts: Set<number>;
  requests: Map<string, { method: string; url: string }>;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Whether the tab shows the recorded origin, whose console the report keeps. */
const onRecordedOrigin = (collector: Collector) => collector.frameOrigin === collector.origin;

const collectors = new Map<number, Collector>();

let writeQueue: Promise<unknown> = Promise.resolve();

function update(change: (current: CdpEvidence) => CdpEvidence): Promise<void> {
  const run = writeQueue.then(async () => {
    const stored = (await sessionArea().get(CDP_EVIDENCE_KEY))[CDP_EVIDENCE_KEY] as CdpEvidence | undefined;
    await sessionArea().set({ [CDP_EVIDENCE_KEY]: change(stored ?? emptyCdpEvidence()) });
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

let pending: { console: BugConsoleEntry[]; requests: BugFailedRequest[] } = { console: [], requests: [] };
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Takes what is pending, and cancels the write it was waiting for. */
function takePending(): { console: BugConsoleEntry[]; requests: BugFailedRequest[] } {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const batch = pending;
  pending = { console: [], requests: [] };
  return batch;
}

/** Stores what is pending now, within the limits. */
function flush(): Promise<void> {
  const batch = takePending();
  if (batch.console.length === 0 && batch.requests.length === 0) return writeQueue.then(() => undefined);
  return update((current) => {
    const console = [...current.console];
    const requests = [...current.requests];
    let { consoleDropped, requestsDropped } = current;
    for (const e of batch.console) {
      if (console.length < BUG_EVIDENCE_LIMITS.console) console.push(e);
      else consoleDropped++;
    }
    for (const r of batch.requests) {
      if (requests.length < BUG_EVIDENCE_LIMITS.requests) requests.push(r);
      else requestsDropped++;
    }
    return { ...current, console, consoleDropped, requests, requestsDropped };
  });
}

function flushSoon(): void {
  flushTimer ??= setTimeout(() => void flush().catch(() => undefined), 250);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** A console argument as the page's console shows it, short. */
function remoteText(arg: Record<string, unknown>): string {
  if (arg.type === 'string') return String(arg.value);
  if ('value' in arg) {
    try {
      return JSON.stringify(arg.value) ?? String(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  if (typeof arg.description === 'string') return arg.description;
  if (typeof arg.unserializableValue === 'string') return arg.unserializableValue;
  return String(arg.type ?? '');
}

const clip = (text: string) => text.slice(0, BUG_EVIDENCE_LIMITS.messageLength);

function onEvent(collector: Collector, method: string, params: Record<string, unknown>): void {
  const now = Date.now();
  switch (method) {
    case 'Page.frameNavigated': {
      const frame = params.frame as { parentId?: string; url?: string } | undefined;
      if (frame && !frame.parentId && frame.url) {
        collector.frameOrigin = originOf(frame.url);
        collector.page = pathOf(frame.url);
      }
      return;
    }
    case 'Runtime.executionContextCreated': {
      const context = params.context as { id?: number; auxData?: { isDefault?: boolean } } | undefined;
      if (typeof context?.id === 'number' && context.auxData?.isDefault === true) collector.contexts.add(context.id);
      return;
    }
    case 'Runtime.executionContextDestroyed':
      collector.contexts.delete(Number(params.executionContextId));
      return;
    case 'Runtime.executionContextsCleared':
      collector.contexts.clear();
      return;
    case 'Runtime.consoleAPICalled': {
      const type = params.type;
      if (type !== 'error' && type !== 'warning' && type !== 'assert') return;
      if (!onRecordedOrigin(collector) || !collector.contexts.has(Number(params.executionContextId))) return;
      const args = (params.args as Array<Record<string, unknown>> | undefined) ?? [];
      pending.console.push({
        level: type === 'warning' ? 'warn' : 'error',
        source: 'console',
        message: clip(args.map(remoteText).join(' ')),
        page: collector.page,
        time: now,
      });
      return flushSoon();
    }
    case 'Runtime.exceptionThrown': {
      const details = (params.exceptionDetails ?? {}) as {
        text?: string;
        executionContextId?: number;
        exception?: { description?: string; value?: unknown };
      };
      if (!onRecordedOrigin(collector) || !collector.contexts.has(Number(details.executionContextId))) return;
      const rejection = /\(in promise\)/.test(details.text ?? '');
      const text = details.exception?.description ?? String(details.exception?.value ?? details.text ?? '');
      pending.console.push({
        level: 'error',
        source: rejection ? 'rejection' : 'error',
        message: clip(text),
        page: collector.page,
        time: now,
      });
      return flushSoon();
    }
    case 'Log.entryAdded': {
      const entry = (params.entry ?? {}) as { level?: string; source?: string; text?: string };
      // Network failures come from `Network`, and console calls from `Runtime`.
      if (entry.level !== 'error' || entry.source === 'network' || entry.source === 'console-api') return;
      if (!onRecordedOrigin(collector)) return;
      pending.console.push({
        level: 'error',
        source: 'console',
        message: clip(entry.text ?? ''),
        page: collector.page,
        time: now,
      });
      return flushSoon();
    }
    case 'Network.requestWillBeSent': {
      const request = params.request as { method?: string; url?: string } | undefined;
      // A request belongs to the document it loads for (a navigation's, the new one): one of another origin is not reported.
      const document = typeof params.documentURL === 'string' ? params.documentURL : '';
      if (originOf(document) !== collector.origin) return;
      if (typeof params.requestId === 'string' && request?.url && /^https?:/.test(request.url)) {
        collector.requests.set(params.requestId, { method: request.method ?? 'GET', url: request.url });
      }
      return;
    }
    case 'Network.responseReceived': {
      const request = collector.requests.get(String(params.requestId));
      const status = (params.response as { status?: number } | undefined)?.status ?? 0;
      if (request && status >= 400) {
        pending.requests.push({
          method: request.method.toUpperCase(),
          url: reportedRequestUrl(request.url, `${collector.origin}/`),
          status,
          page: collector.page,
          time: now,
        });
        flushSoon();
      }
      return;
    }
    case 'Network.loadingFailed': {
      const request = collector.requests.get(String(params.requestId));
      collector.requests.delete(String(params.requestId));
      // A cancelled request is the page's own decision, not a failure.
      if (!request || params.canceled === true) return;
      pending.requests.push({
        method: request.method.toUpperCase(),
        url: reportedRequestUrl(request.url, `${collector.origin}/`),
        status: 0,
        page: collector.page,
        time: now,
      });
      return flushSoon();
    }
    case 'Network.loadingFinished':
      collector.requests.delete(String(params.requestId));
      return;
  }
}

async function setDebugging(debugging: DebuggingState): Promise<void> {
  await update((current) => ({ ...current, debugging }));
}

/**
 * Starts collecting in the tab a recording started in, for the origin
 * `originPattern` grants (`https://app.example.com/*`). Answers whether the
 * session attached: when it did not, the page's own script collects instead.
 */
export async function startBugDebugger(tabId: number, originPattern: string): Promise<boolean> {
  // Nothing of an earlier recording carries over, even a write still queued.
  takePending();
  await update(() => emptyCdpEvidence());
  const attached = await acquireDebugger(tabId, 'bug');
  if (!attached.ok) {
    await setDebugging({ state: 'off', reason: attached.reason });
    return false;
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const frameOrigin = originOf(tab?.url ?? '');
  const collector: Collector = {
    stop: () => undefined,
    origin: originOf(originPattern.replace(/\*$/, '')) || frameOrigin,
    frameOrigin,
    page: pathOf(tab?.url ?? ''),
    contexts: new Set(),
    requests: new Map(),
  };
  collector.stop = onDebuggerEvent(tabId, (method, params) => onEvent(collector, method, params));
  collectors.set(tabId, collector);
  try {
    // The page's first script runs after these, on every navigation of the tab, for as long as the session holds.
    for (const domain of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) {
      await sendCommand(tabId, domain);
    }
  } catch {
    await stopBugDebugger();
    await setDebugging({ state: 'off', reason: 'refused' });
    return false;
  }
  await setDebugging({ state: 'on', reason: null });
  return true;
}

/** The recording stopped: collection ends, what is pending is stored, and the session is let go. */
export async function stopBugDebugger(): Promise<void> {
  for (const [tabId, collector] of collectors) {
    collector.stop();
    collectors.delete(tabId);
  }
  await flush().catch(() => undefined);
  await Promise.all(tabsHolding('bug').map((tabId) => releaseDebugger(tabId, 'bug')));
}

/** Whether the tab's evidence comes through the debugging protocol, so its page relay stays quiet. */
export function collectsThroughDebugger(tabId: number | undefined): boolean {
  return tabId != null && holdsDebugger(tabId, 'bug');
}

/**
 * A screenshot of the tab through the protocol, whatever page it shows now and
 * whether or not the popup was opened on it. Null when the tab has no session,
 * or the capture fails (a hidden tab may never paint).
 */
export async function captureThroughDebugger(tabId: number, format: 'png' | 'jpeg' = 'png'): Promise<string | null> {
  if (!holdsDebugger(tabId, 'bug')) return null;
  const capture = sendCommand<{ data?: string }>(tabId, 'Page.captureScreenshot', {
    format,
    ...(format === 'jpeg' ? { quality: 85 } : {}),
  });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000));
  try {
    const result = await Promise.race([capture, timeout]);
    return result?.data ? `data:image/${format};base64,${result.data}` : null;
  } catch {
    return null;
  }
}

/**
 * Called when a recording's session ends without being released (the
 * person cancelled the bar): the page's own script takes over from the time
 * kept as `endedAt`, and the HUD says so.
 */
export function onBugDebuggerLost(fallback: (reason: FallbackReason) => Promise<void>): void {
  onDebuggerLost((tabId, purposes, reason) => {
    if (!purposes.includes('bug')) return;
    const endedAt = Date.now();
    collectors.get(tabId)?.stop();
    collectors.delete(tabId);
    void setDebugging({ state: 'off', reason, endedAt }).then(() => fallback(reason));
  });
}
