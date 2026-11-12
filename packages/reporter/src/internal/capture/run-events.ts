import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';
import {
  MAX_FOLLOWED_REQUESTS,
  MAX_PAGE_EVENT_TEXT,
  MAX_PAGE_EVENT_URL,
  PENDING_REQUEST_MS,
  type PageEvent,
} from '@piwitests/core/live-layers';
import { hideSecretsInText, hideSecretsInUrl, hideTypedText } from '@piwitests/core/mask';
import { MAX_RUN_EVENT_TEXT, type Place } from '@piwitests/core/run-channel';
import type { ApiCall } from './api-requests.js';
import { pageEventsWanted, tellPageEvent } from './lane-layers.js';
import { callSitePath } from './locator-healing.js';
import { runEventsWanted, tellEvent } from './run-channel.js';

/**
 * What the running test does, told to whoever follows it: to the editor while an agent follows the run (the run
 * channel's `events`, which the editor asks for), each call of the test as it ends, through Playwright's
 * instrumentation (`_instrumentation`, feature-checked, which never hears an internal call, so none of Piwi's own), with
 * the place in the user's code that made it; and each page's navigations, its console errors and warnings, the errors
 * it threw that nothing caught, and its requests that failed or were answered with an error status. To a lane view that
 * asks for the `events` layer (`lane-layers.ts`, on either wire), the same listeners tell a page's console errors, the
 * errors it threw, its failed requests, each request that waits `PENDING_REQUEST_MS` and more for its answer (told again
 * as long again passes, then once as it ends), the errors and warnings a backend logged on a response
 * (`X-Piwi-Logs`, read as the capture fixtures read it, `readServerLogs`), and each call the test makes through an API
 * request context (`tellApiCall`). Every text has its credentials hidden (`@piwitests/core/mask`). Nothing is sent, nor
 * a request followed, while nobody follows the run, nor between tests.
 */

/** The parts of Playwright's API-call zone read here (internal). */
interface ApiZone {
  apiName?: string;
  title?: string;
  frames?: Array<{ file?: string; line?: number; column?: number }>;
  error?: unknown;
}

interface ApiChannel {
  params?: { selector?: unknown };
}

interface Instrumentation {
  addListener?: (listener: object) => void;
}

/** When each call heard began, until it ends. */
const begun = new WeakMap<object, number>();
/** The Playwright instances whose calls are heard: one listener each. */
const heard = new WeakSet<object>();
/** The pages whose events are heard: one set of listeners each. */
const watched = new WeakSet<Page>();

/** A frame's file under `cwd`, with forward slashes; null for one outside it or in a package. */
function userFile(file: string | undefined, cwd: string, windows: boolean): string | null {
  if (!file || /[\\/]node_modules[\\/]/.test(file)) return null;
  const relative = callSitePath(file, cwd, windows);
  if (!relative || (windows ? path.win32 : path.posix).isAbsolute(relative) || relative.startsWith('..')) return null;
  return relative;
}

/**
 * The place in the user's code that made a call: its first frame under `cwd`. `windows` reads the frames as Windows
 * writes them.
 */
export function callPlace(
  frames: ApiZone['frames'],
  cwd: string = process.cwd(),
  windows: boolean = process.platform === 'win32',
): Place | null {
  for (const frame of frames ?? []) {
    const file = userFile(frame.file, cwd, windows);
    if (!file || !frame.line || frame.line < 1) continue;
    return { file, line: frame.line, ...(frame.column && frame.column > 0 ? { column: frame.column } : {}) };
  }
  return null;
}

/**
 * A call's title: Playwright's own, else its name and the selector it acts on, without the text a fill, a typing or an
 * insert types (`hideTypedText`) and its credentials hidden.
 */
export function callTitle(zone: ApiZone, channel: ApiChannel | undefined): string {
  const selector = typeof channel?.params?.selector === 'string' ? ` ${channel.params.selector}` : '';
  const title = zone.title || `${zone.apiName || 'call'}${selector}`;
  return hideSecretsInText(hideTypedText(title)).slice(0, 300);
}

/** The first lines of a call's error, its credentials hidden. */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return hideSecretsInText(message.split('\n').slice(0, 4).join('\n')).slice(0, MAX_RUN_EVENT_TEXT);
}

/**
 * Hear the calls of the worker's Playwright, each told as it ends while an agent follows the run. False when the
 * instrumentation is missing.
 */
