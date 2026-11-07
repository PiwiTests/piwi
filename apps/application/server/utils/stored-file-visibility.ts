import { and, eq, or, sql } from 'drizzle-orm';
import type { DbClient } from '../database';
import { files, testRuns, traceBlobResources, traceBlobs, traceResources } from '../database/schema';
import { isVisibleRun, type RunVisibilityFields } from '#shared/run-eligibility';
import { resolveRunProjectId } from './project-access';

/**
 * A stored path's segments as storage resolves them: either slash a separator, empty and `.` segments dropped, and
 * each segment lower-cased without its trailing dots and spaces, which a case-insensitive or Windows filesystem
 * ignores.
 */
export function storedPathSegments(path: string): string[] {
  return path
    .split(/[\\/]/)
    .map((segment) => segment.replace(/[. ]+$/, '').toLowerCase())
    .filter((segment) => segment !== '');
}

/** Whether `viewerId` sees one of `runs`; a file no run names is read only when `unnamed` is. */
function seesAny(runs: RunVisibilityFields[], viewerId: number | null, unnamed = true): boolean {
  return runs.length === 0 ? unnamed : runs.some((run) => isVisibleRun(run, viewerId));
}

const RUN_FIELDS = { origin: testRuns.origin, requesterId: testRuns.requesterId };

/**
 * Whether `viewerId` may read a file stored under project `projectId`'s folder, as far as private runs go: a run's
 * own folder (`run-<id>/`) and the files a run's records name (a report's folder, a trace blob, a pooled trace
 * resource) are read only by those who see one of the runs that hold them. A trace blob or resource no run's file
 * names yet is read by nobody.
 */
export async function storedFileVisible(
  db: DbClient,
  projectId: number,
  path: string,
  viewerId: number | null,
): Promise<boolean> {
  const [, folder, name] = storedPathSegments(path);
  if (!folder) return true;
  // A folder named with `~` or `:` (a short 8.3 name, an NTFS stream) is read by nobody.
  if (/[~:]/.test(folder)) return false;
  const runFolder = folder.match(/^run-(\d+)$/);
  if (runFolder) return (await resolveRunProjectId(db, Number(runFolder[1]), viewerId)) === projectId;
  if (folder === 'blobs') {
    const hash = name?.split('.')[0];
    if (!hash) return true;
    const runs = await db
      .select(RUN_FIELDS)
      .from(traceBlobs)
      .innerJoin(files, eq(files.blobId, traceBlobs.id))
      .innerJoin(testRuns, eq(testRuns.id, files.testRunId))
      .where(and(eq(traceBlobs.projectId, projectId), eq(sql`lower(${traceBlobs.hash})`, hash)));
    return seesAny(runs, viewerId, false);
  }
  if (folder === 'trace-resources') {
    if (!name) return true;
    const runs = await db
      .select(RUN_FIELDS)
      .from(traceResources)
      .innerJoin(traceBlobResources, eq(traceBlobResources.resourceId, traceResources.id))
      .innerJoin(files, eq(files.blobId, traceBlobResources.blobId))
      .innerJoin(testRuns, eq(testRuns.id, files.testRunId))
      .where(and(eq(traceResources.projectId, projectId), eq(sql`lower(${traceResources.name})`, name)));
    return seesAny(runs, viewerId, false);
  }
  // A report file, or a file of an extracted report, whose `files` row names its entry file inside the folder.
  const reportPath = `project-${projectId}/${folder}`;
  const storedPath = sql`lower(${files.path})`;
  const runs = await db
    .select(RUN_FIELDS)
    .from(files)
    .innerJoin(testRuns, eq(testRuns.id, files.testRunId))
    .where(
      and(
        eq(testRuns.projectId, projectId),
        or(
          eq(storedPath, reportPath),
          eq(sql`substr(${storedPath}, 1, ${sql.raw(String(reportPath.length + 1))})`, `${reportPath}/`),
        ),
      ),
    );
  return seesAny(runs, viewerId);
}
