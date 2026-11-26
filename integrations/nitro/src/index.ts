import type { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { consola } from 'consola';
import { createError } from 'h3';
import { verifyProbeHeader, ProbeNonceCache, type PiwiProbeSpec } from './probe.js';
import {
  buildRouteManifest,
  recordObservedRoute,
  matchedRoutePattern,
  type ManifestRouteEntry,
} from './manifest.js';
import { declaredRoutes } from './route-table.js';
import { buildServerEnvironment, type PiwiPluginOptions } from './environment.js';
import { requestScope } from './request-scope.js';
import {
  beginRequestCoverage,
  collectCoverage,
  coverageActive,
  CoverageRequestError,
  nameRequest,
  parseGranularity,
  runCoverage,
  settleRequest,
  type RequestCoverage,
} from './coverage-runtime.js';
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
export {
  buildServerEnvironment,
  type ServerEnvironment,
  type EnvironmentReaders,
  type PiwiPluginOptions,
} from './environment.js';

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
  /**
   * The coverage the request's code records into, in a coverage build. A request the server makes to itself shares
   * the enclosing request's: the browser only sees the outer response.
   */
  coverage?: RequestCoverage;
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

// Links consola calls, recorded spans and coverage to the request being handled.
// The store is scoped with als.run() around the whole downstream handler chain: a
// binding made with enterWith() from a request hook dies with the hook's own async
// scope. The coverage runtime reads the same store (`request-scope.ts`).
const als = requestScope as AsyncLocalStorage<RequestStore>;

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

// The consola reporter is process-global, and so is the request store it writes into: register it once per
// process, even when the bundle holds two copies of this module.
const REPORTER_KEY = Symbol.for('piwitests.consolaReporter');

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

/** The declared-surface route path the plugin serves while capture is on (`NODE_ENV` `development` or `test`). */
const MANIFEST_PATH = '/__piwi/manifest';

/** The runtime facts of the server process, served beside the manifest. */
const ENVIRONMENT_PATH = '/__piwi/environment';

/** The coverage endpoints a coverage build serves beside the manifest. */
const COVERAGE_COLLECT_PATH = '/__piwi/coverage/collect';
const COVERAGE_RUN_PATH = '/__piwi/coverage/run';

/** Largest collection body read, in bytes. */
const MAX_COVERAGE_BODY_BYTES = 1024 * 1024;

/** The body of a request as JSON, refused past `MAX_COVERAGE_BODY_BYTES`. */
async function readJsonBody(chunks: AsyncIterable<Uint8Array>): Promise<unknown> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    if (size > MAX_COVERAGE_BODY_BYTES) throw new CoverageRequestError(413, 'the body is limited to 1 MB');
    parts.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new CoverageRequestError(400, 'the body is not JSON');
  }
}

/** A JSON answer of one of the plugin's own routes. */
interface PiwiAnswer {
  status: number;
  body: unknown;
  /** Sent with `Cache-Control: no-store`. */
  noStore?: boolean;
}

/** The request a plugin route answers: its method, path and query, and its body, read on demand. */
interface PiwiRouteRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: () => AsyncIterable<Uint8Array>;
}

/** Answer a coverage endpoint; undefined when the request is not one, so it reaches the application. */
function answerCoverage(request: PiwiRouteRequest): Promise<PiwiAnswer> | undefined {
  if ((request.path !== COVERAGE_COLLECT_PATH && request.path !== COVERAGE_RUN_PATH) || !coverageActive()) {
    return undefined;
  }
  const answer = (status: number, body: unknown): PiwiAnswer => ({ status, body, noStore: true });
  const fail = (error: unknown) =>
    error instanceof CoverageRequestError
      ? answer(error.status, { error: error.message })
      : answer(500, { error: errorMessageOf(error) });
  if (request.path === COVERAGE_RUN_PATH) {
    if (request.method !== 'GET') return Promise.resolve(answer(405, { error: 'GET only' }));
    try {
      return Promise.resolve(answer(200, runCoverage(parseGranularity(request.query.get('granularity')))));
    } catch (error) {
      return Promise.resolve(fail(error));
    }
  }
  if (request.method !== 'POST') return Promise.resolve(answer(405, { error: 'POST only' }));
  return readJsonBody(request.body()).then((body) => answer(200, collectCoverage(body)), fail);
}

/**
 * Answer one of the plugin's own routes: the coverage endpoints, the manifest, which lists the routes the module
 * declared, then the ones observed, and the process's runtime facts. Undefined for any other request.
 */
