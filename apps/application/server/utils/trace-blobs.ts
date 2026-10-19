import { getDatabase } from '../database';
import type { DbClient } from '../database';
import { traceBlobs, traceResources, traceBlobResources } from '../database/schema';
import { eq, and, inArray, gt, isNull } from 'drizzle-orm';
import { getStorage } from '../storage';
import type { StorageAdapter } from '../storage/types';
import { createHash } from 'node:crypto';
import { parseZipDirectory, decompressEntry, buildZip, ZipLimitError } from './trace-zip';
import type { ZipEntry, ZipEntryMeta } from './trace-zip';
import { safeStorageSegment } from './sanitize-filename';
import { compressResource } from './resource-compression';
import {
  isPooledTraceEntry,
  isReservedPoolName,
  parseTraceManifest,
  pooledTraceEntryName,
  traceManifestPath,
  traceManifestPoolNames,
  type TraceBlobManifest,
} from './trace-manifest';
import { withTracePoolIngest } from './trace-pool-guard';
import { forEachLimited } from './storage-helpers';
import { apiError } from './api-error';

const ID_BATCH_SIZE = 500;

/** How many pool files ingestion writes, or the size backfill measures, at once. */
const STORAGE_CONCURRENCY = 8;

/**
 * How many inflated bytes of screenshots and screencast frames ingestion holds
 * before it looks their names up and writes the new ones. An entry larger than
 * this is handled on its own.
 */
const POOLED_CHUNK_BYTES = 32 * 1024 * 1024;

/** A `resources/` entry name Playwright gives a snapshot resource: the SHA-1 of its bytes, then an extension. */
const SHA1_RESOURCE_NAME = /^([0-9a-f]{40})(?:\.[a-z0-9]{1,16})?$/i;

/** Whether a `resources/` entry's bytes are what its name says: only such an entry is pooled under its name. */
function isContentAddressedResource(name: string, data: Buffer): boolean {
  const sha1 = SHA1_RESOURCE_NAME.exec(name)?.[1];
  return !!sha1 && createHash('sha1').update(data).digest('hex') === sha1.toLowerCase();
}

/**
 * Every pool name a blob's manifest references, or [] when there is no
 * manifest. An unreadable manifest throws rather than reading as empty: the
 * caller would otherwise record a blob with no links, and GC could then free
 * resources it still needs.
 */
async function readManifestPoolNames(storage: StorageAdapter, blobPath: string): Promise<string[]> {
  const manifestPath = traceManifestPath(blobPath);
  if (!(await storage.exists(manifestPath))) return [];
  return traceManifestPoolNames(parseTraceManifest(await storage.readFile(manifestPath)));
}

/** The pool ids of those of `names` the project's pool holds, looked up in batches. */
async function poolIdsByName(db: DbClient, projectId: number, names: string[]): Promise<Map<string, number>> {
  const idByName = new Map<string, number>();
  for (let i = 0; i < names.length; i += ID_BATCH_SIZE) {
    const rows = await db
      .select({ id: traceResources.id, name: traceResources.name })
      .from(traceResources)
      .where(
        and(eq(traceResources.projectId, projectId), inArray(traceResources.name, names.slice(i, i + ID_BATCH_SIZE))),
      );
    for (const r of rows) idByName.set(r.name, r.id);
  }
  return idByName;
}

/**
 * Write one resource to the project pool and register it. Text resources
 * (network bodies, CSS, JS) are gzip-compressed at rest; already-compressed
 * ones (images, fonts) are stored as is. `size` is the on-disk byte count so
 * storage stats stay honest.
 */
async function storePoolResource(
  db: DbClient,
  storage: StorageAdapter,
  projectId: number,
  name: string,
  data: Buffer,
): Promise<void> {
  const { data: stored } = compressResource(data);
  const path = `project-${projectId}/trace-resources/${name}`;
  await storage.writeFile(path, stored);
  await db.insert(traceResources).values({ projectId, name, path, size: stored.length }).onConflictDoNothing();
}

/**
 * Record which shared resources a blob references, in `trace_blob_resources`.
 * Resolves each name (new or pre-existing) to its resource id and inserts the
 * links; `onConflictDoNothing` keeps it idempotent under concurrent uploads and
 * re-runs. Callers flip `resources_indexed` only after this resolves, so the
 * flag never claims links that are not there.
 */
