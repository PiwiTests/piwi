import { eq } from 'drizzle-orm';
import { getDatabase } from '../database';
import { bugReports, testRuns } from '../database/schema';
import { getStorage } from '../storage';
import { bugReportStorageDir } from '#shared/handlers/bug-reports';
import { deleteProjectData, type ProjectDeletionProgress } from '#shared/handlers/projects';
import { apiError } from './api-error';
import { runEventBus } from './run-events';
import { testCaseCache } from './test-case-cache';

/** Deletions running in this server process, by project id. */
const deletionsInProgress = new Map<number, ProjectDeletionProgress>();

/** Where the deletion of `projectId` stands, or null when none is running in this process. */
export function getProjectDeletionProgress(projectId: number): ProjectDeletionProgress | null {
  return deletionsInProgress.get(projectId) ?? null;
}

/**
 * Permanently delete a project and all its associated data.
 *
 * Deletes storage first (the entire project-{id}/ directory, and the
 * bug-reports/{id}/ directory of each of its bug reports), then clears DB rows
 * in FK order via `deleteProjectData`. Progress is readable through
 * `getProjectDeletionProgress` while it runs, and a second deletion of the same
 * project is refused with a 409 until the first one ends. Server-only: touches
 * the real filesystem/S3 storage adapter, so it must not be imported by
 * shared/demo code (demo calls `deleteProjectData` directly against its
 * in-browser DB).
 */
export async function deleteProject(projectId: number): Promise<void> {
  if (deletionsInProgress.has(projectId)) {
    throw apiError({ statusCode: 409, message: 'This project is already being deleted' });
  }
  const progress: ProjectDeletionProgress = { phase: 'files', totalRuns: 0, runsDeleted: 0 };
  deletionsInProgress.set(projectId, progress);

  try {
    const db = await getDatabase();
    const runs = await db.select({ id: testRuns.id }).from(testRuns).where(eq(testRuns.projectId, projectId));
    progress.totalRuns = runs.length;

    // Delete all project files in one shot — covers reports, blobs, trace-resources
    const storage = getStorage();
    await storage.deleteDirectory(`project-${projectId}`);
    // A bug report's screenshots live in a folder of its own.
    const reports = await db.select({ id: bugReports.id }).from(bugReports).where(eq(bugReports.projectId, projectId));
    for (const report of reports) await storage.deleteDirectory(bugReportStorageDir(report.id));

    await deleteProjectData(db, projectId, (next) => Object.assign(progress, next));

    testCaseCache.invalidate(projectId);
    // Its runs that ran leave nothing in the event bus: their lanes, their running cases, their steps.
    for (const run of runs) runEventBus.cleanup(run.id);
  } finally {
    deletionsInProgress.delete(projectId);
  }
}
