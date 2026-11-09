/**
 * A project's OpenAPI URL as declared surface: fetch the document through the
 * SSRF guard, parse it into a manifest and ingest it with
 * {@link ingestProjectManifest}. Server only: it makes the outbound request.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { graphNodes } from '../database/schema';
import { safeFetch } from './safe-fetch';
import { ingestProjectManifest } from './surface-manifest';
import { parseOpenApiSpec, MAX_OPENAPI_ROUTES } from '#shared/openapi';
import { buildManifestGraph } from '#shared/graph';
import type { AppManifest } from '#shared/types';
import type { DrizzleDB } from '#shared/handlers/db';

/** Cap on the OpenAPI document body we will read, and how long we wait for it. */
const OPENAPI_MAX_BYTES = 5_000_000;
const OPENAPI_FETCH_TIMEOUT_MS = 10_000;

/**
 * Read a response body up to `maxBytes`, returning null when it overruns. Reads
 * the stream in chunks and aborts past the cap so a lying `content-length` (or
 * none at all) cannot buffer an unbounded body into memory.
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!res.body) {
    const text = await res.text();
    return text.length > maxBytes ? null : text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetch and parse an OpenAPI document into a manifest. The admin-supplied URL
 * goes through the SSRF guard (`safeFetch` validates the target and every
 * redirect hop against `assertPublicHttpUrl`) and the body is read under a size
 * cap. Best-effort: a blocked host, a network failure, a non-2xx response, an
 * oversized body or unparseable JSON all return null rather than throwing, so a
 * declared-surface refresh never breaks ingest.
 */
export async function fetchOpenApiManifest(url: string): Promise<AppManifest | null> {
  try {
    const res = await safeFetch(url, { headers: { Accept: 'application/json' } }, 3, OPENAPI_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const text = await readBoundedText(res, OPENAPI_MAX_BYTES);
    if (text == null) return null;
    const manifest = parseOpenApiSpec(JSON.parse(text));
    if ((manifest.routes?.length ?? 0) >= MAX_OPENAPI_ROUTES) {
      console.warn(
        `[surface-manifest] OpenAPI document capped at ${MAX_OPENAPI_ROUTES} routes; remaining operations were dropped`,
      );
    }
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Fetch a project's OpenAPI URL and ingest it as declared surface, the routes
 * an earlier document declared and this one does not included
 * ({@link undeclareOpenApiRoutes}). No-op when unset or unreadable.
 */
export async function refreshOpenApiSurface(
  db: DrizzleDB,
  projectId: number,
  openApiUrl: string | null,
): Promise<boolean> {
  if (!openApiUrl?.trim()) return false;
  const manifest = await fetchOpenApiManifest(openApiUrl.trim());
  if (!manifest) return false;
  if (!(await ingestProjectManifest(db, projectId, manifest, 'openapi'))) return false;
  await undeclareOpenApiRoutes(db, projectId, manifest);
  return true;
}

/**
 * Stop reading as declared the canonical nodes an OpenAPI document declared
 * that `manifest` does not (every one of them when `manifest` is null, the URL
 * cleared): each becomes an observed node without its declared attributes, so
 * its *declared, never hit* gap closes on the next recompute and a node no test
 * reaches retires as any unseen node does. Returns how many changed.
 */
export async function undeclareOpenApiRoutes(
  db: DrizzleDB,
  projectId: number,
  manifest: AppManifest | null,
): Promise<number> {
  const declared = new Set(
    manifest ? buildManifestGraph(manifest, 'openapi').nodes.map((n) => `${n.kind}\x00${n.key}`) : [],
  );
  const rows = await db
    .select({ id: graphNodes.id, kind: graphNodes.kind, key: graphNodes.key, attrs: graphNodes.attrs })
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), isNull(graphNodes.branch), eq(graphNodes.origin, 'openapi')));
  const stale = rows.filter((r) => !declared.has(`${r.kind}\x00${r.key}`));
  for (const row of stale) {
    const {
      declared: _declared,
      responses: _responses,
      patterns: _patterns,
      ...rest
    } = (row.attrs ?? {}) as Record<string, unknown>;
    await db
      .update(graphNodes)
      .set({ origin: 'observed', attrs: Object.keys(rest).length > 0 ? rest : null })
      .where(eq(graphNodes.id, row.id));
  }
  return stale.length;
}
