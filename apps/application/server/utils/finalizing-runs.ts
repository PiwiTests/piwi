import { and, eq } from 'drizzle-orm';
import { testRuns } from '../database/schema';
import type { DbClient } from '../database';
import { runEventBus } from './run-events';
import { runFinalizeSideEffects } from './run-finalize-side-effects';
import { runCommit, runOrigin } from '#shared/run-eligibility';

/**
 * The metadata key where a `finalizing` run keeps the status its reporter sent
 * to `/finish`, until its report upload lands or the stale-run sweep settles it.
 */
const PENDING_STATUS_KEY = 'pendingStatus';

/** The status a finalizing run settles to when it holds no pending status. */
const UNKNOWN_FINAL_STATUS = 'interrupted';

function metadataCopy(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
}

/** The run's metadata plus the status it finishes with once its report upload lands. */
export function withPendingStatus(metadata: unknown, status: string): Record<string, unknown> {
  return { ...metadataCopy(metadata), [PENDING_STATUS_KEY]: status };
}

/** The status a finalizing run's reporter sent to `/finish`, when one is stored. */
export function readPendingStatus(metadata: unknown): string | undefined {
  const status = metadataCopy(metadata)[PENDING_STATUS_KEY];
  return typeof status === 'string' && status ? status : undefined;
}

/**
 * Give a `finalizing` run the status its reporter sent to `/finish`, announce
 * its end and fire the finish-time side effects, as `/finish` does for a run
 * with no uploads pending. The update applies only while the run is still
 * finalizing, so when the report upload and the stale-run sweep reach the same
 * run, only one of them settles it. Returns the status set, or null when the
 * run had already left `finalizing`.
 */
export async function settleFinalizingRun(
  db: DbClient,
  run: { id: number; projectId: number; metadata: unknown },
): Promise<string | null> {
  const status = readPendingStatus(run.metadata) ?? UNKNOWN_FINAL_STATUS;
  const metadata = metadataCopy(run.metadata);
  delete metadata[PENDING_STATUS_KEY];

  const settled = await db
    .update(testRuns)
    .set({ status, metadata, origin: runOrigin(metadata), commit: runCommit(metadata), updatedAt: new Date() })
    .where(and(eq(testRuns.id, run.id), eq(testRuns.status, 'finalizing')))
    .returning({ id: testRuns.id, isFullRun: testRuns.isFullRun });
  if (settled.length === 0) return null;

  runEventBus.publish(run.id, { type: 'run-finished', data: { status } });
  runEventBus.publishGlobal({ type: 'run-finished', runId: run.id, projectId: run.projectId, status });
  await runFinalizeSideEffects(db, run.id, {
    projectId: run.projectId,
    metadata,
    isFullRun: settled[0]!.isFullRun,
    status,
  });
  runEventBus.cleanup(run.id);
  return status;
}
