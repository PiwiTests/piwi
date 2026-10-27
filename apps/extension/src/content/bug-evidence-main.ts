import { BUG_EVIDENCE_LIMITS, reportedRequestUrl } from '@piwitests/core/bug-report';
import { BUG_RELAY, ownOrigin, type BugRelayEntry } from '../shared/bug-relay.js';

/**
 * Runs in the page's main world while a bug recording or a replay is on,
 * registered by the background worker for its origin at `document_start`. Notes
 * console errors and warnings, uncaught errors, unhandled rejections, and
 * requests that failed or answered 400 or more (method, URL without query
 * values, status: never a header or a body), and hands them to the recorder
 * in the isolated world with the recording's token (see `shared/bug-relay.ts`).
 *
 * It only wraps and listens: every wrapped function calls the original with the
 * same arguments and returns what it returns, except `fetch`, which returns a
 * promise derived from the original's that settles the same way, so a failure
 * the page leaves unhandled is still reported unhandled. Nothing here uses
 * `chrome.*`, which the main world does not have.
 */

interface EvidenceGlobals {
  __piwiBugEvidenceInstalled?: boolean;
}

/** Entries kept per document before the recorder has sent the token. */
const BUFFER_LIMIT = 200;

function install(): void {
  const g = globalThis as EvidenceGlobals;
  if (g.__piwiBugEvidenceInstalled) return;
  g.__piwiBugEvidenceInstalled = true;

  let token: string | null = null;
  const pending: BugRelayEntry[] = [];
  const sent = { console: 0, request: 0 };

  const post = (item: BugRelayEntry, to: string): void => {
    const limit = item.kind === 'console' ? BUG_EVIDENCE_LIMITS.console : BUG_EVIDENCE_LIMITS.requests;
    if (sent[item.kind] >= limit) return;
    sent[item.kind]++;
    window.postMessage({ source: BUG_RELAY.ENTRY, token: to, item }, ownOrigin());
  };

  const send = (item: BugRelayEntry): void => {
    if (token) post(item, token);
    else if (pending.length < BUFFER_LIMIT) pending.push(item);
  };

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;
    const data = e.data as { source?: unknown; token?: unknown; since?: unknown } | null;
    if (data?.source !== BUG_RELAY.HELLO || typeof data.token !== 'string' || !data.token) return;
    token = data.token;
    // What was noted before `since` reached the report another way: the debugging session collected it.
    const since = typeof data.since === 'number' && Number.isFinite(data.since) ? data.since : -Infinity;
    for (const item of pending.splice(0)) if (item.entry.time >= since) post(item, token);
  });

  const stringify = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value === undefined) return 'undefined';
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };
  const message = (args: unknown[]): string =>
    args.map(stringify).join(' ').slice(0, BUG_EVIDENCE_LIMITS.messageLength);
  const page = (): string => location.pathname;

  const noteConsole = (level: 'error' | 'warn', source: 'console' | 'error' | 'rejection', text: string): void => {
    send({ kind: 'console', entry: { level, source, message: text, page: page(), time: Date.now() } });
  };

  for (const level of ['error', 'warn'] as const) {
    const original = console[level];
    console[level] = function (this: Console, ...args: unknown[]) {
      try {
        noteConsole(level, 'console', message(args));
      } catch {
        // Evidence is best-effort; the page's own call must go through regardless.
      }
      return original.apply(this, args);
    };
  }

  window.addEventListener('error', (e) => {
    // A resource that failed to load fires a plain `Event` here, with no message.
    if (!(e instanceof ErrorEvent)) return;
    noteConsole('error', 'error', message([e.error ?? e.message]));
  });
  window.addEventListener('unhandledrejection', (e) => {
    noteConsole('error', 'rejection', message([e.reason]));
  });

  const noteRequest = (method: string, url: string, status: number): void => {
    send({
      kind: 'request',
      entry: {
        method: method.toUpperCase(),
        url: reportedRequestUrl(url, location.href),
        status,
        page: page(),
        time: Date.now(),
      },
    });
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const result = originalFetch.apply(this, args);
      let request: { method: string; url: string };
      try {
        const [input, init] = args;
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        request = { method: init?.method ?? (input instanceof Request ? input.method : 'GET'), url };
      } catch {
        // Unreadable arguments: the request still goes out, unrecorded.
        return result;
      }
      // The page gets a promise that settles as the original does: a rejection it leaves unhandled stays unhandled.
      return result.then(
        (response) => {
          if (response.status >= 400) noteRequest(request.method, request.url, response.status);
          return response;
        },
        (error: unknown) => {
          // An abort is the page's own decision, not a failure.
          if (!(error instanceof DOMException && error.name === 'AbortError'))
            noteRequest(request.method, request.url, 0);
          throw error;
        },
      );
    } as typeof fetch;
  }

  // The request each XHR opened last: one used again reports each of its requests once, as itself.
  const requests = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  const listening = new WeakSet<XMLHttpRequest>();
  const proto = XMLHttpRequest.prototype;
  const originalOpen = proto.open;
  const originalSend = proto.send;
  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    requests.set(this, { method: String(method), url: String(url) });
    return (originalOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;
  proto.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
    if (requests.has(this) && !listening.has(this)) {
      listening.add(this);
      const note = (status: number) => {
        const request = requests.get(this);
        if (request) noteRequest(request.method, request.url, status);
      };
      this.addEventListener('load', () => {
        if (this.status >= 400) note(this.status);
      });
      this.addEventListener('error', () => note(0));
      this.addEventListener('timeout', () => note(0));
    }
    return originalSend.apply(this, args);
  };

  window.postMessage({ source: BUG_RELAY.READY }, ownOrigin());
}

install();
