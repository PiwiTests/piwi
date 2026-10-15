import type { APIResponse } from '@playwright/test';
import { callMethod } from './quiet-capture.js';

/**
 * The calls a test makes through Playwright's API request contexts. An
 * `APIRequestContext` emits no events, so each one is handed out behind a
 * proxy: every context `playwright.request.newContext()` creates (the
 * `request` fixture's, a fixture's or a test's own, one from the `request`
 * that `@playwright/test` exports) and a browser context's own
 * (`context.request`, which its pages share as `page.request`). The proxy
 * times each call that sends a request and hands it to the running test's
 * recorder, with the `APIResponse` the test receives (its body is buffered,
 * so a read does not consume it) or the error the call threw. Between tests a
 * call runs untouched.
 *
 * The proxy forwards a call to the context itself (`callMethod`), so the call
 * keeps its name (`apiRequestContext.get`), its step and its error, and the
 * context's own methods calling each other (`get` calls `fetch`) never reach
 * the proxy: a call is recorded once. Every other property reads through to
 * the context, its methods bound to it, so `dispose()` closes the context
 * Playwright tracks.
 */

/** The `APIRequestContext` methods that send a request, each resolving to an `APIResponse`. */
const SENDING_METHODS: ReadonlySet<string> = new Set(['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head']);

/** One call that sent a request, as the proxy saw it. */
export interface ApiCall {
  /** The HTTP method: the one the method names (`get` is `GET`), else `fetch`'s `method` option or its request's. */
  method: string;
  /** The URL the call named, as given (relative to the context's base URL, or absolute); null when it named none. */
  url: string | null;
  /** The base URL the context was created with, when its creation named one. */
  baseURL: string | null;
  /** When the call was made and when it settled, Unix epoch ms, read by the proxy. */
  startedAt: number;
  endedAt: number;
  /** The response the test received; null when the call threw. */
  response: APIResponse | null;
  /** What the call threw, when it threw. */
  error?: unknown;
}

/** Records one call of the running test. */
export type ApiCallRecorder = (call: ApiCall) => void;

/** The running test's recorder, read as a call starts; null between tests. */
export type ApiCallRecorderSource = () => ApiCallRecorder | null;

/** The part of Playwright's `APIRequest` (`playwright.request`) the proxy wraps. */
interface ApiRequestLike {
  newContext: (...args: unknown[]) => Promise<unknown>;
}

/** The proxy each context is handed out as, so a context reached twice is handed out as the same proxy. */
const PROXIES = new WeakMap<object, object>();

/** The proxies themselves, never wrapped again. */
const OBSERVED = new WeakSet<object>();

/** The `playwright.request` objects whose `newContext` hands out proxies. */
const PATCHED_REQUESTS = new WeakSet<object>();

/**
 * Hand out every context `playwright.request.newContext()` creates behind the
 * call proxy. Once per `playwright`; a `playwright` without the method is left
 * as it is.
 */
export function observeApiRequests(playwright: unknown, recorder: ApiCallRecorderSource): void {
  const apiRequest = (playwright as { request?: unknown } | null | undefined)?.request as ApiRequestLike | undefined;
  if (!apiRequest || typeof apiRequest !== 'object' || typeof apiRequest.newContext !== 'function') return;
  if (PATCHED_REQUESTS.has(apiRequest)) return;
  PATCHED_REQUESTS.add(apiRequest);
  const create = apiRequest.newContext.bind(apiRequest);
  apiRequest.newContext = async function newContext(...args: unknown[]): Promise<unknown> {
    const context = await create(...args);
    return observeApiRequestContext(context, recorder, baseUrlOption(args[0]));
  };
}

/**
 * The context behind the call proxy: the same proxy each time for the same
 * context, and a proxy as it is.
 */
export function observeApiRequestContext<T>(
  context: T,
  recorder: ApiCallRecorderSource,
  baseURL: string | null = null,
): T {
  if (!context || typeof context !== 'object' || OBSERVED.has(context)) return context;
  const known = PROXIES.get(context);
  if (known) return known as T;
  // One forwarder per method, so a method read twice is the same function.
  const forwarders = new Map<PropertyKey, { method: unknown; forward: unknown }>();
  const proxy = new Proxy(context, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function' || prop === 'constructor') return value;
      const cached = forwarders.get(prop);
      if (cached?.method === value) return cached.forward;
      const forward =
        typeof prop === 'string' && SENDING_METHODS.has(prop)
          ? sendingMethod(target, prop, recorder, baseURL)
          : (value as (...a: unknown[]) => unknown).bind(target);
      forwarders.set(prop, { method: value, forward });
      return forward;
    },
  });
  PROXIES.set(context, proxy);
  OBSERVED.add(proxy);
  return proxy;
}

