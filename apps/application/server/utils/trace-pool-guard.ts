/**
 * Keeps the ingestion of a project's traces and the reclaim of its shared pool
 * (`project-<id>/trace-resources/`) apart.
 *
 * Ingestion finds a pool file already stored, skips writing it and links the
 * new blob to it seconds later; a reclaim that frees that file in between
 * leaves the blob pointing at nothing. Piwi runs as a single instance (the
 * deployment docs require one replica on either database), so a guard in this
 * process covers every writer.
 *
 * Ingestions of one project run side by side. A reclaim of a project that has
 * an ingestion in flight does not wait: it skips, and what it would have freed
 * is still unreferenced at the next nightly sweep
 * (`reclaimOrphanTraceResources`). An ingestion that starts while a reclaim of
 * its project runs waits for that reclaim to finish.
 */

const activeIngests = new Map<number, number>();
const runningReclaims = new Map<number, Promise<void>>();

/** Run one trace ingestion of `projectId`: from its first look at the pool to its last link. */
export async function withTracePoolIngest<T>(projectId: number, ingest: () => Promise<T>): Promise<T> {
  for (let reclaim = runningReclaims.get(projectId); reclaim; reclaim = runningReclaims.get(projectId)) {
    await reclaim.catch(() => {});
  }
  // No await between the check above and this registration, so no reclaim can start in between.
  activeIngests.set(projectId, (activeIngests.get(projectId) ?? 0) + 1);
  try {
    return await ingest();
  } finally {
    const left = (activeIngests.get(projectId) ?? 1) - 1;
    if (left > 0) activeIngests.set(projectId, left);
    else activeIngests.delete(projectId);
  }
}

/**
 * Run a reclaim of `projectId`'s pool unless one of its traces is being
 * ingested. Resolves to false when it skipped.
 */
export async function reclaimTracePoolUnlessIngesting(
  projectId: number,
  reclaim: () => Promise<void>,
): Promise<boolean> {
  if (activeIngests.has(projectId)) return false;
  const run = reclaim();
  runningReclaims.set(projectId, run);
  try {
    await run;
  } finally {
    if (runningReclaims.get(projectId) === run) runningReclaims.delete(projectId);
  }
  return true;
}
