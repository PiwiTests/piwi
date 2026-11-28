import { closePendingStatus } from './scm/pending-status';
import { and, eq, inArray } from 'drizzle-orm';
import { testRuns } from '../database/schema';
import { runEventBus } from './run-events';
import { matchesStreamToken } from './shard-tokens';
import { cancelInstanceRuns as sharedCancelInstanceRuns } from '#shared/handlers/failure-cluster-ops';
import { recomputeRollupCells } from '#shared/handlers/analytics/rollups';
import { dayKey } from '#shared/handlers/analytics/common';
import type { DbClient as DB } from '../database';

/**
 * The states in which a batch delivery cancels the run it names by its stream token: one that has not settled, or one
 * the stale-run sweep interrupted.
 */
const STREAMED_STATUSES = ['initializing', 'running', 'finalizing', 'interrupted'];
/** The states in which a batch delivery cancels the run it names by its setup token: a run that never began. */
const SET_UP_STATUSES = ['initializing', 'interrupted'];

/**
 * Cancel the instance's runs in flight (`#shared/handlers/failure-cluster-ops`) and announce each. What the server
 * holds in memory for a cancelled run goes, its stream token with it, so its reporter's next request reads the run
 * from the database and is refused (`authorizeStreamToken`).
 */
export async function cancelInstanceRuns(
  db: DB,
  projectId: number,
  instanceId: string | null,
  excludeRunId?: number,
  isShardedRun?: boolean,
) {
  const cancelledRuns = await sharedCancelInstanceRuns(db, projectId, instanceId, excludeRunId, isShardedRun);
  for (const run of cancelledRuns) {
    runEventBus.cleanup(run.id);
    runEventBus.publishGlobal({ type: 'run-cancelled', runId: run.id, projectId: run.projectId, status: 'cancelled' });
    closeCancelledPendingStatus(run.id);
  }
}

/** A cancelled run's pending commit status is closed. */
function closeCancelledPendingStatus(runId: number): void {
  closePendingStatus(runId, 'cancelled').catch((e) => console.error('[pr-feedback] closePendingStatus failed', e));
}

/**
 * The run a batch delivery names in `replacesRun`, the token that proves it and the states in which it is cancelled; or
 * null when the field is missing or of another shape.
 */
function readReplacedRun(value: unknown): { runId: number; token: string; statuses: string[] } | null {
  if (!value || typeof value !== 'object') return null;
  const { runId, streamToken, setupToken } = value as Record<string, unknown>;
  if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) return null;
  if (typeof streamToken === 'string' && streamToken) return { runId, token: streamToken, statuses: STREAMED_STATUSES };
  if (typeof setupToken === 'string' && setupToken) return { runId, token: setupToken, statuses: SET_UP_STATUSES };
  return null;
}

/**
 * Cancel the run a batch delivery replaces (`replacesRun`), named by its id and proven by a token the run keeps until
 * it settles: its stream token for a run its reporter streamed before it fell back to the batch upload, or its setup
 * token for a run its global setup registered that never began (`/begin` swaps that token for the stream token). The
 * run is cancelled, and announced as `cancelInstanceRuns` announces its runs, only when it belongs to `projectId`, is
 * not sharded (other shards share a sharded run) and is in a state its token allows: a stream token cancels a run that
 * has not settled, a `finalizing` one whose `/finish` the reporter sent before it fell back too, or one the stale-run
 * sweep interrupted; a setup token, a run still `initializing` or interrupted in its setup. The daily rollup of an
 * interrupted run it cancels, which counted it as failed, is recomputed. A field of any other shape is ignored.
 */
export async function cancelReplacedRun(db: DB, projectId: number, replacesRun: unknown): Promise<void> {
  const named = readReplacedRun(replacesRun);
  if (!named) return;
  const [run] = await db
    .select({
      projectId: testRuns.projectId,
      streamToken: testRuns.streamToken,
      shardTotal: testRuns.shardTotal,
      status: testRuns.status,
      startTime: testRuns.startTime,
    })
    .from(testRuns)
    .where(eq(testRuns.id, named.runId));
  if (!run?.streamToken || run.projectId !== projectId || (run.shardTotal ?? 0) > 1) return;
  if (!matchesStreamToken(run.streamToken, named.token)) return;

  const cancelled = await db
    .update(testRuns)
    .set({ status: 'cancelled', streamToken: null, updatedAt: new Date() })
    .where(
      and(
        eq(testRuns.id, named.runId),
        eq(testRuns.streamToken, run.streamToken),
        inArray(testRuns.status, named.statuses),
      ),
    )
    .returning({ id: testRuns.id });
  if (cancelled.length === 0) return;
  runEventBus.cleanup(named.runId);
  runEventBus.publishGlobal({ type: 'run-cancelled', runId: named.runId, projectId, status: 'cancelled' });
  closeCancelledPendingStatus(named.runId);
  if (run.status === 'interrupted') await recomputeCancelledRunRollup(db, named.runId, projectId, run.startTime);
}

/** The daily rollup of the day an interrupted run started, recomputed once it is cancelled, and announced. */
async function recomputeCancelledRunRollup(db: DB, runId: number, projectId: number, startTime: Date): Promise<void> {
  try {
    await recomputeRollupCells(db, [{ projectId, day: dayKey(startTime) }]);
    runEventBus.publishGlobal({ type: 'rollup-updated', runId, projectId });
  } catch (e) {
    console.error('[analytics] recomputing the rollup of a replaced run failed', e);
  }
}
