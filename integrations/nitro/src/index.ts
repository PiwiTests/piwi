import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { consola } from 'consola';
// Type-only: importing 'nitropack/runtime' at runtime only resolves inside a
// Nitro build, and this module must also load from node_modules when the
// server bundle externalizes it (e.g. dev builds).
import type { NitroAppPlugin } from 'nitropack';
import { createError } from 'h3';
import { verifyProbeHeader, ProbeNonceCache, type PiwiProbeSpec } from './probe.js';
import {
  buildRouteManifest,
  recordObservedRoute,
  matchedRoutePattern,
  type ManifestRouteEntry,
} from './manifest.js';
import { declaredRoutes } from './route-table.js';
import {
  routeMatchesRequest,
  faultStatus,
  faultDelayMs,
  isThrowFault,
  isExtremeFault,
  isDataFault,
  isDependencyFault,
  dependencyCallMatches,
  mutateResponseBody,
  appliedFaultLabel,
} from './faults.js';

export {
  verifyProbeHeader,
  signProbeMessage,
  probeSigningMessage,
  PROBE_TTL_MS,
  type PiwiProbeSpec,
  type SignedProbe,
} from './probe.js';
export { buildRouteManifest, recordObservedRoute, collapsePathPattern, type RouteManifest } from './manifest.js';
export * from './faults.js';

const MAX_ENTRIES = 50;
const MAX_MSG_LENGTH = 500;
const MAX_STACK_FRAMES = 5;
const MAX_SPANS = 100;

export interface PiwiTestLogEntry {
  timestamp: number;
  level: string;
  category: string;
  message: string;
  stack?: string;
}

/**
 * A server-side span for the in-flight request. Rides back to the Piwi reporter
 * in the `X-Piwi-Trace` response header (gzip+base64 JSON array) and is shown in
 * the dashboard next to the network request that produced it. The plugin always
 * emits a root request span; application code can contribute child spans with
 * `recordServerSpan` (e.g. a DB query, a downstream call).
 */
export interface PiwiServerSpan {
  /** Unique span id (hex). */
  id: string;
  /** Parent span id — child spans nest under the request's root span. */
  parentId?: string;
  /** Operation name, e.g. the route or a DB query label. */
  name: string;
  /** Coarse kind hint for display/color, e.g. 'server', 'db', 'client', 'internal'. */
  kind?: string;
  /** Start time, Unix epoch milliseconds. */
  startMs: number;
  /** Duration in milliseconds. */
  durMs: number;
  /** Outcome. */
  status?: 'ok' | 'error';
  /** Shared W3C trace id for the request (set on the root span). */
  traceId?: string;
  /** Small free-form attribute bag. */
  attrs?: Record<string, string | number | boolean>;
}

/** Parse and shrink a JS/TS stack trace: skip internal/node_modules frames, keep max 5. */
function shrinkStack(stack: string): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split('\n');
  const frames: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue; // skip error message line
    if (trimmed.includes('node:internal') || trimmed.includes('node_modules')) continue;
    if (frames.length >= MAX_STACK_FRAMES) break;
    frames.push(trimmed.slice(3).trim());
  }
  return frames.length > 0 ? frames.join('\n') : undefined;
}

/** Extract stack from an unknown error value, shrunk, or undefined. */
function extractStack(err: unknown): string | undefined {
  if (err instanceof Error && err.stack) return shrinkStack(err.stack);
  return undefined;
}

/** Pull the 32-hex trace-id out of a W3C `traceparent` header, if valid. */
function parseTraceparent(tp: string | string[] | undefined): string | undefined {
  const value = Array.isArray(tp) ? tp[0] : tp;
  if (!value) return undefined;
  const parts = value.split('-');
  if (parts.length >= 3 && parts[1] && /^[0-9a-f]{32}$/i.test(parts[1])) return parts[1];
  return undefined;
}