async function linkBlobResources(
  db: DbClient,
  projectId: number,
  blobId: number,
  resourceNames: string[],
): Promise<void> {
  const uniqueNames = [...new Set(resourceNames)];
  if (uniqueNames.length === 0) return;

  const idByName = await poolIdsByName(db, projectId, uniqueNames);
  const links = uniqueNames
    .map((name) => idByName.get(name))
    .filter((id): id is number => typeof id === 'number')
    .map((resourceId) => ({ blobId, resourceId }));
  for (let i = 0; i < links.length; i += ID_BATCH_SIZE) {
    await db
      .insert(traceBlobResources)
      .values(links.slice(i, i + ID_BATCH_SIZE))
      .onConflictDoNothing();
  }
}

/**
 * Return the set of hashes that already have a stored blob for the given project.
 */
export async function checkExistingBlobs(projectId: number, hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const db = await getDatabase();
  const rows = await db
    .select({ hash: traceBlobs.hash })
    .from(traceBlobs)
    .where(and(eq(traceBlobs.projectId, projectId), inArray(traceBlobs.hash, hashes)));
  return new Set(rows.map((r) => r.hash));
}

/**
 * Store a trace blob with resource-level deduplication.
 *
 * `hash` must be the SHA-256 of `data`: the blob is stored and found again
 * under it, so a hash that is not the bytes' own is refused (400).
 *
 * Process:
 *  1. Read the ZIP central directory (names + offsets only — no decompression yet).
 *  2. Look up which `resources/` names the project's shared pool already holds,
 *     then decompress and store the new ones, one at a time, to bound peak memory.
 *     Only a resource named by the SHA-1 of its bytes is pooled under that name;
 *     any other stays in the slim ZIP.
 *  3. Pool the screenshots and screencast frames under names derived from their
 *     bytes (see `TraceBlobManifest`), in chunks of bounded size: inflate and
 *     name each, look the chunk's names up, write the new ones.
 *  4. Decompress the remaining entries (event streams, aria snapshots, sources)
 *     and write a "slim" ZIP of them.
 *  5. Write a manifest listing what went to the pool, for on-demand reconstruction.
 *
 * Runs inside the pool guard of the project, so no reclaim frees a pool file
 * between the moment this finds it stored and the moment the blob links to it.
 *
 * Falls back to storing the original ZIP if parsing fails, except for an
 * archive over the ZIP limits (`ZipLimitError`), which is refused.
 * Returns the canonical record — if the hash already existed nothing is written.
 */
export async function upsertTraceBlob(
  projectId: number,
  hash: string,
  data: Buffer,
): Promise<{ id: number; path: string; size: number }> {
  if (createHash('sha256').update(data).digest('hex') !== hash.toLowerCase()) {
    throw apiError({ statusCode: 400, message: 'The trace does not match its SHA-256 hash' });
  }

  const db = await getDatabase();

  // Fast path: blob already registered
  const existing = await db
    .select()
    .from(traceBlobs)
    .where(and(eq(traceBlobs.projectId, projectId), eq(traceBlobs.hash, hash)));

  if (existing[0]) {
    return { id: existing[0].id, path: existing[0].path, size: existing[0].size };
  }

  return withTracePoolIngest(projectId, () => storeTraceBlob(db, projectId, hash, data));
}

