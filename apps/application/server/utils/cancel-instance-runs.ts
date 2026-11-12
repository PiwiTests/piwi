import { closePendingStatus } from './scm/pending-status';
import { and, eq, inArray } from 'drizzle-orm';
import { testRuns } from '../database/schema';
import { runEventBus } from './run-events';
import { matchesStreamToken } from './shard-tokens';
import { cancelInstanceRuns as sharedCancelInstanceRuns } from '#shared/handlers/failure-cluster-ops';
import type { DbClient as DB } from '../database';

/** The states of a run that has not settled, in which the batch delivery that replaces it cancels it. */
const UNSETTLED_STATUSES = ['initializing', 'running', 'finalizing'];

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

/** The run a batch delivery names in `replacesRun`, or null when the field is missing or of another shape. */
function readReplacedRun(value: unknown): { runId: number; streamToken: string } | null {
  if (!value || typeof value !== 'object') return null;
  const { runId, streamToken } = value as Record<string, unknown>;
  if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) return null;
  return typeof streamToken === 'string' && streamToken ? { runId, streamToken } : null;
}

/**
 * Cancel the run a batch delivery replaces (`replacesRun`): the run its reporter streamed before it fell back to the
 * batch upload, named by its id and proven by its stream token, which the run keeps until it settles. The run is
 * cancelled, and announced as `cancelInstanceRuns` announces its runs, only when it belongs to `projectId`, is not
 * sharded (other shards share a sharded run) and has not settled: a `finalizing` run too, whose `/finish` the
 * reporter sent before it fell back. A field of any other shape is ignored.
 */
export async function cancelReplacedRun(db: DB, projectId: number, replacesRun: unknown): Promise<void> {
  const named = readReplacedRun(replacesRun);
  if (!named) return;
  const [run] = await db
    .select({ projectId: testRuns.projectId, streamToken: testRuns.streamToken, shardTotal: testRuns.shardTotal })
    .from(testRuns)
    .where(eq(testRuns.id, named.runId));
  if (!run?.streamToken || run.projectId !== projectId || (run.shardTotal ?? 0) > 1) return;
  if (!matchesStreamToken(run.streamToken, named.streamToken)) return;

  const cancelled = await db
    .update(testRuns)
    .set({ status: 'cancelled', streamToken: null, updatedAt: new Date() })
    .where(
      and(
        eq(testRuns.id, named.runId),
        eq(testRuns.streamToken, run.streamToken),
        inArray(testRuns.status, UNSETTLED_STATUSES),
      ),
    )
    .returning({ id: testRuns.id });
  if (cancelled.length === 0) return;
  runEventBus.cleanup(named.runId);
  runEventBus.publishGlobal({ type: 'run-cancelled', runId: named.runId, projectId, status: 'cancelled' });
  closeCancelledPendingStatus(named.runId);
}
