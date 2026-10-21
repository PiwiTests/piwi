/**
 * Route interception shared by probe mode and flake mode: one `page.route`
 * handler walks a list of rules, each a matcher over route keys, which of the
 * matching requests it acts on (every one, or the Nth after the first
 * navigation), and a handler that performs the action. A probe installs one
 * rule that applies its fault; a flake arm installs one rule per `delay` or
 * `fail` condition. Thin over the pure helpers in `faults.ts` and `plan.ts`.
 */

import { gunzipSync } from 'node:zlib';
import type { Page, Route } from '@playwright/test';
import { PIWI_PROBE_ENV } from '../config/env.js';
import { computeFault, faultRouteAction, isFaultAllowed, type ProbeFault, type RouteAction } from './faults.js';
import {
  createProbeState,
  markNavigated,
  requestMatchesRoute,
  shouldAct,
  type ProbePlanItem,
  type ProbeState,
} from './plan.js';
import { buildProbeHeader, type ServerProbeSpec } from './sign.js';

/** Handle to the interception, read at teardown to record the probe outcome. */
export interface ProbeInterception {
  /** Whether the fault actually took effect (server: the trace named the asked-for fault). */
  applied: () => boolean;
  /** The fault the server reported it applied (server probes), or null. */
  appliedFault: () => string | null;
  /** A backend error was recorded while the fault was applied (5xx / error root span). */
  serverError: () => boolean;
}

/** What a server response's `X-Piwi-Trace` header tells the probe about one request. */
export interface ProbeTraceInfo {
  /** The fault the instrumentation stamped on the root span, or null when none. */
  appliedFault: string | null;
  /** The request ended in a backend error (root span `error`, or a 5xx status). */
  serverError: boolean;
}

/**
 * Read a server response's `X-Piwi-Trace` header: the fault the instrumentation
 * reported it applied (root span `piwi.probe.applied`) and whether the request
 * ended in a backend error. A signed request the server ignored (probes off,
 * wrong secret, route mismatch, or a package that emits no trace) carries no
 * applied marker, so the probe records inconclusive rather than a false gap.
 */
export function parseProbeTrace(traceHeader: string | undefined): ProbeTraceInfo {
  const none: ProbeTraceInfo = { appliedFault: null, serverError: false };
  if (!traceHeader) return none;
  try {
    const spans = JSON.parse(gunzipSync(Buffer.from(traceHeader, 'base64')).toString('utf8'));
    if (!Array.isArray(spans)) return none;
    const root = spans.find((s) => s && typeof s === 'object' && !s.parentId);
    if (!root) return none;
    const attrs = (root.attrs ?? {}) as Record<string, unknown>;
    const appliedRaw = attrs['piwi.probe.applied'];
    const status = Number(attrs['http.status_code']) || 0;
    return {
      appliedFault: appliedRaw != null ? String(appliedRaw) : null,
      serverError: root.status === 'error' || status >= 500,
    };
  } catch {
    return none;
  }
}

/**
 * The headers to fulfill a mutated response with: the real response's headers,
 * so `Set-Cookie`, `Location` and the rest survive, minus the framing headers
 * (`content-length` / `content-encoding` — the body was already decoded and
 * Playwright recomputes the length), with the fault's content type applied when
 * it set one.
 */
export function fulfillHeaders(
  responseHeaders: Record<string, string>,
  contentType: string | null | undefined,
): Record<string, string> {
  const headers = { ...responseHeaders };
  delete headers['content-length'];
  delete headers['content-encoding'];
  if (contentType) headers['content-type'] = contentType;
  return headers;
}

/** The origin of a URL, or null when it cannot be parsed or is opaque (`about:blank`). */
function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
}

/** One interception rule: which requests it targets and what it does to them. */
export interface RouteRule {
  /** Whether a request's method and URL are ones this rule targets. */
  matches: (method: string, url: string) => boolean;
  /** Act on every matching request after the first navigation, or only on the Nth. */
  match: 'all' | number;
  /**
   * Handle one targeted request; it must fulfill, abort or fall back the route.
   * `startedAt` is when the page issued the request (epoch ms).
   */
  handle: (route: Route, startedAt: number) => Promise<void>;
  /** True once the rule stops looking at requests (a one-shot fault that applied). */
  done?: () => boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Perform a route action on one request. A `delay` fetches the real response,
 * waits until `ms` after `startedAt`, then fulfills with it unchanged.
 */
export async function performRouteAction(route: Route, action: RouteAction, startedAt: number): Promise<void> {
  switch (action.kind) {
    case 'abort':
      await route.abort('connectionreset');
      return;
    case 'status':
      await route.fulfill({ status: action.status, body: '' });
      return;
    case 'delay': {
      const response = await route.fetch();
      await sleep(startedAt + action.ms - Date.now());
      await route.fulfill({ response });
      return;
    }
  }
}

/**
 * Install a list of rules on a page. Requests before the first main-frame
 * navigation (seeding) are never touched; each request goes to the first rule
 * that targets it, and falls through untouched when none does. Each rule keeps
 * its own match count.
 */
export async function installRouteRules(page: Page, rules: RouteRule[]): Promise<{ state: ProbeState[] }> {
  const state = rules.map(() => createProbeState());
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) for (const s of state) markNavigated(s);
  });
  await page.route('**/*', async (route) => {
    const startedAt = Date.now();
    const request = route.request();
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!;
      if (rule.done?.() || !rule.matches(request.method(), request.url())) continue;
      if (!shouldAct(state[i]!, rule.match)) continue;
      await rule.handle(route, startedAt);
      return;
    }
    await route.fallback();
  });
  return { state };
}