function answerPiwiRoute(
  request: PiwiRouteRequest,
  options: PiwiPluginOptions,
): PiwiAnswer | Promise<PiwiAnswer> | undefined {
  const coverage = answerCoverage(request);
  if (coverage) return coverage;
  if (request.path === MANIFEST_PATH) {
    const routes = new Map<string, ManifestRouteEntry>();
    for (const route of [...declaredRoutes(), ...observedRoutes.values()]) recordObservedRoute(routes, route);
    return { status: 200, body: buildRouteManifest(routes) };
  }
  if (request.path === ENVIRONMENT_PATH) {
    return { status: 200, body: buildServerEnvironment(undefined, options), noStore: true };
  }
  return undefined;
}

/** The headers of a plugin route's answer. */
function answerHeaders(answer: PiwiAnswer): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(answer.noStore ? { 'Cache-Control': 'no-store' } : {}),
  };
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/** A server plugin for Nitro 2 (nitropack) and Nitro 3: it receives the app Nitro starts. */
export type PiwiNitroPlugin = (nitroApp: any) => void;

/** What the plugin replaces in a Nitro 2 app (nitropack): the handler of its h3 v1 app, and the hook it adds. */
interface Nitro2App {
  h3App: { handler: (event: any) => unknown };
  hooks: { hook(name: string, listener: (...args: any[]) => unknown): unknown };
}

/** What the plugin replaces in a Nitro 3 app: the `fetch` every request reaches the app through. */
interface Nitro3App {
  fetch: (request: Request) => Response | Promise<Response>;
}

/**
 * The plugin with options, for a server plugin file that tells it about the application:
 * `export default piwiPlugin({ appVersion: '1.4.0' })` in place of re-exporting the default export.
 */
export function piwiPlugin(options: PiwiPluginOptions = {}): PiwiNitroPlugin {
  return (nitroApp: Nitro2App | Nitro3App) => install(nitroApp, options);
}

