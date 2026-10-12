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
 *   pooled under a name the server derives from their bytes: the "after"
 *   screenshot of one action is usually the "before" of the next, and an
 *   unchanged page renders the same bytes run after run.
 *
 * A manifest without `pooledEntries` belongs to a blob whose slim ZIP holds its
 * screenshots and screencast frames itself.
 */
export interface TraceBlobManifest {
  resources: string[];
  /** Entry name → pool name. Has no prototype: read it with {@link pooledEntryPoolName}. */
  pooledEntries: Record<string, string>;
}

/** Archive entry prefixes pooled by content (see {@link TraceBlobManifest}). */
const POOLED_ENTRY_PREFIXES = ['screenshots/', 'screencast/'];

/**
 * Prefix of every pool name the server derives for a pooled entry. Names under
 * `resources/` come from the uploaded trace, so ingestion never pools one that
 * carries this prefix: a trace cannot plant bytes under a name another trace's
 * screenshot resolves to.
 */
const POOLED_NAME_PREFIX = 'pooled-';

/** Path of the manifest that sits next to a slim trace blob. */
export function traceManifestPath(blobPath: string): string {
  return blobPath.endsWith('.zip') ? blobPath.replace(/\.zip$/, '.manifest.json') : `${blobPath}.manifest.json`;
}

/** The `project-<id>` a stored trace's path starts with, which also prefixes its pool; null for any other path. */
export function traceProjectPrefix(path: string): string | null {
  return path.match(/^(project-\d+)\//)?.[1] ?? null;
}

/** Is this archive entry one that ingestion moves to the pool under a name derived from its bytes? */
export function isPooledTraceEntry(entryName: string): boolean {
  return POOLED_ENTRY_PREFIXES.some((prefix) => entryName.startsWith(prefix) && entryName.length > prefix.length);
}

/** Is this a name only the server gives, so a `resources/` entry must not take it? */
export function isReservedPoolName(name: string): boolean {
  return name.startsWith(POOLED_NAME_PREFIX);
}

/** The pool name of a pooled entry: `pooled-<sha256 of its bytes>.<the entry's extension>`. */
export function pooledTraceEntryName(entryName: string, data: Buffer): string {
  const sha256 = createHash('sha256').update(data).digest('hex');
  const ext = entryName.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
  return `${POOLED_NAME_PREFIX}${sha256}${ext ? `.${ext}` : ''}`;
}

/** The pool name a manifest gives an archive entry, or null when the entry is not pooled. */
export function pooledEntryPoolName(manifest: TraceBlobManifest, entryName: string): string | null {
  return Object.hasOwn(manifest.pooledEntries, entryName) ? manifest.pooledEntries[entryName]! : null;
}

/** Every pool name a manifest references, once each: what the blob's `trace_blob_resources` links must cover. */
export function traceManifestPoolNames(manifest: TraceBlobManifest): string[] {
  return [...new Set([...manifest.resources, ...Object.values(manifest.pooledEntries)])];
}

/**
 * Parse a stored manifest. Tolerates a manifest without `pooledEntries` and
 * drops any pool name that is not a single safe path segment, so a reader can
 * append every name it returns to the pool prefix.
 */
export function parseTraceManifest(raw: Buffer): TraceBlobManifest {
  const json = JSON.parse(raw.toString('utf8')) as { resources?: unknown; pooledEntries?: unknown };
  const resources = Array.isArray(json.resources)
    ? json.resources.map(String).filter((name) => safeStorageSegment(name))
    : [];
  // Keys are entry names a trace's own events look up: no inherited `constructor` or `__proto__`.
  const pooledEntries: Record<string, string> = Object.create(null);
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
