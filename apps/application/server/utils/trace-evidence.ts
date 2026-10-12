/**
 * Node-only glue for the trace-derived evidence views (full call stack, full
 * network trace, body previews): storage access, ZIP inflation and the
 * resource reader over the deduplicated pool. The pure parsing/building lives
 * in the node-free `trace-insights.ts` (shared with the browser demo). No
 * re-exports: Nitro auto-imports every server/utils export.
 */
import { and, eq } from 'drizzle-orm';
import { files } from '../database/schema';
import { getStorage } from '../storage';
import { ariaJsonToText } from '#shared/aria-json';
import {
  parseZipDirectory,
  decompressEntry,
  decompressEntrySync,
  decompressTextEntries,
  type ZipEntryMeta,
} from './trace-zip';
import { decodeResource } from './resource-compression';
import {
  pageActionOf,
  parseResourceSnapshots,
  parseTraceTexts,
  traceFileRank,
  type ParsedTraceData,
  type TraceResource,
} from './trace-events';
import {
  buildActionCallsites,
  buildTraceBodyPreview,
  buildTraceCallStack,
  buildTraceNetwork,
  buildTraceSnapshots,
  matchNetworkBodySha1,
  parseNetworkTexts,
  parseStacksTexts,
  resolveSnapshotFile,
  type ActionCallsite,
  type TraceResourceReader,
  type TraceResourceSnapshot,
  type TraceStacksIndex,
} from './trace-insights';
import type { DbClient } from '../database';
import type {
  TraceBodyResponse,
  TraceCallStackResponse,
  TraceNetworkResponse,
  TraceSnapshotsResponse,
} from '../../types/api';
import { safeStorageSegment } from './sanitize-filename';
import { pooledEntryPoolName, readTraceManifest, traceProjectPrefix, type TraceBlobManifest } from './trace-manifest';

/** Path of the execution's stored (slim) trace blob, or null when no trace was uploaded. */
export async function resolveCaseTraceBlobPath(db: DbClient, testRunsCaseId: number): Promise<string | null> {
  const traceFiles = await db
    .select({ path: files.path })
    .from(files)
    .where(and(eq(files.testRunsCaseId, testRunsCaseId), eq(files.type, 'trace')))
    .limit(1);
  return traceFiles[0]?.path || null;
}

interface TraceBundle {
  parsed: ParsedTraceData | null;
  stacks: TraceStacksIndex | null;
  network: TraceResourceSnapshot[];
  /** Every resource URL the `.network` stream captured → its stored body, for the DOM snapshot's assets. */
  resourcesByUrl: Map<string, TraceResource>;
  /** The `aria/*` and `screenshots/*` entries the archive holds, still compressed. */
  snapshotEntries: Map<string, PackedEntry>;
  readResource: TraceResourceReader;
  /** A screenshot the slim blob left in the project pool, by its entry name; null when there is none. */
  readPooledEntry: (entryName: string) => Promise<Buffer | null>;
  /** About how much memory the bundle holds: its parsed streams and the entries it keeps compressed. */
  retainedBytes: number;
  /** The snapshot inventory and page diff, once a view has built them. */
  snapshotView?: TraceSnapshotsResponse;
}

/** One ZIP entry kept compressed, detached from its archive, until a view asks for it. */
interface PackedEntry {
  meta: ZipEntryMeta;
  data: Buffer;
}

/** A stored trace's bytes and entry directory, or null when it cannot be read. */
async function readTraceArchive(blobPath: string): Promise<{ zip: Buffer; metas: ZipEntryMeta[] } | null> {
  try {
    const zip = await getStorage().readFile(blobPath);
    return { zip, metas: parseZipDirectory(zip) };
  } catch {
    return null;
  }
}

/** The `.trace` entries, in the order their events are read. */
function traceEventEntries(metas: ZipEntryMeta[]): ZipEntryMeta[] {
  return metas.filter((m) => m.name.endsWith('.trace')).sort((a, b) => traceFileRank(a.name) - traceFileRank(b.name));
}

/**
 * Copy the compressed bytes of the entries `keyOf` names out of the archive,
 * keyed by the name it returns. The copies are all a bundle keeps of the
 * archive; no closure that outlives a load may capture the archive itself, or
 * all of it stays in memory with the bundle.
 */