/** The writing half of {@link upsertTraceBlob}, run inside the project's pool guard. */
async function storeTraceBlob(
  db: DbClient,
  projectId: number,
  hash: string,
  data: Buffer,
): Promise<{ id: number; path: string; size: number }> {
  const storage = getStorage();
  const blobPath = `project-${projectId}/blobs/${hash}.zip`;

  await storage.mkdir(`project-${projectId}/blobs`);

  let dataToStore = data;
  // The manifest written next to the slim ZIP; its every pool name gets a join-table link.
  let manifest: TraceBlobManifest = { resources: [], pooledEntries: {} };
  let manifestJson: Buffer | null = null;

  try {
    // 1. Read central directory only — zero decompression at this stage
    const directory = parseZipDirectory(data);
    // Resource entry names come from the untrusted ZIP central directory.
    // Reduce each to a single safe path segment so a crafted name such as
    // `resources/../../evil` can never be written outside the project prefix,
    // and leave a name only the server gives (`pooled-…`) inside the slim ZIP.
    const safeResources: { meta: ZipEntryMeta; name: string }[] = [];
    const eventMetas: ZipEntryMeta[] = [];
    const pooledMetas: ZipEntryMeta[] = [];
    for (const meta of directory) {
      if (isPooledTraceEntry(meta.name)) {
        pooledMetas.push(meta);
      } else if (meta.name.startsWith('resources/')) {
        const name = safeStorageSegment(meta.name.slice('resources/'.length));
        if (!name) continue;
        if (isReservedPoolName(name)) eventMetas.push(meta);
        else safeResources.push({ meta, name });
      } else {
        eventMetas.push(meta);
      }
    }

    if (safeResources.length > 0 || pooledMetas.length > 0) {
      await storage.mkdir(`project-${projectId}/trace-resources`);
      let written = 0;

      // 2. Network resources: one lookup, then the new ones one at a time. A
      //    resource whose bytes are not what its name says stays in the slim ZIP.
      const knownResources = await poolIdsByName(db, projectId, [...new Set(safeResources.map((r) => r.name))]);
      const pooledResources = new Set<string>();
      const inlineEntries: ZipEntry[] = [];
      for (const { meta, name } of safeResources) {
        if (pooledResources.has(name)) continue;
        if (knownResources.has(name)) {
          pooledResources.add(name);
          continue;
        }
        const resource = await decompressEntry(data, meta);
        if (!isContentAddressedResource(name, resource)) {
          inlineEntries.push({ name: meta.name, data: resource });
          continue;
        }
        await storePoolResource(db, storage, projectId, name, resource);
        pooledResources.add(name);
        written++;
      }
      const resourceNames = [...pooledResources];

      // 3. Screenshots and screencast frames, by chunks: each entry is inflated
      //    once, held until its chunk is written, then released.
      const pooledEntries: Record<string, string> = {};
      const named = new Set<string>();
      let chunk: { name: string; data: Buffer }[] = [];
      let chunkBytes = 0;
      const flushChunk = async () => {
        const known = await poolIdsByName(
          db,
          projectId,
          chunk.map((c) => c.name),
        );
        const fresh = chunk.filter((c) => !known.has(c.name));
        await forEachLimited(fresh, STORAGE_CONCURRENCY, (c) =>
          storePoolResource(db, storage, projectId, c.name, c.data),
        );
        written += fresh.length;
        chunk = [];
        chunkBytes = 0;
      };
      for (const meta of pooledMetas) {
        let entryData: Buffer;
        try {
          entryData = await decompressEntry(data, meta);
        } catch {
          continue; // Skip corrupt entries, as the slim ZIP does
        }
        const poolName = pooledTraceEntryName(meta.name, entryData);
        pooledEntries[meta.name] = poolName;
        if (named.has(poolName)) continue;
        named.add(poolName);
        chunk.push({ name: poolName, data: entryData });
        chunkBytes += entryData.length;
        if (chunkBytes >= POOLED_CHUNK_BYTES) await flushChunk();
      }
      if (chunk.length > 0) await flushChunk();

      // 4. Decompress the remaining entries for the slim ZIP
      let eventEntries: ZipEntry[] = inlineEntries;
      for (const meta of eventMetas) {
        try {
          eventEntries.push({ name: meta.name, data: await decompressEntry(data, meta) });
        } catch {
          // Skip corrupt entries
        }
      }

      const slimZip = buildZip(eventEntries, { compress: true });
      // Release the decompressed event buffers now that they're fused into the
      // slim ZIP, so the manifest write and blob write below don't hold both.
      eventEntries = [];

      // 5. The manifest
      manifest = { resources: resourceNames, pooledEntries };
      manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8');
      dataToStore = slimZip;
      await storage.writeFile(traceManifestPath(blobPath), manifestJson);

      const savedBytes = data.length - slimZip.length;
      console.log(
        `[TraceBlob] ${resourceNames.length} resources and ${Object.keys(pooledEntries).length} screenshots` +
          ` and screencast frames pooled for project ${projectId} (${written} new),` +
          ` slim ZIP saves ${Math.round(savedBytes / 1024)} KB`,
      );
    }
  } catch (err) {
    if (err instanceof ZipLimitError) throw err;
    // Malformed or unsupported ZIP — store as-is, deduplication skipped
    console.warn(`[TraceBlob] Could not extract resources from trace: ${err}`);
    dataToStore = data;
    manifest = { resources: [], pooledEntries: {} };
    manifestJson = null;
  }

  await storage.writeFile(blobPath, dataToStore);

  await db
    .insert(traceBlobs)
    .values({
      projectId,
      hash,
      path: blobPath,
      size: data.length, // the uploaded trace's size, which is what users download
      storedSize: dataToStore.length + (manifestJson?.length ?? 0),
    })
    .onConflictDoNothing();

  // Re-read to get the canonical record (handles concurrent uploads of same blob)
  const rows = await db
    .select()
    .from(traceBlobs)
    .where(and(eq(traceBlobs.projectId, projectId), eq(traceBlobs.hash, hash)));

  const blob = rows[0]!;

  // Link the blob to its resources, then mark it indexed — the order that lets
  // per-resource GC trust the join table (see gcTraceBlobs / backfill).
  await linkBlobResources(db, projectId, blob.id, traceManifestPoolNames(manifest));
  await db.update(traceBlobs).set({ resourcesIndexed: true }).where(eq(traceBlobs.id, blob.id));

  return { id: blob.id, path: blob.path, size: blob.size };
}