function install(nitroApp: Nitro2App | Nitro3App, options: PiwiPluginOptions): void {
  if (TEST_LOGS_DISABLED) return;

  const globals = globalThis as Record<symbol, unknown>;
  if (!globals[REPORTER_KEY]) {
    globals[REPORTER_KEY] = true;
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

  if ('h3App' in nitroApp && nitroApp.h3App) installOnNitro2(nitroApp, options);
  else installOnNitro3(nitroApp as Nitro3App, options);

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
}

/**
 * A request's store. A request made inside another one still in flight (`$fetch` or `localFetch` during server-side
 * rendering) records into the coverage of the enclosing one, and its logs and spans join the enclosing one's when it
 * ends.
 */
function openRequestStore(): RequestStore {
  const enclosing = als.getStore();
  const nested = enclosing !== undefined && !enclosing.ended;
  const coverage = nested ? enclosing.coverage : beginRequestCoverage();
  return {
    logs: [],
    spans: [],
    startMs: Date.now(),
    ...(nested ? { parent: enclosing } : {}),
    ...(coverage ? { coverage } : {}),
  };
}

/**
 * Verify a signed probe header, honored only while capture is on (the same
 * guard as log capture: NODE_ENV `development` or `test`, unless
 * PIWI_TEST_LOGS_DISABLED says otherwise) and only when a shared secret is
 * configured.
 * The spec is recorded on the request scope, and a fault is applied only when
 * server probes are turned on for the project and this is the Nth match.
 */
function readProbe(
  store: RequestStore,
  header: string | string[] | undefined,
  method: string,
  path: string,
): PiwiProbeSpec | undefined {
  const probe = verifyProbeHeader(header, PROBE_SECRET, Date.now(), undefined, probeNonces);
  if (!probe) return undefined;
  store.probe = probe;
  // The reporter signs the header onto exactly the request it wants faulted
  // (it already chose the Nth match), so a route match is the whole
  // selector; the header's single-use nonce keeps it from applying twice.
  // The fault is only *marked applied* where it actually takes effect (before
  // the handler, on the response body, or in the outbound-call patch), so an
  // unimplemented fault (`replay`) or a no-op (`data` on an array body)
  // records inconclusive, never a false gap.
  if (SERVER_PROBES_ENABLED && routeMatchesRequest(probe, method, path)) {
    store.probeShouldApply = true;
    // A dependency fault only applies once a matching outbound call fires.
    if (isDependencyFault(probe.fault)) store.probeDependencyPending = true;
  }
  return probe;
}

/** The fault a request's handler meets: a delay, an error, a status, or the empty default (`extreme`). */
type HandlerFault = { kind: 'error'; status: number; message: string } | { kind: 'empty' } | undefined;

/**
 * Apply the handler and pipeline faults inside the request scope. Delay
 * faults slow the response; throw/status/auth answer with an error status;
 * extreme returns the empty default. Each is marked applied only once it
 * takes effect. Data and dependency faults are applied later (on the response
 * body and in the outbound-fetch patch); an unimplemented fault (`replay`)
 * matches none of these, so it is never marked applied.
 */
async function handlerFault(store: RequestStore): Promise<HandlerFault> {
  const spec = store.probeShouldApply ? store.probe : undefined;
  if (!spec || isDataFault(spec.fault) || isDependencyFault(spec.fault)) return undefined;
  const delayMs = faultDelayMs(spec.fault);
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  if (isThrowFault(spec.fault)) {
    markProbeApplied(store);
    return { kind: 'error', status: 500, message: 'Piwi probe: injected error' };
  }
  const status = faultStatus(spec.fault);
  if (status != null) {
    markProbeApplied(store);
    return { kind: 'error', status, message: `Piwi probe: injected ${status}` };
  }
  if (isExtremeFault(spec.fault)) {
    markProbeApplied(store);
    return { kind: 'empty' };
  }
  // A pure delay fault took effect once the delay elapsed.
  if (delayMs > 0) markProbeApplied(store);
  return undefined;
}

/**
 * Apply a data fault to the body a request answers with, marked applied only when the body actually changed: `data`
 * on an array body, or an empty object, is left unchanged and records inconclusive.
 */
function faultedBody(store: RequestStore, body: unknown): unknown {
  const probe = store.probe;
  if (!store.probeShouldApply || !probe || !isDataFault(probe.fault)) return body;
  const mutated = mutateResponseBody(probe.fault, body);
  if (mutated !== body) markProbeApplied(store);
  return mutated;
}

/** What the plugin reads of a request as it ends, for its root span and the manifest. */
interface EndedRequest {
  method: string;
  path: string;
  statusCode: number;
  traceparent: string | string[] | undefined;
  /** The context Nitro gave the request: the matched route, and the errors Nitro collected. */
  context: any;
}

/**
 * The X-Piwi-Logs and X-Piwi-Trace headers of a request that ends, its logs and the spans under its root span. A
 * request made inside another one hands both to the enclosing request too.
 */
function piwiHeaders(store: RequestStore, ended: EndedRequest): { 'X-Piwi-Logs': string; 'X-Piwi-Trace': string } {
  // Collect any unhandled H3/Nitro errors — they are pushed to the request's
  // `nitro.errors` before the error handler runs, so they're always available
  // here even for error responses.
  const nitroErrors = ended.context?.nitro?.errors as Array<{ error: unknown }> | undefined;
  if (nitroErrors?.length) {
    for (const { error } of nitroErrors) {
      const msg = error instanceof Error ? error.message || String(error) : String(error);
      pushLog(store, {
        timestamp: Date.now(),
        level: 'Error',
        category: 'server',
        message: msg.length > MAX_MSG_LENGTH ? `${msg.slice(0, MAX_MSG_LENGTH)}…` : msg,
        stack: extractStack(error),
      });
    }
  }
  const logs = gzipSync(Buffer.from(JSON.stringify(store.logs))).toString('base64');

  // Synthesize the root request span (server-side processing time, route,
  // status), correlate any app-recorded child spans under it, and ship the
  // whole tree. When the caller sent a W3C traceparent, reuse its trace id
  // so the spans line up with an external tracing backend.
  const endMs = Date.now();
  const traceId = parseTraceparent(ended.traceparent) ?? randomBytes(16).toString('hex');
  const handlerFile = resolveHandlerFile(ended);

  // Record the route the router matched for the declared-surface manifest.
  const pattern = matchedRoutePattern(ended.context?.matchedRoute);
  if (pattern) recordObservedRoute(observedRoutes, { method: ended.method, pattern, handler: handlerFile });

  const rootSpan: PiwiServerSpan = {
    id: randomBytes(8).toString('hex'),
    name: `${ended.method} ${ended.path}`.trim(),
    kind: 'server',
    startMs: store.startMs,
    durMs: Math.max(0, endMs - store.startMs),
    status: ended.statusCode >= 500 ? 'error' : 'ok',
    traceId,
    attrs: {
      'http.method': ended.method,
      'http.route': ended.path,
      'http.status_code': ended.statusCode,
      ...(handlerFile ? { 'piwi.handler': handlerFile } : {}),
      // A probe was signed for this request; `applied` names the fault the
      // server honored, or is absent when it was not applied (inconclusive).
      ...(store.probe ? { 'piwi.probe': store.probe.fault } : {}),
      ...(store.probeApplied ? { 'piwi.probe.applied': store.probeApplied } : {}),
    },
  };
  for (const s of store.spans) if (!s.parentId) s.parentId = rootSpan.id;
  const spanPayload = [rootSpan, ...store.spans].slice(0, MAX_SPANS);
  if (store.parent) {
    for (const entry of store.logs) pushLog(store.parent, entry);
    for (const span of spanPayload) pushSpan(store.parent, span);
  }
  return {
    'X-Piwi-Logs': logs,
    'X-Piwi-Trace': gzipSync(Buffer.from(JSON.stringify(spanPayload))).toString('base64'),
  };
}

/**
 * Nitro 2: wrap the root h3 handler. Both the node listener (dev and node-server
 * production entries) and route dispatch go through h3App.handler, so the
 * als.run() scope covers every hook, middleware, and route handler.
 */
function installOnNitro2(nitroApp: Nitro2App, options: PiwiPluginOptions): void {
  const originalHandler = nitroApp.h3App.handler;
  nitroApp.h3App.handler = (event: any) => {
    const requestPath = String(event.path ?? event.node.req.url ?? '').split('?')[0] ?? '';
    const method = String(event.method ?? event.node.req.method ?? 'GET');
    const res = event.node.res as any;
    // Serve the plugin's own routes while log capture is on (the plugin already returned early when it is off).
    const answer = answerPiwiRoute(
      {
        method: method.toUpperCase(),
        path: requestPath,
        query: new URL(String(event.node.req.url ?? ''), 'http://localhost').searchParams,
        body: () => event.node.req as AsyncIterable<Uint8Array>,
      },
      options,
    );
    if (answer) {
      const write = (done: PiwiAnswer) => {
        res.statusCode = done.status;
        for (const [name, value] of Object.entries(answerHeaders(done))) res.setHeader(name, value);
        res.end(JSON.stringify(done.body));
      };
      if (answer instanceof Promise) return answer.then(write);
      write(answer);
      return;
    }

    const store = openRequestStore();
    const nested = store.parent !== undefined;
    event.context._piwiLogs = store.logs;
    event.context._piwiSpans = store.spans;
    // The beforeResponse hook fires outside this handler's async scope (it is
    // driven by the layer above h3App.handler), so als.getStore() is unreliable
    // there — reach the request store through the event context instead.
    event.context._piwiStore = store;
    const probe = readProbe(store, event.node.req.headers['x-piwi-probe'], method, requestPath);
    if (probe) event.context._piwiProbe = probe;

    // Patch res.end so the X-Piwi-Logs / X-Piwi-Trace headers are injected for
    // ALL responses, including H3 error responses where Nitro bypasses the
    // 'beforeResponse' hook (h3 skips onBeforeResponse once the error handler
    // has called res.end).

    // Name the request's coverage on its response once instrumented code ran for it. Every way of sending headers
    // goes through writeHead (`end` and `write` call it when nothing did), so a streamed response is named too. A
    // request the server makes to itself is named by the outer one.
    const coverage = store.coverage;
    if (coverage && !nested) {
      const originalWriteHead = res.writeHead as (...args: any[]) => any;
      res.writeHead = function (this: unknown, ...args: any[]) {
        const id = nameRequest(coverage);
        if (id && !res.headersSent) res.setHeader('X-Piwi-Coverage', id);
        return originalWriteHead.apply(this, args);
      };
      res.once('close', () => settleRequest(coverage));
    }

    const originalEnd = res.end.bind(res) as (...args: any[]) => any;
    res.end = (...args: any[]) => {
      if (!res.headersSent) {
        const headers = piwiHeaders(store, {
          method,
          path: requestPath,
          statusCode: Number(res.statusCode) || 0,
          traceparent: event.node.req.headers['traceparent'],
          context: event.context,
        });
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      }
      store.ended = true;
      return originalEnd(...args);
    };

    return als.run(store, async () => {
      const fault = await handlerFault(store);
      if (fault?.kind === 'error') throw createError({ statusCode: fault.status, statusMessage: fault.message });
      if (fault?.kind === 'empty') {
        // Send the empty response ourselves: h3's toNodeListener ignores the
        // handler's return value, so returning '' here would never end the
        // node response and the probed request would hang until its timeout.
        res.statusCode = 200;
        res.end('');
        return '';
      }
      return originalHandler(event);
    });
  };

  // Data faults mutate the response body before it is serialized and sent.
  nitroApp.hooks.hook('beforeResponse', (event: any, response: { body?: unknown }) => {
    const store = event.context?._piwiStore as RequestStore | undefined;
    if (store && response && 'body' in response) response.body = faultedBody(store, response.body);
  });
}

/** `response` with `headers` added, copied when its headers cannot change. */
function withHeaders(response: Response, headers: Record<string, string>): Response {
  try {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
    return copy;
  }
}

/** `response` with a data fault applied to its JSON body; the response itself when the fault changes nothing. */
async function withFaultedBody(store: RequestStore, response: Response): Promise<Response> {
  if (!store.probeShouldApply || !store.probe || !isDataFault(store.probe.fault)) return response;
  if (!(response.headers.get('content-type') ?? '').includes('json')) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  const mutated = faultedBody(store, body);
  if (mutated === body) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(mutated), { status: response.status, statusText: response.statusText, headers });
}