function packEntries(
  zip: Buffer,
  metas: ZipEntryMeta[],
  keyOf: (name: string) => string | null,
): Map<string, PackedEntry> {
  const packed = new Map<string, PackedEntry>();
  for (const meta of metas) {
    const key = keyOf(meta.name);
    if (key === null) continue;
    const data = Buffer.from(zip.subarray(meta.dataStart, meta.dataStart + meta.compressedSize));
    packed.set(key, { meta: { ...meta, dataStart: 0 }, data });
  }
  return packed;
}

/**
 * The manifest of a slim blob, read once when a view first needs something it
 * lists. The views of one page ask at the same time and share that read; one
 * that finds no manifest is tried again by the next request.
 */
function lazyTraceManifest(blobPath: string): () => Promise<TraceBlobManifest | null> {
  let pending: Promise<TraceBlobManifest | null> | null = null;
  return () => {
    pending ??= readTraceManifest(getStorage(), blobPath).then((manifest) => {
      if (!manifest) pending = null;
      return manifest;
    });
    return pending;
  };
}

/** One file of the project pool, decoded; null when the name is unsafe or the file cannot be read. */
async function readPoolFile(projectPrefix: string, name: string): Promise<Buffer | null> {
  // Names come from the uploaded trace: only a single path segment may address the pool.
  if (!safeStorageSegment(name)) return null;
  try {
    return decodeResource(await getStorage().readFile(`${projectPrefix}/trace-resources/${name}`));
  } catch {
    return null;
  }
}

/**
 * The resource reader of a stored trace: a legacy/fallback full ZIP keeps its
 * `resources/` inline; a slim blob's live in the project pool its manifest
 * lists.
 */
function traceResourceReader(
  blobPath: string,
  inlineResources: Map<string, PackedEntry>,
  manifest: () => Promise<TraceBlobManifest | null>,
): TraceResourceReader {
  const projectPrefix = traceProjectPrefix(blobPath);
  return async (name) => {
    for (const candidate of resourceNameCandidates(name, inlineResources.keys())) {
      const entry = inlineResources.get(candidate);
      if (!entry) continue;
      try {
        return await decompressEntry(entry.data, entry.meta);
      } catch {
        // Try the next candidate.
      }
    }
    if (!projectPrefix) return null;
    // Without a manifest only exact-shaped probes are possible.
    for (const candidate of resourceNameCandidates(name, (await manifest())?.resources ?? [])) {
      const bytes = await readPoolFile(projectPrefix, candidate);
      if (bytes) return bytes;
    }
    return null;
  };
}

/** The reader of the screenshots a slim blob moved to the project pool, by entry name. */
function pooledEntryReader(
  blobPath: string,
  manifest: () => Promise<TraceBlobManifest | null>,
): (entryName: string) => Promise<Buffer | null> {
  const projectPrefix = traceProjectPrefix(blobPath);
  return async (entryName) => {
    if (!projectPrefix) return null;
    const loaded = await manifest();
    const poolName = loaded ? pooledEntryPoolName(loaded, entryName) : null;
    return poolName ? readPoolFile(projectPrefix, poolName) : null;
  };
}

/**
 * Load a stored trace and split its streams once. Handles both layouts: the
 * slim blob (what its sibling manifest lists lives in the project pool) and a
 * full ZIP stored as is (everything inline).
 *
 * Only the event streams (`.trace`, `.stacks`, `.network`) are inflated. The
 * aria snapshots, and any screenshots the archive holds, stay compressed until
 * a view reads one; a screencast in the archive, which no view reads, is
 * dropped with it.
 */
