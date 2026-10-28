import * as path from 'node:path';
import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';
import { hideSecretsInText, hideSecretsInUrl } from '@piwitests/core/mask';
import { MAX_RUN_EVENT_TEXT, type Place } from '@piwitests/core/run-channel';
import { runEventsWanted, tellEvent } from './run-channel.js';

/**
 * What the running test does, told to the editor while an agent follows the run (the run channel's `events`, which
 * the editor asks for): each call of the test as it ends, through Playwright's instrumentation (`_instrumentation`,
 * feature-checked, which never hears an internal call, so none of Piwi's own), with the place in the user's code that
 * made it; and each page's navigations, its console errors and warnings, the errors it threw that nothing caught, and
 * its requests that failed or were answered with an error status. Every text has its credentials hidden
 * (`@piwitests/core/mask`). Nothing is sent while nobody follows the run, nor between tests.
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

/** A frame's file under the run's working directory, with forward slashes; null for one outside it or in a package. */
function userFile(file: string | undefined): string | null {
  if (!file) return null;
  const absolute = file.startsWith('file://') ? new URL(file).pathname : file;
  if (/[\\/]node_modules[\\/]/.test(absolute)) return null;
  const relative = path.relative(process.cwd(), absolute);
  if (!relative || path.isAbsolute(relative) || relative.startsWith('..')) return null;
  return relative.split(path.sep).join('/');
}

/** The place in the user's code that made a call: its first frame there. */
export function callPlace(frames: ApiZone['frames']): Place | null {
  for (const frame of frames ?? []) {
    const file = userFile(frame.file);
    if (!file || !frame.line || frame.line < 1) continue;
    return { file, line: frame.line, ...(frame.column && frame.column > 0 ? { column: frame.column } : {}) };
  }
  return null;
}

/** A call's title: Playwright's own, else its name and the selector it acts on, its credentials hidden. */
export function callTitle(zone: ApiZone, channel: ApiChannel | undefined): string {
  const selector = typeof channel?.params?.selector === 'string' ? ` ${channel.params.selector}` : '';
  const title = zone.title || `${zone.apiName || 'call'}${selector}`;
  return hideSecretsInText(title).slice(0, 300);
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

/** Hear a page's navigations, console errors and warnings, uncaught errors and failed requests. */
export function watchPageEvents(page: Page): void {
  if (watched.has(page) || typeof page.on !== 'function') return;
  watched.add(page);
  const text = (value: string) => hideSecretsInText(value).slice(0, MAX_RUN_EVENT_TEXT);
  const url = (value: string) => hideSecretsInUrl(value).slice(0, 8192);
  const guard = (tell: () => void) => {
    if (!runEventsWanted()) return;
    try {
      tell();
    } catch {
      /* a page event handler must never throw */
    }
  };
  page.on('framenavigated', (frame) =>
    guard(() => {
      if (frame === page.mainFrame()) tellEvent({ kind: 'navigation', url: url(frame.url()) });
    }),
  );
  page.on('console', (message: ConsoleMessage) =>
    guard(() => {
      const type = message.type();
      if (type === 'error' || type === 'warning')
        tellEvent({ kind: 'console', level: type, text: text(message.text()) });
    }),
  );
  page.on('pageerror', (error: Error) => guard(() => tellEvent({ kind: 'page-error', text: text(errorText(error)) })));
  page.on('requestfailed', (request: Request) =>
    guard(() =>
      tellEvent({
        kind: 'request-failed',
        method: request.method(),
        url: url(request.url()),
        status: null,
        failure: request.failure()?.errorText ? text(request.failure()!.errorText).slice(0, 500) : null,
      }),
    ),
  );
  page.on('response', (response: Response) =>
    guard(() => {
      const status = response.status();
      if (status < 400 || status > 599) return;
      const request = response.request();
      tellEvent({ kind: 'request-failed', method: request.method(), url: url(response.url()), status, failure: null });
    }),
  );
}