export function watchCalls(playwright: unknown): boolean {
  const instrumentation = (playwright as { _instrumentation?: Instrumentation } | null)?._instrumentation;
  if (!playwright || heard.has(playwright as object)) return true;
  if (!instrumentation || typeof instrumentation.addListener !== 'function') return false;
  heard.add(playwright as object);
  const titles = new WeakMap<object, string>();
  instrumentation.addListener({
    onApiCallBegin: (zone: ApiZone, channel?: ApiChannel) => {
      if (!runEventsWanted()) return;
      begun.set(zone, Date.now());
      titles.set(zone, callTitle(zone, channel));
    },
    onApiCallEnd: (zone: ApiZone) => {
      const start = begun.get(zone);
      if (start === undefined) return;
      begun.delete(zone);
      if (!runEventsWanted()) return;
      tellEvent({
        kind: 'call',
        title: titles.get(zone) ?? callTitle(zone, undefined),
        place: callPlace(zone.frames),
        ok: zone.error === undefined,
        error: zone.error === undefined ? null : errorText(zone.error),
        ms: Date.now() - start,
      });
    },
  });
  return true;
}

/**
 * What a backend's instrumentation said about a request (`X-Piwi-Logs`: gzip, then base64, of a JSON list), as the
 * capture fixtures keep it with the request; undefined for no header, or one that does not read.
 */
export function readServerLogs(header: string | undefined): unknown {
  if (!header) return undefined;
  try {
    return JSON.parse(gunzipSync(Buffer.from(header, 'base64')).toString('utf-8'));
  } catch {
    return undefined;
  }
}

/** The most entries of one response's backend log told as page events. */
const MAX_BACKEND_ENTRIES = 5;

/** The errors and warnings of a backend's log, as page events of the request `method` `url` answered `status`. */
function backendEvents(logs: unknown, method: string, url: string, status: number | null): PageEvent[] {
  if (!Array.isArray(logs)) return [];
  const events: PageEvent[] = [];
  for (const entry of logs as Array<{ level?: unknown; message?: unknown }>) {
    if (events.length >= MAX_BACKEND_ENTRIES) break;
    const level = typeof entry?.level === 'string' ? entry.level.toLowerCase() : '';
    const said = /^(?:error|critical|fatal)$/.test(level) ? 'error' : /^warn(?:ing)?$/.test(level) ? 'warning' : null;
    if (!said || typeof entry.message !== 'string' || !entry.message.trim()) continue;
    events.push({
      kind: 'backend',
      method,
      url,
      status,
      level: said,
      text: hideSecretsInText(entry.message).slice(0, MAX_PAGE_EVENT_TEXT),
    });
  }
  return events;
}

/** A page event's address: its credentials hidden, then cut. */
function eventUrl(value: string): string {
  return hideSecretsInUrl(value.slice(0, 8192)).slice(0, MAX_PAGE_EVENT_URL);
}

/** Tell the lane views that ask for page events a call the test made through an API request context. */
export function tellApiCall(call: ApiCall, url: string): void {
  if (!pageEventsWanted()) return;
  try {
    const status = call.response ? call.response.status() : null;
    const method = /^[A-Za-z]{1,16}$/.test(call.method) ? call.method.toUpperCase() : 'GET';
    const shown = eventUrl(url);
    const failure =
      call.error === undefined ? null : hideSecretsInText(errorText(call.error).split('\n')[0]!).slice(0, 500);
    tellPageEvent({
      kind: 'api',
      method,
      url: shown,
      status: status !== null && status >= 100 && status <= 599 ? status : null,
      ms: Math.max(0, Math.round(call.endedAt - call.startedAt)),
      failure,
    });
    const logs = call.response ? readServerLogs(call.response.headers()['x-piwi-logs']) : undefined;
    for (const event of backendEvents(logs, method, shown, status)) tellPageEvent(event);
  } catch {
    /* a call's record never affects the test */
  }
}

/** A request of a page followed while it waits for its answer: the worker's number for it, and how often it was told. */
interface Waiting {
  id: number;
  method: string;
  url: string;
  began: number;
  told: number;
}

/** The requests of the test's pages that wait for their answer, while a lane view asks for page events. */
const waiting = new Map<Request, Waiting>();
let requestsFollowed = 0;
let waitTimer: ReturnType<typeof setInterval> | null = null;

