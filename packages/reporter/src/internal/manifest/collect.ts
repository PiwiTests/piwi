import * as fs from 'node:fs';
import * as path from 'node:path';
import { backendRequest } from '../transport/backend-request.js';

/**
 * Declared-surface manifest collection. Three ramps feed it: from the reporter's
 * global setup, a committed `piwi.manifest.json` next to the Playwright config and
 * the instrumentation package's `/__piwi/manifest` of each base URL whose first
 * response carries an instrumentation header; from the reporter, the manifest of
 * every other origin whose responses carried one during the run
 * (`run-manifests.ts`). All reduce to {@link ReporterManifest} and are uploaded to
 * the dashboard with their source.
 */

/** A declared route: method, pattern, optional handler file and documented codes. */
interface ReporterManifestRoute {
  method: string;
  pattern: string;
  handler?: string | null;
  responses?: number[];
}

/** A declared page: pattern and optional name. */
interface ReporterManifestPage {
  pattern: string;
  name?: string | null;
}

/** The declared surface: routes and pages. Mirrors the dashboard `AppManifest`. */
export interface ReporterManifest {
  routes?: ReporterManifestRoute[];
  pages?: ReporterManifestPage[];
}

/** The committed manifest file the reporter looks for next to the Playwright config. */
const COMMITTED_MANIFEST_FILE = 'piwi.manifest.json';

/** The instrumentation route-manifest path, served outside production. */
const INSTRUMENTATION_MANIFEST_PATH = '/__piwi/manifest';

/**
 * Response headers the instrumentation packages emit on every response, used as
 * the signal that the app under test is instrumented before fetching its manifest.
 */
const INSTRUMENTATION_HEADERS = ['x-piwi-logs', 'x-piwi-trace'];

/** Parse and validate a manifest JSON string into a {@link ReporterManifest}, or null. */
export function parseManifestJson(text: string): ReporterManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { routes?: unknown; pages?: unknown };
  const routes = Array.isArray(obj.routes)
    ? obj.routes
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .filter((r) => typeof r.method === 'string' && typeof r.pattern === 'string')
        .map((r) => ({
          method: r.method as string,
          pattern: r.pattern as string,
          handler: typeof r.handler === 'string' ? r.handler : undefined,
          responses: Array.isArray(r.responses)
            ? (r.responses as unknown[]).filter((c): c is number => Number.isInteger(c))
            : undefined,
        }))
    : undefined;
  const pages = Array.isArray(obj.pages)
    ? obj.pages
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .filter((p) => typeof p.pattern === 'string')
        .map((p) => ({ pattern: p.pattern as string, name: typeof p.name === 'string' ? p.name : undefined }))
    : undefined;
  if (!routes && !pages) return null;
  return { routes, pages };
}

/** True when a response's headers include an instrumentation marker. */
export function hasInstrumentationHeader(headers: Record<string, unknown> | Headers): boolean {
  const get = (name: string): unknown =>
    typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get(name)
      : (headers as Record<string, unknown>)[name];
  return INSTRUMENTATION_HEADERS.some((h) => get(h) != null && get(h) !== '');
}

/** Read and parse the committed `piwi.manifest.json` next to the config, or null. */
export function readCommittedManifest(configDir: string): ReporterManifest | null {
  const file = path.join(configDir, COMMITTED_MANIFEST_FILE);
  try {
    if (!fs.existsSync(file)) return null;
    return parseManifestJson(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** A fetch-shaped function, so the instrumentation fetch is testable without a server. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: Record<string, unknown> | Headers; text(): Promise<string> }>;

/** How long each instrumentation-manifest request may run before it is aborted. */
const INSTRUMENTATION_FETCH_TIMEOUT_MS = 5000;

/** Largest manifest read from an origin, in bytes. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * A {@link FetchLike} for the manifest of an origin the run reached: a GET on a
 * connection of its own that follows no redirect and reads at most
 * `MAX_MANIFEST_BYTES`; `insecure` accepts any certificate, as the run's browsers
 * do with `ignoreHTTPSErrors`.
 */
export function backendManifestFetch(insecure: boolean): FetchLike {
  return async (url, init) => {
    const answer = await backendRequest(url, {
      method: 'GET',
      insecure,
      signal: init?.signal ?? AbortSignal.timeout(INSTRUMENTATION_FETCH_TIMEOUT_MS),
      maxBytes: MAX_MANIFEST_BYTES,
    });
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      headers: answer.headers,
      text: async () => answer.text,
    };
  };
}

/**
 * Where the instrumentation manifest may be served: under the base URL's path
 * first, for an application mounted below the origin (`https://host/shop/` serves
 * `/shop/__piwi/manifest`, whose patterns carry the `/shop` prefix the tests see),
 * then at the origin root.
 */
export function instrumentationManifestUrls(baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const root = new URL(INSTRUMENTATION_MANIFEST_PATH, base).toString();
  const path = base.pathname.replace(/\/+$/, '');
  return path ? [new URL(`${path}${INSTRUMENTATION_MANIFEST_PATH}`, base).toString(), root] : [root];
}

/**
 * Fetch the instrumentation manifest from a base URL: probe the base URL once,
 * and only when its response carries an instrumentation header fetch and parse
 * `/__piwi/manifest`, under the base URL's path and then at the origin root; the
 * first response that parses as a manifest wins. Every request is bounded by a
 * timeout so the reporter never hangs a run on a slow or unresponsive base URL.
 * Best-effort — any failure (including a timeout) returns null.
 */
export async function fetchInstrumentationManifest(
  baseUrl: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ReporterManifest | null> {
  try {
    const probe = await fetchImpl(baseUrl, { signal: AbortSignal.timeout(INSTRUMENTATION_FETCH_TIMEOUT_MS) });
    if (!hasInstrumentationHeader(probe.headers)) return null;
    for (const manifestUrl of instrumentationManifestUrls(baseUrl)) {
      const manifest = await fetchManifestAt(manifestUrl, fetchImpl);
      if (manifest) return manifest;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the instrumentation manifest at the root of an origin the run's responses
 * already showed instrumented, so with no probe; bounded by the same timeout, and
 * by default through {@link backendManifestFetch}. Best-effort — any failure
 * returns null.
 */
export async function fetchOriginManifest(
  origin: string,
  fetchImpl: FetchLike = backendManifestFetch(false),
): Promise<ReporterManifest | null> {
  try {
    return await fetchManifestAt(new URL(INSTRUMENTATION_MANIFEST_PATH, origin).toString(), fetchImpl);
  } catch {
    return null;
  }
}

async function fetchManifestAt(manifestUrl: string, fetchImpl: FetchLike): Promise<ReporterManifest | null> {
  const res = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(INSTRUMENTATION_FETCH_TIMEOUT_MS) });
  return res.ok ? parseManifestJson(await res.text()) : null;
}