async function readTraceBundle(blobPath: string): Promise<TraceBundle | null> {
  const archive = await readTraceArchive(blobPath);
  if (!archive) return null;
  const { zip, metas } = archive;

  const traceTexts = await decompressTextEntries(zip, traceEventEntries(metas));
  const stacksTexts = await decompressTextEntries(
    zip,
    metas.filter((m) => m.name.endsWith('.stacks')),
  );
  const networkTexts = await decompressTextEntries(
    zip,
    metas.filter((m) => m.name.endsWith('.network')),
  );
  // 1.63 aria snapshots sit at their own top-level prefix in the slim ZIP, read
  // by their trace-relative path; so do the screenshots of an archive whose
  // manifest lists no pooled entries (`readPooledEntry` serves the others).
  const snapshotEntries = packEntries(zip, metas, (name) =>
    name.startsWith('aria/') || name.startsWith('screenshots/') ? name : null,
  );
  const inlineResources = packEntries(zip, metas, (name) =>
    name.startsWith('resources/') ? name.slice('resources/'.length) : null,
  );

  const packedBytes = [...snapshotEntries.values(), ...inlineResources.values()].reduce(
    (sum, e) => sum + e.data.length,
    0,
  );
  const textBytes = [...traceTexts, ...stacksTexts, ...networkTexts].reduce((sum, t) => sum + t.length, 0);
  const manifest = lazyTraceManifest(blobPath);
  return {
    parsed: traceTexts.length > 0 ? parseTraceTexts(traceTexts) : null,
    stacks: stacksTexts.length > 0 ? parseStacksTexts(stacksTexts) : null,
    network: networkTexts.length > 0 ? parseNetworkTexts(networkTexts) : [],
    resourcesByUrl: parseResourceSnapshots(networkTexts),
    snapshotEntries,
    readResource: traceResourceReader(blobPath, inlineResources, manifest),
    readPooledEntry: pooledEntryReader(blobPath, manifest),
    // The parsed events take a few times their text in memory.
    retainedBytes: packedBytes + 3 * textBytes,
  };
}

/** A content-addressed blob (`project-<id>/blobs/<sha256>.zip`): its bytes never change. */
const CONTENT_ADDRESSED_BLOB = /^project-\d+\/blobs\/[0-9a-f]{64}\.zip$/i;

/** How long a loaded trace stays in memory after its last read. */
const BUNDLE_IDLE_MS = 2 * 60_000;

/** Upper bound on what the loaded traces hold in memory together; the one loaded last is always kept. */
const BUNDLE_BUDGET_BYTES = 64 * 1024 * 1024;