/** Tell each request that waited `PENDING_REQUEST_MS` more since it was last told; stop once none waits. */
function tellWaiting(): void {
  if (!pageEventsWanted()) return forgetWaitingRequests();
  const now = Date.now();
  for (const request of waiting.values()) {
    const ms = now - request.began;
    if (ms < PENDING_REQUEST_MS * (request.told + 1)) continue;
    request.told = Math.floor(ms / PENDING_REQUEST_MS);
    tellPageEvent({
      kind: 'request-pending',
      id: request.id,
      method: request.method,
      url: request.url,
      ms,
      done: false,
    });
  }
}

/** Follow no request any more: the test ended, or nobody asks for page events. */
export function forgetWaitingRequests(): void {
  waiting.clear();
  if (waitTimer) clearInterval(waitTimer);
  waitTimer = null;
}

/** Hear a page's navigations, console errors and warnings, uncaught errors, requests and their answers. */
export function watchPageEvents(page: Page): void {
  if (watched.has(page) || typeof page.on !== 'function') return;
  watched.add(page);
  const text = (value: string) => hideSecretsInText(value).slice(0, MAX_RUN_EVENT_TEXT);
  const url = (value: string) => hideSecretsInUrl(value).slice(0, 8192);
  const guard = (tell: () => void) => {
    if (!runEventsWanted() && !pageEventsWanted()) return;
    try {
      tell();
    } catch {
      /* a page event handler must never throw */
    }
  };
  /** A request that waited and was told so is told once more as it ends. */
  const settle = (request: Request): void => {
    const followed = waiting.get(request);
    if (!followed) return;
    waiting.delete(request);
    if (!followed.told || !pageEventsWanted()) return;
    const { id, method, url: shown, began } = followed;
    tellPageEvent({ kind: 'request-pending', id, method, url: shown, ms: Date.now() - began, done: true });
  };
  page.on('framenavigated', (frame) =>
    guard(() => {
      if (frame === page.mainFrame() && runEventsWanted()) tellEvent({ kind: 'navigation', url: url(frame.url()) });
    }),
  );
  page.on('console', (message: ConsoleMessage) =>
    guard(() => {
      const type = message.type();
      if ((type === 'error' || type === 'warning') && runEventsWanted()) {
        tellEvent({ kind: 'console', level: type, text: text(message.text()) });
      }
      if (type === 'error' && pageEventsWanted()) tellPageEvent({ kind: 'console', text: text(message.text()) });
    }),
  );
  page.on('pageerror', (error: Error) =>
    guard(() => {
      if (runEventsWanted()) tellEvent({ kind: 'page-error', text: text(errorText(error)) });
      if (pageEventsWanted()) tellPageEvent({ kind: 'page-error', text: text(errorText(error)) });
    }),
  );
  page.on('request', (request: Request) => {
    if (!pageEventsWanted() || waiting.size >= MAX_FOLLOWED_REQUESTS) return;
    try {
      const method = request.method();
      waiting.set(request, {
        id: ++requestsFollowed,
        method,
        url: eventUrl(request.url()),
        began: Date.now(),
        told: 0,
      });
      if (!waitTimer) {
        waitTimer = setInterval(tellWaiting, 1000);
        waitTimer.unref?.();
      }
    } catch {
      /* a page event handler must never throw */
    }
  });
  page.on('requestfinished', settle);
  page.on('requestfailed', (request: Request) => {
    settle(request);
    guard(() => {
      const failure = request.failure()?.errorText ? text(request.failure()!.errorText).slice(0, 500) : null;
      const event = { kind: 'request-failed' as const, method: request.method(), status: null, failure };
      if (runEventsWanted()) tellEvent({ ...event, url: url(request.url()) });
      if (pageEventsWanted()) tellPageEvent({ ...event, url: eventUrl(request.url()) });
    });
  });
  page.on('response', (response: Response) =>
    guard(() => {
      const status = response.status();
      const request = response.request();
      if (status >= 400 && status <= 599) {
        if (runEventsWanted()) {
          tellEvent({
            kind: 'request-failed',
            method: request.method(),
            url: url(response.url()),
            status,
            failure: null,
          });
        }
        if (pageEventsWanted()) {
          tellPageEvent({
            kind: 'request-failed',
            method: request.method(),
            url: eventUrl(response.url()),
            status,
            failure: null,
          });
        }
      }
      if (!pageEventsWanted()) return;
      const logs = readServerLogs(response.headers()['x-piwi-logs']);
      for (const event of backendEvents(logs, request.method(), eventUrl(response.url()), status)) tellPageEvent(event);
    }),
  );
}
