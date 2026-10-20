/**
 * A project's OpenAPI URL as declared surface: fetch the document through the
 * SSRF guard, parse it into a manifest and ingest it with
 * {@link ingestProjectManifest}. Server only: it makes the outbound request.
 */

import { safeFetch } from './safe-fetch';
import { ingestProjectManifest } from './surface-manifest';
import { parseOpenApiSpec, MAX_OPENAPI_ROUTES } from '#shared/openapi';
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

/** Fetch a project's OpenAPI URL and ingest it as declared surface. No-op when unset. */
export async function refreshOpenApiSurface(
  db: DrizzleDB,
  projectId: number,
  openApiUrl: string | null,
): Promise<boolean> {
  if (!openApiUrl?.trim()) return false;
  const manifest = await fetchOpenApiManifest(openApiUrl.trim());
  if (!manifest) return false;
  return ingestProjectManifest(db, projectId, manifest, 'openapi');
}
