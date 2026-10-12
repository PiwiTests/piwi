import { posix } from 'path';
import { getDatabase } from '../database';
import { files, traceBlobs, traceResources, traceBlobResources } from '../database/schema';
import { eq, and, count, isNull } from 'drizzle-orm';
import { getStorage } from '../storage';
import type { File } from '../database/schema';
import { traceManifestPath } from './trace-manifest';
import { reclaimTracePoolUnlessIngesting } from './trace-pool-guard';

/** True when a storage path points directly at a project root (`project-<id>`). */
function isProjectRoot(path: string): boolean {
  return /^project-\d+\/?$/.test(path) || path === '' || path === '.' || path === '/';
}

/**
 * Delete a single file's own storage.
 *
 * - Reports: delete the whole report directory when the report has its own
 *   subdirectory; delete just the file when it is stored directly under the
 *   project root (a single-file report, e.g. a blob `.zip`), because deleting
 *   the project root would wipe every other run's storage.
 * - Deduplicated trace blobs (`blobId` set): NOT touched here. A blob is shared
 *   across runs and cases, so its storage can only be freed once no surviving
 *   `files` row references it — {@link gcTraceBlobs} does that after the rows are
 *   deleted. Deleting it here, before the rows are gone, either leaks the blob
 *   (when several deleted rows share it) or removes one another run still needs.
 * - Other files: single-file deletion.
 *
 * Does NOT delete the database row — the caller manages that. Storage errors
 * are logged rather than thrown, so one unreachable object cannot abort the
 * deletion of the rest, but they are never silent.
 */
export async function deleteFileRow(file: File): Promise<void> {
  const storage = getStorage();

  try {
    if (file.type === 'report') {
      // Reports are stored either in their own directory
      //   project-1/run-…-html-report/index.html
      // or as a single file directly under the project
      //   project-1/run-…-report.zip
      // Deleting the parent directory is right for the first shape but would
      // wipe the entire project for the second, so fall back to a single-file
      // delete whenever the parent is the project root.
      const dirPath = posix.dirname(file.path);
      if (isProjectRoot(dirPath)) {
        await storage.deleteFile(file.path);
      } else {
        await storage.deleteDirectory(dirPath);
      }
    } else if (file.blobId) {
      // Deduplicated trace blob — deferred to gcTraceBlobs (see above).
      return;
    } else {
      // Non-deduped file — single file deletion.
      await storage.deleteFile(file.path);
    }
  } catch (error) {
    console.warn(`[delete-run] Failed to remove storage for file #${file.id} (${file.path}):`, error);
  }
}

type Db = Awaited<ReturnType<typeof getDatabase>>;

/** Delete a project's entire shared resource pool and empty its blob/resource dirs. */
async function reclaimWholeProjectPool(db: Db, projectId: number): Promise<void> {
  const storage = getStorage();
  const resourceRows = await db
    .select({ path: traceResources.path })
    .from(traceResources)
    .where(eq(traceResources.projectId, projectId));
  try {
    for (const r of resourceRows) await storage.deleteFile(r.path);
    await storage.deleteDirectory(`project-${projectId}/trace-resources`);
    await storage.deleteDirectory(`project-${projectId}/blobs`);
  } catch (error) {
    console.warn(`[delete-run] Failed to remove trace resources for project ${projectId}:`, error);
  }
  await db.delete(traceResources).where(eq(traceResources.projectId, projectId));
}

/**
 * Reference-count and free deduplicated trace blobs and their individual shared
 * resources after the referencing `files` rows have been deleted.
 *
 * Runs AFTER the rows are gone so the count reflects only survivors: a blob is
 * removed exactly when nothing else points at it, whether several rows in one
 * delete batch shared it or it was the last reference across runs.
 *
 * Resources are reclaimed per blob via the `trace_blob_resources` join table: a
 * resource goes as soon as no surviving blob references it, so deleting *some*
 * runs frees the resources unique to them. The join table is only trusted for a
 * project whose blobs are ALL indexed (`resources_indexed`); until backfill
 * catches up, such a project keeps the safe whole-project rule — resources go
 * only when its last blob does. A project with no blobs left always has its pool
 * removed wholesale.
 *
 * Storage errors are logged, never thrown, so one unreachable object cannot
 * abort the rest of a deletion.
 */