/** A sending method of the context: the call, timed and recorded while a test runs. */
function sendingMethod(
  target: object,
  prop: string,
  recorder: ApiCallRecorderSource,
  baseURL: string | null,
): (...args: unknown[]) => unknown {
  return function send(...args: unknown[]): unknown {
    const record = recorder();
    if (!record) return callMethod(target, prop, args);
    const startedAt = Date.now();
    const result = callMethod(target, prop, args);
    if (typeof (result as { then?: unknown } | null)?.then !== 'function') return result;
    const report = (response: APIResponse | null, error?: unknown) => {
      try {
        record({
          method: methodOf(prop, args),
          url: urlOf(args[0]),
          baseURL,
          startedAt,
          endedAt: Date.now(),
          response,
          error,
        });
      } catch {
        /* the record is a side channel: it never affects the call */
      }
    };
    return (result as Promise<APIResponse>).then(
      (response) => {
        report(response);
        return response;
      },
      (error: unknown) => {
        report(null, error);
        throw error;
      },
    );
  };
}

/** The HTTP method of a call: the method's own, else `fetch`'s `method` option, else its request's, else `GET`. */
function methodOf(prop: string, args: unknown[]): string {
  if (prop !== 'fetch') return prop.toUpperCase();
  const option = (args[1] as { method?: unknown } | null | undefined)?.method;
  if (typeof option === 'string' && option) return option.toUpperCase();
  const request = args[0] as { method?: () => unknown } | null | undefined;
  const method = typeof request?.method === 'function' ? request.method() : null;
  return typeof method === 'string' && method ? method.toUpperCase() : 'GET';
}

/** The URL a call named: a string, or the URL of the `Request` it passed. */
function urlOf(target: unknown): string | null {
  if (typeof target === 'string') return target;
  const url =
    typeof (target as { url?: unknown } | null)?.url === 'function' ? (target as { url: () => unknown }).url() : null;
  return typeof url === 'string' ? url : null;
}

/** The `baseURL` option of a `newContext` call, when it names one. */
function baseUrlOption(options: unknown): string | null {
  const baseURL = (options as { baseURL?: unknown } | null | undefined)?.baseURL;
  return typeof baseURL === 'string' && baseURL ? baseURL : null;
}

/** The longest failure text kept for a call that threw. */
const MAX_FAILURE_LENGTH = 300;

/** The prefix Playwright gives the error of an API call: `apiRequestContext.get: `. */
const API_ERROR_PREFIX = /^apiRequestContext\.\w+: /;

/** Playwright's error for a call that `failOnStatusCode` failed names the status its response had: `404 Not Found`. */
const STATUS_FAILURE = /^(\d{3}) /;

/**
 * A call's network entry, in the shape the page capture records, with no
 * resource type: no page made the request. A call that resolved has its
 * response's URL, status and timing (Playwright's, else the proxy's clock).
 * One that threw has the URL it named, resolved against its context's base
 * URL or else `baseURL`, timed by the proxy, and status 0 with its error's
 * first line as `failure`, or the status Playwright names when it failed the
 * call for it (`failOnStatusCode`). Null when a thrown call named no URL.
 */
export function apiCallEntry(call: ApiCall, baseURL: string | null): Record<string, unknown> | null {
  const response = call.response;
  if (response) {
    const timing = responseTiming(response) ?? { startTime: call.startedAt, duration: call.endedAt - call.startedAt };
    return {
      method: call.method,
      url: response.url(),
      status: response.status(),
      duration: timing.duration,
      startTime: timing.startTime,
    };
  }
  const url = resolveUrl(call.url, call.baseURL ?? baseURL);
  if (!url) return null;
  const failure = failureText(call.error);
  const status = STATUS_FAILURE.exec(failure);
  return {
    method: call.method,
    url,
    status: status ? Number(status[1]) : 0,
    duration: Math.max(0, call.endedAt - call.startedAt),
    startTime: call.startedAt,
    ...(status ? {} : { failure }),
  };
}

/** Start and duration from Playwright's timing (1.63 and later): to the response end from the request start. */
function responseTiming(response: APIResponse): { startTime: number; duration: number } | null {
  if (typeof response.timing !== 'function') return null;
  const timing = response.timing();
  if (!(timing.startTime > 0) || !(timing.responseEnd >= 0)) return null;
  return {
    startTime: timing.startTime,
    duration: Math.max(0, Math.round(timing.responseEnd - Math.max(0, timing.requestStart))),
  };
}

/** A URL resolved against a base, as Playwright resolves it; as given when it cannot be. */
function resolveUrl(url: string | null, baseURL: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url, baseURL ?? undefined).toString();
  } catch {
    return url;
  }
}

/** The first line of what a call threw, without Playwright's prefix. */
function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split('\n', 1)[0]!.replace(API_ERROR_PREFIX, '').trim();
  return (line || 'failed').slice(0, MAX_FAILURE_LENGTH);
}