/** Per-request capture buffer, scoped with `als.run()` around the handler chain. */
interface RequestStore {
  logs: PiwiTestLogEntry[];
  spans: PiwiServerSpan[];
  startMs: number;
  /** Set once the response ended: work the request left running (timers, a lazy client) records nothing more. */
  ended?: boolean;
  /**
   * The request this one runs inside: an internal call (`$fetch` or `localFetch` during server-side rendering) whose
   * response never reaches the browser. Its logs and spans join the enclosing request's when it ends.
   */
  parent?: RequestStore;
  /** A verified probe fault for this request, when one was signed and honored. */
  probe?: PiwiProbeSpec;
  /** The verified fault targets this request and server probes are on: apply it where it takes effect. */
  probeShouldApply?: boolean;
  /** The fault label the server actually applied, reported back in X-Piwi-Trace. */
  probeApplied?: string;
  /** A dependency fault is pending: it applies once a matching outbound call fires. */
  probeDependencyPending?: boolean;
  /** True once a dependency fault has failed one outbound call for this request. */
  probeDependencyConsumed?: boolean;
}

/**
 * Record the fault the server actually applied for this request, so X-Piwi-Trace
 * carries it and the reporter can compare it with the fault it asked for. Called
 * only at the point a fault takes effect, never on a bare route match.
 */
function markProbeApplied(store: RequestStore): void {
  if (store.probe) store.probeApplied = appliedFaultLabel(store.probe);
}

/** Record a log entry on a request still in flight, up to `MAX_ENTRIES`. */
function pushLog(store: RequestStore, entry: PiwiTestLogEntry): void {
  if (!store.ended && store.logs.length < MAX_ENTRIES) store.logs.push(entry);
}

/** Record a span on a request still in flight, up to `MAX_SPANS`. */
function pushSpan(store: RequestStore, span: PiwiServerSpan): void {
  if (!store.ended && store.spans.length < MAX_SPANS) store.spans.push(span);
}

/** Signed probe nonces already honored this process, so a header is single-use. */
const probeNonces = new ProbeNonceCache();

// Links consola calls and recorded spans to the request being handled. The store
// is scoped with als.run() around the whole downstream handler chain: a binding
// made with enterWith() from a request hook dies with the hook's own async scope.
const als = new AsyncLocalStorage<RequestStore>();

/**
 * Record a server-side span for the in-flight request. Shows up in the Piwi
 * Dashboard test-case view (and AI diagnosis) under the request's root span.
 * No-op outside a request scope, once the per-request span cap is reached, or
 * once the request's response has ended.
 */
export function recordServerSpan(span: PiwiServerSpan): void {
  const store = als.getStore();
  if (store) pushSpan(store, span);
}

// The consola reporter is process-global — register it only once.
let reporterAdded = false;

// Capture and probe verification run only in development and test (the ASP.NET
// package's default allow-list is Development and Test): NODE_ENV must be
// `development` or `test`. Any other value, or none at all (`node
// .output/server/index.mjs` sets none), disables capture unless
// PIWI_TEST_LOGS_DISABLED is explicitly `false`, so a deployment that never set
// NODE_ENV exposes no server logs, handler files or route manifest.
const NODE_ENV = process.env.NODE_ENV;
const IS_DEV_OR_TEST = NODE_ENV === 'development' || NODE_ENV === 'test';
const TEST_LOGS_DISABLED =
  process.env.PIWI_TEST_LOGS_DISABLED === 'true' ||
  (!IS_DEV_OR_TEST && process.env.PIWI_TEST_LOGS_DISABLED !== 'false');

/** The shared secret a probe run signs the `X-Piwi-Probe` header with. */
const PROBE_SECRET = process.env.PIWI_PROBE_SECRET || undefined;

/** The declared-surface route path the plugin serves outside production. */
const MANIFEST_PATH = '/__piwi/manifest';

/**
 * Routes the server has matched this process, accumulated for `/__piwi/manifest`
 * next to the declared ones: Nitro exposes no runtime route table, so without the
 * module (`./module`, which reads it at build time) only these are listed.
 */