export async function gcTraceBlobs(db: Db, blobIds: Array<number | null | undefined>): Promise<void> {
  const ids = [...new Set(blobIds.filter((id): id is number => typeof id === 'number'))];
  if (ids.length === 0) return;
  const storage = getStorage();
  // Resources each removed blob referenced, grouped by project — the candidates
  // for per-resource reclaim once the blobs (and their links) are gone.
  const candidatesByProject = new Map<number, Set<number>>();

  for (const blobId of ids) {
    const refs = await db.select({ n: count() }).from(files).where(eq(files.blobId, blobId));
    if ((refs[0]?.n ?? 0) > 0) continue; // a surviving row still needs it

    const rows = await db.select().from(traceBlobs).where(eq(traceBlobs.id, blobId));
    const blob = rows[0];
    if (!blob) continue;

    const links = await db
      .select({ resourceId: traceBlobResources.resourceId })
      .from(traceBlobResources)
      .where(eq(traceBlobResources.blobId, blobId));
    const candidates = candidatesByProject.get(blob.projectId) ?? new Set<number>();
    for (const l of links) candidates.add(l.resourceId);
    candidatesByProject.set(blob.projectId, candidates);

    try {
      await storage.deleteFile(blob.path);
      await storage.deleteFile(traceManifestPath(blob.path));
    } catch (error) {
      console.warn(`[delete-run] Failed to remove trace blob storage (${blob.path}):`, error);
    }
    await db.delete(traceBlobResources).where(eq(traceBlobResources.blobId, blobId));
    await db.delete(traceBlobs).where(eq(traceBlobs.id, blobId));
  }

  for (const [projectId, candidates] of candidatesByProject) {
    // Skipped while a trace of the project is being ingested; the nightly
    // reclaimOrphanTraceResources frees what is still unreferenced then.
    await reclaimTracePoolUnlessIngesting(projectId, async () => {
      const remaining = await db.select({ n: count() }).from(traceBlobs).where(eq(traceBlobs.projectId, projectId));
      if ((remaining[0]?.n ?? 0) === 0) {
        await reclaimWholeProjectPool(db, projectId);
        return;
      }

      // Only trust the join table once every blob in the project is indexed.
      const unindexed = await db
        .select({ n: count() })
        .from(traceBlobs)
        .where(and(eq(traceBlobs.projectId, projectId), eq(traceBlobs.resourcesIndexed, false)));
      if ((unindexed[0]?.n ?? 0) > 0) return; // partially indexed → keep resources (safe)

      for (const resourceId of candidates) {
        const stillUsed = await db
          .select({ n: count() })
          .from(traceBlobResources)
          .where(eq(traceBlobResources.resourceId, resourceId));
        if ((stillUsed[0]?.n ?? 0) > 0) continue; // another surviving blob needs it

        const res = await db
          .select({ path: traceResources.path })
          .from(traceResources)
          .where(eq(traceResources.id, resourceId));
        const path = res[0]?.path;
        if (!path) continue;
        try {
          await storage.deleteFile(path);
        } catch (error) {
          console.warn(`[delete-run] Failed to remove trace resource (${path}):`, error);
        }
        await db.delete(traceResources).where(eq(traceResources.id, resourceId));
      }
    });
  }
}

/**
 * Nightly mop-up: remove shared resources nothing references any more. Catches
 * stragglers a per-delete pass could not — resources orphaned before
 * refcounting existed, or left by a blob whose links were only just backfilled.
 * Same safety gate as {@link gcTraceBlobs}: a resource is only removed when its
 * project is fully indexed, so a not-yet-backfilled blob can never lose a
 * resource it still needs. Returns how many resources it freed.
 */
export async function reclaimOrphanTraceResources(db: Db): Promise<number> {
  const storage = getStorage();

  // Projects with an un-indexed blob are not safe to reason about by join rows.
  const unindexedRows = await db
    .select({ projectId: traceBlobs.projectId })
    .from(traceBlobs)
    .where(eq(traceBlobs.resourcesIndexed, false));
  const notReady = new Set(unindexedRows.map((r) => r.projectId));

  // Resources with no join row at all (anti-join: no matching trace_blob_resources).
  const orphansOf = (projectId?: number) =>
    db
      .select({ id: traceResources.id, path: traceResources.path, projectId: traceResources.projectId })
      .from(traceResources)
      .leftJoin(traceBlobResources, eq(traceBlobResources.resourceId, traceResources.id))
      .where(
        projectId === undefined
          ? isNull(traceBlobResources.id)
          : and(isNull(traceBlobResources.id), eq(traceResources.projectId, projectId)),
      );
  const projectIds = new Set((await orphansOf()).map((r) => r.projectId).filter((id) => !notReady.has(id)));

  let removed = 0;
  for (const projectId of projectIds) {
    // A trace being ingested has pool files it has not linked yet: leave the
    // project for the next sweep. The orphans are read again inside, since an
    // ingestion that finished just before may have linked some of them.
    await reclaimTracePoolUnlessIngesting(projectId, async () => {
      for (const r of await orphansOf(projectId)) {
        try {
          await storage.deleteFile(r.path);
        } catch (error) {
          console.warn(`[delete-run] Failed to remove orphan trace resource (${r.path}):`, error);
        }
        await db.delete(traceResources).where(eq(traceResources.id, r.id));
        removed++;
      }
    });
  }
  return removed;
}

/**
 * Remove a run's own storage directory (`project-{projectId}/run-{runId}/`),
 * which holds every run-scoped object: non-deduped traces, screenshots,
 * videos, attachments and visual diffs. A trailing separator keeps the sweep
 * exact, so removing run 1 never touches run 10. Shared, deduplicated objects
 * (`project-{id}/blobs/`, `project-{id}/trace-resources/`) live outside this
 * directory and are reference-counted by {@link gcTraceBlobs}, so they are left
 * untouched here.
 *
 * This is a backstop for run deletion: it removes files orphaned by an earlier
 * failed deletion, so a run never leaves bytes behind even when a `files` row
 * is missing.
 */
export async function deleteRunStorageDir(projectId: number, runId: number): Promise<void> {
  const storage = getStorage();
  try {
    await storage.deleteDirectory(`project-${projectId}/run-${runId}`);
  } catch (error) {
    console.warn(`[delete-run] Failed to sweep run directory project-${projectId}/run-${runId}:`, error);
  }
}