/**
 * Backfill `trace_blob_resources` for blobs not yet indexed (no links, or links
 * that failed to write). Reads each un-indexed blob's manifest, inserts the
 * links and flips `resources_indexed`. Idempotent
 * and resumable: a cursor walks blob ids so a blob that errors is retried on a
 * future run without stalling this one. Returns how many blobs it indexed.
 *
 * Until a project's blobs are all indexed, gcTraceBlobs keeps the safe
 * whole-project fallback for it, so running this in the background never risks a
 * premature resource delete.
 */
export async function backfillTraceBlobResources(db: DbClient): Promise<number> {
  const storage = getStorage();
  let lastId = 0;
  let indexed = 0;

  for (;;) {
    const blobs = await db
      .select({ id: traceBlobs.id, projectId: traceBlobs.projectId, path: traceBlobs.path })
      .from(traceBlobs)
      .where(and(eq(traceBlobs.resourcesIndexed, false), gt(traceBlobs.id, lastId)))
      .orderBy(traceBlobs.id)
      .limit(ID_BATCH_SIZE);
    if (blobs.length === 0) break;

    for (const blob of blobs) {
      lastId = blob.id; // advance past this blob whether or not it indexes cleanly
      try {
        const names = await readManifestPoolNames(storage, blob.path);
        await linkBlobResources(db, blob.projectId, blob.id, names);
        await db.update(traceBlobs).set({ resourcesIndexed: true }).where(eq(traceBlobs.id, blob.id));
        indexed++;
      } catch (err) {
        console.warn(`[TraceBlob] Resource backfill failed for blob #${blob.id}: ${err}`);
      }
    }

    if (blobs.length < ID_BATCH_SIZE) break;
  }

  return indexed;
}

/**
 * Fill `trace_blobs.stored_size` where it is null, by asking storage for the
 * size of each blob file and its manifest, a few blobs at a time. Same cursor
 * walk as {@link backfillTraceBlobResources}: a blob that errors (storage
 * unreachable) keeps its null and is measured on a future run. A blob whose
 * file is gone occupies nothing and is recorded as 0. Returns how many blobs it
 * measured.
 */
export async function backfillTraceBlobStoredSizes(db: DbClient): Promise<number> {
  const storage = getStorage();
  let lastId = 0;
  let measured = 0;

  for (;;) {
    const blobs = await db
      .select({ id: traceBlobs.id, path: traceBlobs.path })
      .from(traceBlobs)
      .where(and(isNull(traceBlobs.storedSize), gt(traceBlobs.id, lastId)))
      .orderBy(traceBlobs.id)
      .limit(ID_BATCH_SIZE);
    if (blobs.length === 0) break;

    lastId = blobs[blobs.length - 1]!.id;
    await forEachLimited(blobs, STORAGE_CONCURRENCY, async (blob) => {
      try {
        const [zipSize, manifestSize] = await Promise.all([
          storage.fileSize(blob.path),
          storage.fileSize(traceManifestPath(blob.path)),
        ]);
        await db
          .update(traceBlobs)
          .set({ storedSize: (zipSize ?? 0) + (manifestSize ?? 0) })
          .where(eq(traceBlobs.id, blob.id));
        measured++;
      } catch (err) {
        console.warn(`[TraceBlob] Size backfill failed for blob #${blob.id}: ${err}`);
      }
    });

    if (blobs.length < ID_BATCH_SIZE) break;
  }

  return measured;
}

/**
 * Look up an existing blob by hash for a project without writing anything.
 * Returns null if not found.
 */
export async function findTraceBlob(
  projectId: number,
  hash: string,
): Promise<{ id: number; path: string; size: number } | null> {
  const db = await getDatabase();
  const rows = await db
    .select()
    .from(traceBlobs)
    .where(and(eq(traceBlobs.projectId, projectId), eq(traceBlobs.hash, hash)));
  const blob = rows[0];
  return blob ? { id: blob.id, path: blob.path, size: blob.size } : null;
}