const observedRoutes = new Map<string, ManifestRouteEntry>();

/**
 * Server probes stay off unless `PIWI_SERVER_PROBES=true`. When off (the
 * default), a signed probe header is still verified and recorded, but no fault
 * is applied.
 */
const SERVER_PROBES_ENABLED = process.env.PIWI_SERVER_PROBES === 'true';

/**
 * Best-effort source file of the matched route handler, for the root span's
 * `piwi.handler` attribute. Nitro exposes the matched route on the event context
 * on recent versions; when it carries no file, the attribute is omitted and the
 * dashboard falls back to its file-routing convention.
 */
function resolveHandlerFile(event: any): string | undefined {
  const matched = event?.context?.matchedRoute as { file?: unknown; filename?: unknown } | undefined;
  const file = matched?.file ?? matched?.filename;
  return typeof file === 'string' && file ? file : undefined;
}

const piwiTestLogs: NitroAppPlugin = (nitroApp) => {
  if (TEST_LOGS_DISABLED) return;

  if (!reporterAdded) {
    reporterAdded = true;
    consola.addReporter({
      log(logObj) {
        if (logObj.level > 1) return; // Warning (1) and Error/Fatal (0) only
        const store = als.getStore();
        if (!store || store.ended) return;
        const msg = logObj.args.map(String).join(' ');
        const stack = logObj.args.map(extractStack).find(Boolean);
        pushLog(store, {
          timestamp: Date.now(),
          level: logObj.level <= 0 ? 'Error' : 'Warning',
          category: logObj.tag ?? '',
          message: msg.length > MAX_MSG_LENGTH ? `${msg.slice(0, MAX_MSG_LENGTH)}…` : msg,
          stack,
        });
      },
    });
  }

  // Wrap the root h3 handler: both the node listener (dev and node-server
  // production entries) and route dispatch go through h3App.handler, so the
  // als.run() scope covers every hook, middleware, and route handler.
  const originalHandler = nitroApp.h3App.handler;
  nitroApp.h3App.handler = ((event) => {
    // Serve the declared-surface manifest outside production (the plugin already
    // returned early when log capture is disabled): the routes the module declared,
    // then the ones observed.
    const requestPath = String(event.path ?? event.node.req.url ?? '').split('?')[0] ?? '';
    if (requestPath === MANIFEST_PATH) {
      const routes = new Map<string, ManifestRouteEntry>();
      for (const route of [...declaredRoutes(), ...observedRoutes.values()]) recordObservedRoute(routes, route);
      const res = event.node.res as any;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(buildRouteManifest(routes)));
      return;
    }

    const enclosing = als.getStore();
    const store: RequestStore = {
      logs: [],
      spans: [],
      startMs: Date.now(),
      ...(enclosing && !enclosing.ended ? { parent: enclosing } : {}),
    };
    event.context._piwiLogs = store.logs;
    event.context._piwiSpans = store.spans;
    // The beforeResponse hook fires outside this handler's async scope (it is
    // driven by the layer above h3App.handler), so als.getStore() is unreliable
    // there — reach the request store through the event context instead.
    event.context._piwiStore = store;

    // Verify a signed probe header, honored only outside production (under the
    // same guard as log capture) and only when a shared secret is configured.
    // The spec is recorded on the request scope, and a fault is applied only when
    // server probes are turned on for the project and this is the Nth match.
    const probe = verifyProbeHeader(event.node.req.headers['x-piwi-probe'], PROBE_SECRET, Date.now(), undefined, probeNonces);
    if (probe) {
      store.probe = probe;
      event.context._piwiProbe = probe;
      if (SERVER_PROBES_ENABLED) {
        const method = String(event.method ?? event.node.req.method ?? 'GET');
        const reqPath = String(event.path ?? event.node.req.url ?? '').split('?')[0] ?? '';
        // The reporter signs the header onto exactly the request it wants faulted
        // (it already chose the Nth match), so a route match is the whole
        // selector; the header's single-use nonce keeps it from applying twice.
        // The fault is only *marked applied* where it actually takes effect (the
        // handler wrap, the beforeResponse hook, or the outbound-call patch), so
        // an unimplemented fault (`replay`) or a no-op (`data` on an array body)
        // records inconclusive, never a false gap.
        if (routeMatchesRequest(probe, method, reqPath)) {
          store.probeShouldApply = true;
          // A dependency fault only applies once a matching outbound call fires.
          if (isDependencyFault(probe.fault)) store.probeDependencyPending = true;
        }
      }
    }

    // Patch res.end so the X-Piwi-Logs / X-Piwi-Trace headers are injected for
    // ALL responses, including H3 error responses where Nitro bypasses the
    // 'beforeResponse' hook (h3 skips onBeforeResponse once the error handler
    // has called res.end).
    const res = event.node.res as any;
    const originalEnd = res.end.bind(res) as (...args: any[]) => any;
    res.end = (...args: any[]) => {
      if (!res.headersSent) {
        // Collect any unhandled H3/Nitro errors — they are synchronously pushed
        // to event.context.nitro.errors before errorHandler runs, so they're
        // always available here even for error responses.
        const nitroErrors = (event.context.nitro as any)?.errors as
          | Array<{ error: unknown }>
          | undefined;
        if (nitroErrors?.length) {
          for (const { error } of nitroErrors) {
            const msg = error instanceof Error ? (error.message || String(error)) : String(error);
            pushLog(store, {
              timestamp: Date.now(),
              level: 'Error',
              category: 'server',
              message: msg.length > MAX_MSG_LENGTH ? `${msg.slice(0, MAX_MSG_LENGTH)}…` : msg,
              stack: extractStack(error),
            });
          }
        }
        res.setHeader('X-Piwi-Logs', gzipSync(Buffer.from(JSON.stringify(store.logs))).toString('base64'));

        // Synthesize the root request span (server-side processing time, route,
        // status), correlate any app-recorded child spans under it, and ship the
        // whole tree. When the caller sent a W3C traceparent, reuse its trace id
        // so the spans line up with an external tracing backend.
        const endMs = Date.now();
        const method = String(event.method ?? event.node.req.method ?? 'GET');
        const path = String(event.path ?? event.node.req.url ?? '').split('?')[0] ?? '';
        const statusCode = Number(res.statusCode) || 0;
        const traceId =
          parseTraceparent(event.node.req.headers['traceparent']) ?? randomBytes(16).toString('hex');
        const handlerFile = resolveHandlerFile(event);

        // Record the route the router matched for the declared-surface manifest.
        const pattern = matchedRoutePattern(event.context?.matchedRoute);
        if (pattern) recordObservedRoute(observedRoutes, { method, pattern, handler: handlerFile });

        const rootSpan: PiwiServerSpan = {
          id: randomBytes(8).toString('hex'),
          name: `${method} ${path}`.trim(),
          kind: 'server',
          startMs: store.startMs,
          durMs: Math.max(0, endMs - store.startMs),
          status: statusCode >= 500 ? 'error' : 'ok',
          traceId,
          attrs: {
            'http.method': method,
            'http.route': path,
            'http.status_code': statusCode,
            ...(handlerFile ? { 'piwi.handler': handlerFile } : {}),
            // A probe was signed for this request; `applied` names the fault the
            // server honored, or is absent when it was not applied (inconclusive).
            ...(store.probe ? { 'piwi.probe': store.probe.fault } : {}),
            ...(store.probeApplied ? { 'piwi.probe.applied': store.probeApplied } : {}),
          },
        };
        for (const s of store.spans) if (!s.parentId) s.parentId = rootSpan.id;
        const spanPayload = [rootSpan, ...store.spans].slice(0, MAX_SPANS);
        res.setHeader('X-Piwi-Trace', gzipSync(Buffer.from(JSON.stringify(spanPayload))).toString('base64'));
        if (store.parent) {
          for (const entry of store.logs) pushLog(store.parent, entry);
          for (const span of spanPayload) pushSpan(store.parent, span);
        }
      }
      store.ended = true;
      return originalEnd(...args);
    };

    return als.run(store, async () => {
      // Apply the handler and pipeline faults inside the request scope. Delay
      // faults slow the response; throw/status/auth run the server's error path;
      // extreme returns the empty default. Each is marked applied only once it
      // takes effect. Data and dependency faults are applied later (the
      // beforeResponse hook and the outbound-fetch patch); an unimplemented fault
      // (`replay`) matches none of these, so it is never marked applied.
      const spec = store.probeShouldApply ? store.probe : undefined;
      if (spec && !isDataFault(spec.fault) && !isDependencyFault(spec.fault)) {
        const delayMs = faultDelayMs(spec.fault);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (isThrowFault(spec.fault)) {
          markProbeApplied(store);
          throw createError({ statusCode: 500, statusMessage: 'Piwi probe: injected error' });
        }
        const status = faultStatus(spec.fault);
        if (status != null) {
          markProbeApplied(store);
          throw createError({ statusCode: status, statusMessage: `Piwi probe: injected ${status}` });
        }
        if (isExtremeFault(spec.fault)) {
          markProbeApplied(store);
          // Send the empty response ourselves: h3's toNodeListener ignores the
          // handler's return value, so returning '' here would never end the
          // node response and the probed request would hang until its timeout.
          res.statusCode = 200;
          res.end('');
          return '';
        }
        // A pure delay fault took effect once the delay elapsed.
        if (delayMs > 0) markProbeApplied(store);
      }
      return originalHandler(event);
    });
  }) as typeof originalHandler;

  // Data faults mutate the response body before it is serialized and sent. The
  // fault is marked applied only when the body actually changed — `data` on an
  // array body, or an empty object, is left unchanged and records inconclusive.
  nitroApp.hooks.hook('beforeResponse', (event: any, response: { body?: unknown }) => {
    const store = event.context?._piwiStore as RequestStore | undefined;
    const probe = store?.probe;
    if (store?.probeShouldApply && probe && isDataFault(probe.fault) && response && 'body' in response) {
      const before = response.body;
      const mutated = mutateResponseBody(probe.fault, before);
      if (mutated !== before) {
        response.body = mutated;
        markProbeApplied(store);
      }
    }
  });

  // Dependency faults fail one outbound call the handler makes through the
  // instrumented `$fetch`, so the handler's own error handling runs. The fault
  // targets the call whose URL names `spec.dependency`; when no outbound call
  // matches, nothing is applied and the probe records inconclusive.
  if (SERVER_PROBES_ENABLED) {
    const g = globalThis as any;
    if (typeof g.$fetch === 'function' && !g.$fetch.__piwiProbePatched) {
      const original = g.$fetch;
      const patched = (...args: unknown[]) => {
        const store = als.getStore();
        if (
          store?.probeDependencyPending &&
          store.probe &&
          isDependencyFault(store.probe.fault) &&
          !store.probeDependencyConsumed &&
          dependencyCallMatches(store.probe.dependency, outboundCallTarget(args))
        ) {
          store.probeDependencyConsumed = true;
          markProbeApplied(store);
          return Promise.reject(new Error('Piwi probe: injected dependency failure'));
        }
        return original(...args);
      };
      patched.__piwiProbePatched = true;
      g.$fetch = Object.assign(patched, original);
    }
  }
};

/** The request target of an outbound `$fetch` call, for dependency-fault matching. */
function outboundCallTarget(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first instanceof URL) return first.toString();
  if (first && typeof first === 'object') {
    const url = (first as { url?: unknown; href?: unknown }).url ?? (first as { href?: unknown }).href;
    if (typeof url === 'string') return url;
  }
  return '';
}

export default piwiTestLogs;
