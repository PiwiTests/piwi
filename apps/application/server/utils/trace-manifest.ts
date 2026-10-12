import { createHash } from 'crypto';
import type { StorageAdapter } from '../storage/types';
import { safeStorageSegment } from './sanitize-filename';

/**
 * The manifest stored next to a slim trace blob
 * (`project-<id>/blobs/<sha256>.manifest.json`): what the slim ZIP left out
 * because it lives in the project's shared pool (`project-<id>/trace-resources/`).
 *
 * - `resources` — the names of the trace's `resources/<name>` entries (network
 *   bodies, DOM snapshot assets), pooled under the name Playwright gave them,
 *   which is already their content hash.
 * - `pooledEntries` — the other entries moved to the pool, by archive entry
 *   name → pool name: the per-action screenshots (`screenshots/`) and the
 *   screencast frames (`screencast/`) of a Playwright 1.63+ trace. Their names
 *   say which action or instant they belong to, not what they hold, so they are
 *   pooled under their content hash: the "after" screenshot of one action is
 *   usually the "before" of the next, and an unchanged page renders the same
 *   bytes run after run.
 *
 * A blob written before `pooledEntries` existed has none; its screenshots and
 * screencast frames are still inside the slim ZIP.
 */
export interface TraceBlobManifest {
  resources: string[];
  pooledEntries: Record<string, string>;
}

/** Archive entry prefixes pooled by content hash (see {@link TraceBlobManifest}). */
const POOLED_ENTRY_PREFIXES = ['screenshots/', 'screencast/'];

/** Path of the manifest that sits next to a slim trace blob. */
export function traceManifestPath(blobPath: string): string {
  return blobPath.replace(/\.zip$/, '.manifest.json');
}

/** Is this archive entry one that ingestion moves to the pool under its content hash? */
export function isPooledTraceEntry(entryName: string): boolean {
  return POOLED_ENTRY_PREFIXES.some((prefix) => entryName.startsWith(prefix) && entryName.length > prefix.length);
}

/**
 * The pool name of a pooled entry: the SHA-1 of its bytes plus the entry's
 * extension (`<sha1>.png`), the same shape Playwright gives its own
 * `resources/` entries, so the pool holds one kind of name.
 */
export function pooledTraceEntryName(entryName: string, data: Buffer): string {
  const sha1 = createHash('sha1').update(data).digest('hex');
  const ext = entryName.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  return ext ? `${sha1}.${ext}` : sha1;
}

/** Every pool name a manifest references, once each: what the blob's `trace_blob_resources` links must cover. */
export function traceManifestPoolNames(manifest: TraceBlobManifest): string[] {
  return [...new Set([...manifest.resources, ...Object.values(manifest.pooledEntries)])];
}

/**
 * Parse a stored manifest. Tolerates the older shape (no `pooledEntries`) and
 * drops any pool name that is not a single safe path segment, so a reader can
 * append every name it returns to the pool prefix.
 */
export function parseTraceManifest(raw: Buffer): TraceBlobManifest {
  const json = JSON.parse(raw.toString('utf8')) as { resources?: unknown; pooledEntries?: unknown };
  const resources = Array.isArray(json.resources)
    ? json.resources.map(String).filter((name) => safeStorageSegment(name))
    : [];
  const pooledEntries: Record<string, string> = {};
  if (json.pooledEntries && typeof json.pooledEntries === 'object' && !Array.isArray(json.pooledEntries)) {
    for (const [entryName, poolName] of Object.entries(json.pooledEntries as Record<string, unknown>)) {
      if (typeof poolName === 'string' && safeStorageSegment(poolName)) pooledEntries[entryName] = poolName;
    }
  }
  return { resources, pooledEntries };
}

/**
 * The manifest of a slim trace blob, or null when there is none or it cannot be
 * read. For readers only: anything that decides what may be deleted must tell
 * "no manifest" from "unreadable" and read it itself.
 */
export async function readTraceManifest(storage: StorageAdapter, blobPath: string): Promise<TraceBlobManifest | null> {
  if (!blobPath.endsWith('.zip')) return null;
  try {
    return parseTraceManifest(await storage.readFile(traceManifestPath(blobPath)));
  } catch {
    return null;
  }
}