/**
 * Install the fault interception for one plan item on a page. Requests before the
 * first navigation (seeding) are never touched; the fault is applied to the Nth
 * matching request exactly once, by fetching the real response and fulfilling
 * with the mutation.
 */
export async function installProbeInterception(page: Page, item: ProbePlanItem): Promise<ProbeInterception> {
  // Refuse a plan item whose fault is not one this reporter knows how to apply
  // at its level, independently of the server-side planner's allow-list.
  if (!isFaultAllowed(item.level ?? 'client', item.fault)) {
    return { applied: () => false, appliedFault: () => null, serverError: () => false };
  }

  let applied = false;
  let appliedFault: string | null = null;
  let serverError = false;
  // The application's own origin, learned on the first main-frame navigation. A
  // signed probe header is attached only to a request on this origin, so a
  // request to a third-party host that happens to share the route path never
  // receives the reporter's HMAC-signed header.
  let appOrigin: string | null = null;
  const probeSecret = process.env[PIWI_PROBE_ENV.secret];

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      const origin = originOf(page.url());
      if (origin) appOrigin = origin;
    }
  });

  const handle = async (route: Route, startedAt: number): Promise<void> => {
    const request = route.request();

    // A server fault is signed onto the request and applied inside the server;
    // the response is left alone. Without a shared secret it cannot be signed, so
    // the request goes through unmodified and the probe records inconclusive. The
    // fault counts as applied only when the trace names the same fault class we
    // asked for — a request the server ignored or applied differently records
    // inconclusive, never a false gap.
    if (item.level === 'server') {
      if (!probeSecret || (appOrigin !== null && originOf(request.url()) !== appOrigin)) {
        await route.fallback();
        return;
      }
      const spec: ServerProbeSpec = { route: item.routeKey, fault: item.fault, nth: item.nth };
      if (item.dependency) spec.dependency = item.dependency;
      try {
        const response = await route.fetch({
          headers: { ...request.headers(), 'x-piwi-probe': buildProbeHeader(probeSecret, spec) },
        });
        const trace = parseProbeTrace(response.headers()['x-piwi-trace']);
        appliedFault = trace.appliedFault;
        serverError = trace.serverError;
        applied = trace.appliedFault != null && trace.appliedFault.split(':', 1)[0] === item.fault;
        await route.fulfill({ response });
      } catch {
        applied = false;
        await route.fallback();
      }
      return;
    }

    try {
      // A fault that maps to a route action (`slow` is a delay) always changes
      // what the page sees. Marked applied before the action runs, so a delay
      // that times the test out is still recorded as applied, not inconclusive.
      const action = faultRouteAction(item.fault);
      if (action) {
        applied = true;
        appliedFault = item.fault;
        await performRouteAction(route, action, startedAt);
        return;
      }
      const response = await route.fetch();
      const body = await response.text();
      const out = computeFault(item.fault as ProbeFault, {
        status: response.status(),
        body,
        contentType: response.headers()['content-type'] ?? null,
      });
      // A fault counts as applied only when it actually changes what the page
      // sees (`out.changed`): a mutated status or body. A no-op (a `stale-value`
      // with no prior body to replay, a `drop-field` on a non-JSON body) records
      // as not applied, so an unnoticed no-op never reads as a scenario gap.
      applied = out.changed;
      if (applied) appliedFault = item.fault;
      const headers = fulfillHeaders(response.headers(), out.contentType);
      await route.fulfill({ status: out.status, body: out.body, headers });
    } catch {
      // A fetch or fulfill failure must not wedge the test — let the real
      // request through, recorded as not applied.
      applied = false;
      await route.fallback();
    }
  };

  await installRouteRules(page, [
    {
      matches: (method, url) => requestMatchesRoute(method, url, item.routeKey),
      match: Math.max(1, item.nth ?? 1),
      handle,
      done: () => applied,
    },
  ]);

  return { applied: () => applied, appliedFault: () => appliedFault, serverError: () => serverError };
}