interface CachedBundle {
  bundle: Promise<TraceBundle | null>;
  /** What the loaded bundle holds; null while it loads. */
  bytes: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Loaded traces by blob path, least recently read first. */
const bundleCache = new Map<string, CachedBundle>();

function forgetBundle(blobPath: string, cached: CachedBundle): void {
  if (bundleCache.get(blobPath) !== cached) return;
  if (cached.timer) clearTimeout(cached.timer);
  bundleCache.delete(blobPath);
}

function expireLater(blobPath: string, cached: CachedBundle): void {
  if (cached.timer) clearTimeout(cached.timer);
  cached.timer = setTimeout(() => forgetBundle(blobPath, cached), BUNDLE_IDLE_MS);
  cached.timer.unref?.();
}

/** Drop the least recently read traces until the loaded ones fit the budget, keeping `newest`. */
function evictOverBudget(newest: string): void {
  let total = [...bundleCache.values()].reduce((sum, c) => sum + (c.bytes ?? 0), 0);
  for (const [path, cached] of bundleCache) {
    if (total <= BUNDLE_BUDGET_BYTES) break;
    // One still loading frees nothing yet, and dropping it splits the requests waiting on it.
    if (path === newest || cached.bytes === null) continue;
    forgetBundle(path, cached);
    total -= cached.bytes;
  }
}

/**
 * A stored trace, read and parsed once for every view that asks for it. One
 * failed execution's page opens the timeline, the call stack, the snapshot list,
 * each filmstrip image and the network list at once, and each of them reads the
 * same trace: a content-addressed blob is loaded once, shared by the requests
 * in flight, and kept briefly for the next one. Any other path is read afresh.
 */
async function loadTraceBundle(blobPath: string): Promise<TraceBundle | null> {
  if (!CONTENT_ADDRESSED_BLOB.test(blobPath)) return readTraceBundle(blobPath);

  const hit = bundleCache.get(blobPath);
  if (hit) {
    bundleCache.delete(blobPath);
    bundleCache.set(blobPath, hit);
    expireLater(blobPath, hit);
    return hit.bundle;
  }

  const cached: CachedBundle = { bundle: readTraceBundle(blobPath), bytes: null, timer: null };
  bundleCache.set(blobPath, cached);
  expireLater(blobPath, cached);
  let bundle: TraceBundle | null;
  try {
    bundle = await cached.bundle;
  } catch (error) {
    forgetBundle(blobPath, cached);
    throw error;
  }
  if (!bundle) {
    // A read that failed (storage unreachable, not a ZIP) is retried by the next request.
    forgetBundle(blobPath, cached);
  } else if (bundleCache.get(blobPath) === cached) {
    cached.bytes = bundle.retainedBytes;
    evictOverBudget(blobPath);
  }
  return bundle;
}

/**
 * The parsed event stream of a stored trace and the bodies its network stream
 * captured, through the views' shared loader: the DOM snapshot renders the
 * frame snapshots and inlines those bodies, the AI context reads the actions.
 */
export async function loadStoredTraceEvents(
  blobPath: string,
): Promise<{ parsed: ParsedTraceData; resourcesByUrl: Map<string, TraceResource> } | null> {
  const bundle = await loadTraceBundle(blobPath);
  return bundle?.parsed ? { parsed: bundle.parsed, resourcesByUrl: bundle.resourcesByUrl } : null;
}

/**
 * Resolve the stored spellings a resource may have: exact, and — because a body
 * ref (`_sha1` in v8 traces, `_file` in v9, already stripped of its `resources/`
 * prefix by `matchNetworkBodySha1`) sometimes includes the file extension and
 * sometimes not — the bare-hash / extension-bearing variants from a known-names
 * listing.
 */
function resourceNameCandidates(requested: string, knownNames: Iterable<string>): string[] {
  const candidates = [requested];
  const bare = requested.split('.')[0]!;
  if (bare !== requested) candidates.push(bare);
  for (const known of knownNames) {
    if (known !== requested && known.split('.')[0] === bare) candidates.push(known);
  }
  return [...new Set(candidates)];
}

/** The parsed event stream and raw network snapshots of a stored trace, for deriving fallback evidence. */
export interface TraceEvidenceStreams {
  parsed: ParsedTraceData | null;
  network: TraceResourceSnapshot[];
}

/**
 * Load a stored trace and return just its event stream and network snapshots —
 * the two inputs the fallback derivation reads to recover console entries and
 * the request list when the capture fixtures were absent.
 *
 * Ingestion reads each trace once, so this is a fresh read that the views never
 * share, and only the `.trace` and `.network` entries are inflated.
 */
export async function loadTraceEvidenceStreams(blobPath: string): Promise<TraceEvidenceStreams | null> {
  const archive = await readTraceArchive(blobPath);
  if (!archive) return null;
  const traceTexts = await decompressTextEntries(archive.zip, traceEventEntries(archive.metas));
  const networkTexts = await decompressTextEntries(
    archive.zip,
    archive.metas.filter((m) => m.name.endsWith('.network')),
  );
  return {
    parsed: traceTexts.length > 0 ? parseTraceTexts(traceTexts) : null,
    network: networkTexts.length > 0 ? parseNetworkTexts(networkTexts) : [],
  };
}

/** Full call stack of the failing action, with embedded source when the trace carries it. */
export async function getTraceCallStackFromBlob(
  blobPath: string,
  knownTestFilePath: string | null,
): Promise<TraceCallStackResponse> {
  const bundle = await loadTraceBundle(blobPath);
  if (!bundle || !bundle.parsed) return { status: 'no-trace' };
  return buildTraceCallStack(bundle.parsed, bundle.stacks, bundle.readResource, { knownTestFilePath });
}

/** Per-action call sites (lightweight display frames) for the failure timeline. */
export async function getTraceActionCallsitesFromBlob(
  blobPath: string,
  knownTestFilePath: string | null,
): Promise<ActionCallsite[]> {
  const bundle = await loadTraceBundle(blobPath);
  if (!bundle || !bundle.parsed) return [];
  return buildActionCallsites(bundle.parsed, bundle.stacks, { knownTestFilePath });
}

/** Full network activity from the trace's HAR-like stream. */
export async function getTraceNetworkFromBlob(blobPath: string): Promise<TraceNetworkResponse> {
  const bundle = await loadTraceBundle(blobPath);
  if (!bundle) return { status: 'no-trace' };
  return buildTraceNetwork(bundle.parsed, bundle.network);
}

/** One body resource referenced by the trace's network stream, classified for preview. */
export async function getTraceNetworkBodyFromBlob(blobPath: string, requestedSha1: string): Promise<TraceBodyResponse> {
  const bundle = await loadTraceBundle(blobPath);
  if (!bundle) return { status: 'not-found' };
  const match = matchNetworkBodySha1(bundle.network, requestedSha1);
  if (!match) return { status: 'not-found' };
  const bytes = await bundle.readResource(match.name);
  if (!bytes) return { status: 'not-found' };
  return buildTraceBodyPreview(bytes, match.mimeType);
}

/**
 * One of the trace's `aria/*` or `screenshots/*` entries: inflated from the
 * archive, or read from the project pool when ingestion moved it there; null
 * when the trace lacks it.
 */
async function readSnapshot(bundle: TraceBundle, file: string): Promise<Buffer | null> {
  const entry = bundle.snapshotEntries.get(file);
  if (!entry) return bundle.readPooledEntry(file);
  try {
    return await decompressEntry(entry.data, entry.meta);
  } catch {
    return null;
  }
}

/** Largest aria tree the snapshot view inflates while it builds, on the request's thread. */
const MAX_ARIA_JSON_BYTES = 64 * 1024 * 1024;

/**
 * The per-action aria / screen snapshot inventory recorded in a 1.63 trace,
 * plus the in-execution page diff (the failing action's page before it ran
 * against the page at the failure). Feeds the Screen tab and the filmstrip.
 */
export async function getTraceSnapshotsFromBlob(blobPath: string): Promise<TraceSnapshotsResponse> {
  const bundle = await loadTraceBundle(blobPath);
  if (!bundle) return { status: 'no-trace', steps: [], failingCallId: null, hasAria: false, hasScreen: false };
  if (!bundle.snapshotView) {
    // The page diff renders and diffs whole aria trees, the costliest view of a
    // trace, and its answer never changes: built once per loaded trace. The
    // builder reads synchronously, so each tree it asks for inflates here, once.
    const ariaTexts = new Map<string, string | null>();
    const readAriaText = (file: string): string | null => {
      if (!ariaTexts.has(file)) {
        const entry = bundle.snapshotEntries.get(file);
        let text: string | null = null;
        try {
          if (entry)
            text = ariaJsonToText(decompressEntrySync(entry.data, entry.meta, MAX_ARIA_JSON_BYTES).toString('utf8'));
        } catch {
          // An unreadable tree counts as absent.
        }
        ariaTexts.set(file, text);
      }
      return ariaTexts.get(file) ?? null;
    };
    bundle.snapshotView = buildTraceSnapshots(bundle.parsed, readAriaText);
  }
  return bundle.snapshotView;
}

/** A single snapshot file served out of the trace: raw bytes plus the content type to send. */
export interface TraceSnapshotResource {
  bytes: Buffer;
  contentType: string;
}

/**
 * Serve one action's aria (JSON) or screen (PNG) snapshot for a phase, addressed
 * by callId. The file path comes from the parsed action, so only entries the
 * trace actually recorded are reachable.
 */
export async function getTraceSnapshotResourceFromBlob(
  blobPath: string,
  callId: string,
  kind: 'aria' | 'screen',
  phase: 'before' | 'after',
): Promise<TraceSnapshotResource | null> {
  const bundle = await loadTraceBundle(blobPath);
  const file = resolveSnapshotFile(bundle?.parsed ?? null, callId, kind, phase);
  if (!bundle || !file) return null;
  const bytes = await readSnapshot(bundle, file);
  if (!bytes) return null;
  return { bytes, contentType: kind === 'aria' ? 'application/json' : 'image/png' };
}

/**
 * The failing action's *before* aria tree rendered as ARIA text (for a runner
 * action, the page-side action it drove), for the fixture-less fallback
 * evidence. Null when the trace carries no failing-action aria snapshot. Read
 * at ingestion, so, like {@link loadTraceEvidenceStreams}, a fresh read.
 */
export async function getTraceFallbackAriaTextFromBlob(blobPath: string): Promise<string | null> {
  const archive = await readTraceArchive(blobPath);
  if (!archive) return null;
  const traceTexts = await decompressTextEntries(archive.zip, traceEventEntries(archive.metas));
  const parsed = traceTexts.length > 0 ? parseTraceTexts(traceTexts) : null;
  const failing = parsed?.failingAction ?? null;
  const file = failing?.ariaSnapshotBefore ?? (parsed ? pageActionOf(parsed, failing)?.ariaSnapshotBefore : undefined);
  const meta = file ? archive.metas.find((m) => m.name === file) : undefined;
  if (!meta) return null;
  try {
    return ariaJsonToText((await decompressEntry(archive.zip, meta)).toString('utf8'));
  } catch {
    return null;
  }
}
