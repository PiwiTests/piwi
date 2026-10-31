/**
 * Turn an OpenAPI document into a declared-surface {@link AppManifest}: one route
 * per path × method, carrying the documented response status codes. Pure and
 * dependency-free so the demo and the unit tests run it directly; the server util
 * fetches the document and hands the parsed JSON here.
 */

import type { AppManifest, ManifestRoute } from '#shared/types';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

/**
 * Cap on declared routes taken from one OpenAPI document, so a spec with thousands
 * of operations cannot mint an unbounded number of graph nodes. When the document
 * has more, the manifest carries the first {@link MAX_OPENAPI_ROUTES} and the
 * server logs that it was capped.
 */
export const MAX_OPENAPI_ROUTES = 2000;

/** Response keys are status codes or ranges (`2XX`) or `default`; keep the numeric ones. */
function documentedCodes(responses: unknown): number[] {
  if (!responses || typeof responses !== 'object') return [];
  const out = new Set<number>();
  for (const key of Object.keys(responses as Record<string, unknown>)) {
    const code = Number.parseInt(key, 10);
    if (Number.isInteger(code) && code >= 100 && code <= 599) out.add(code);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The path every route of a document is served under: the path of its first
 * server's URL (OpenAPI 3, its variables filled with their defaults) or its
 * `basePath` (Swagger 2), without a trailing slash; empty when it names none,
 * or a variable has no default.
 */
export function openApiBasePath(spec: unknown): string {
  const doc = spec as {
    servers?: Array<{ url?: unknown; variables?: Record<string, { default?: unknown }> }>;
    basePath?: unknown;
  } | null;
  let raw: string | null = null;
  const server = Array.isArray(doc?.servers) ? doc.servers[0] : undefined;
  if (server && typeof server.url === 'string') {
    // Only the path counts: the scheme and host go first, with any variable in them.
    raw = server.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/\{([^}]+)\}/g, (whole, name: string) => {
      const value = server.variables?.[name]?.default;
      return typeof value === 'string' ? value : whole;
    });
  } else if (typeof doc?.basePath === 'string') {
    raw = doc.basePath;
  }
  if (!raw || raw.includes('{')) return '';
  let path: string;
  try {
    path = new URL(raw, 'http://base.invalid').pathname;
  } catch {
    return '';
  }
  return path.replace(/\/+$/, '');
}

/**
 * Parse an OpenAPI 3.x (or Swagger 2) document into a manifest, each path
 * under the document's base path. Malformed input yields an empty manifest
 * rather than throwing — a broken spec must never break ingest.
 */
export function parseOpenApiSpec(spec: unknown): AppManifest {
  const routes: ManifestRoute[] = [];
  const paths = (spec as { paths?: unknown } | null)?.paths;
  if (!paths || typeof paths !== 'object') return { routes: [] };
  const base = openApiBasePath(spec);
  outer: for (const [path, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pattern = `${base}${path}`;
    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const responses = (operation as { responses?: unknown } | null)?.responses;
      routes.push({ method: method.toUpperCase(), pattern, responses: documentedCodes(responses) });
      // Stop at the cap so a huge spec cannot mint unbounded graph nodes.
      if (routes.length >= MAX_OPENAPI_ROUTES) break outer;
    }
  }
  return { routes };
}