/**
 * Nitro 3: wrap the app's `fetch`. Every request reaches the app through it, the
 * ones the server makes to itself while rendering a page included, so the
 * als.run() scope covers every hook, middleware and route handler, and the
 * headers go on the response the app built, an error response included.
 */
function installOnNitro3(nitroApp: Nitro3App, options: PiwiPluginOptions): void {
  const originalFetch = nitroApp.fetch;
  nitroApp.fetch = async (request: Request) => {
    const url = new URL(request.url, 'http://localhost');
    const method = request.method;
    // Serve the plugin's own routes while log capture is on (the plugin already returned early when it is off).
    const answer = await answerPiwiRoute(
      {
        method: method.toUpperCase(),
        path: url.pathname,
        query: url.searchParams,
        body: () => (request.body ?? []) as AsyncIterable<Uint8Array>,
      },
      options,
    );
    if (answer) {
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: answerHeaders(answer) });
    }

    const store = openRequestStore();
    const nested = store.parent !== undefined;
    // Nitro hands the request's context to the event as `event.context`.
    const withContext = request as Request & { context?: Record<string, unknown> };
    const context = (withContext.context ??= {});
    context._piwiLogs = store.logs;
    context._piwiSpans = store.spans;
    context._piwiStore = store;
    const probe = readProbe(store, request.headers.get('x-piwi-probe') ?? undefined, method, url.pathname);
    if (probe) context._piwiProbe = probe;

    return als.run(store, async () => {
      let response: Response;
      try {
        const fault = await handlerFault(store);
        if (fault?.kind === 'error') {
          response = new Response(JSON.stringify({ status: fault.status, message: fault.message }), {
            status: fault.status,
            headers: { 'Content-Type': 'application/json' },
          });
        } else if (fault?.kind === 'empty') {
          response = new Response('', { status: 200 });
        } else {
          response = await withFaultedBody(store, await originalFetch(request));
        }
      } catch (error) {
        store.ended = true;
        throw error;
      }

      const headers: Record<string, string> = piwiHeaders(store, {
        method,
        path: url.pathname,
        statusCode: response.status,
        traceparent: request.headers.get('traceparent') ?? undefined,
        context,
      });
      // Name the request's coverage on its response once instrumented code ran for it. A request the server makes to
      // itself is named by the outer one.
      const coverage = store.coverage;
      if (coverage && !nested) {
        const id = nameRequest(coverage);
        if (id) headers['X-Piwi-Coverage'] = id;
        const res = (request as { runtime?: { node?: { res?: { once(name: 'close', fn: () => void): unknown } } } })
          .runtime?.node?.res;
        if (res) res.once('close', () => settleRequest(coverage));
        else settleRequest(coverage);
      }
      store.ended = true;
      return withHeaders(response, headers);
    });
  };
}

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

/** The plugin, served as `export { default } from '@piwitests/instrumentation-nitro'` in a server plugin file. */
const piwiTestLogs: PiwiNitroPlugin = piwiPlugin();

export default piwiTestLogs;
