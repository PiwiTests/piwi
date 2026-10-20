import { eq, and, lt, or, isNull, not, sql } from 'drizzle-orm';
import { testRuns } from '../database/schema';
import type { DbClient } from '../database';
import { runEventBus } from './run-events';
import { settleFinalizingRun } from './finalizing-runs';
import { computeRunCountsFromRows } from './run-counts';
import { recomputeRollupCells } from '#shared/handlers/analytics/rollups';
import { dayKey } from '#shared/handlers/analytics/common';
import { emitRunInterrupted } from './notifications/run-notifications';

// A live reporter sends a heartbeat (~every 15s) during idle gaps, so an active
// run's `updatedAt` never goes quiet for long. This timeout must stay comfortably
// above the heartbeat interval to tolerate transient network blips and the long
// idle gaps of pre-heartbeat reporters (a single slow test with no events). If a
// run is reaped early, the next event or heartbeat carrying its stream token revives it
// (see revive-run.ts).
export const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes without activity → mark interrupted

// A sharded run delivered by batch submissions waits, running, for its other
// shards' submissions, which send no heartbeat: shards of one pipeline can end
// far apart. It counts as stale only once quiet for this long.
export const BATCH_SHARD_WAIT_MS = 60 * 60 * 1000;

/** A sharded run delivered by batch submissions: it never had a stream token. */
const awaitsBatchShards = sql`(${testRuns.streamToken} is null and coalesce(${testRuns.shardTotal}, 0) > 1)`;

// A finalizing run has already reported its end at /finish and only waits for
// its report upload, which a large report keeps busy far longer than a
// heartbeat gap. Past this, it is settled without the upload.
export const FINALIZING_TIMEOUT_MS = 10 * 60 * 1000;

/** No activity since `threshold`: `updatedAt` older than it, or never set and created before it. */
function quietSince(threshold: Date) {
  return or(lt(testRuns.updatedAt, threshold), and(isNull(testRuns.updatedAt), lt(testRuns.createdAt, threshold)));
}

/**
 * Settle every `finalizing` run quiet for `FINALIZING_TIMEOUT_MS` — its report
 * upload never arrived — to the status its reporter sent to `/finish`, with the
 * finish-time side effects the upload would have fired (see
 * `settleFinalizingRun`). Returns the settled ids.
 */
export async function settleStaleFinalizingRuns(db: DbClient, now = Date.now()): Promise<number[]> {
  const staleRuns = await db
    .select({ id: testRuns.id, projectId: testRuns.projectId, metadata: testRuns.metadata })
    .from(testRuns)
    .where(and(eq(testRuns.status, 'finalizing'), quietSince(new Date(now - FINALIZING_TIMEOUT_MS))));

  const settled: number[] = [];
  for (const run of staleRuns) {
    if (await settleFinalizingRun(db, run)) settled.push(run.id);
  }
  return settled;
}

/**
 * Mark every initializing or running run with no activity for
 * `STALE_TIMEOUT_MS` (`BATCH_SHARD_WAIT_MS` for a batch sharded run) as
 * `interrupted` — its reporter was killed or lost its connection before
 * reporting the end. Each reaped run gets its counters
 * reconciled and its end announced on its own stream and on the global
 * lifecycle stream, like a run that finished normally, a `run.interrupted`
 * notification sent, and its day's rollup recomputed, since an interrupted run
 * counts as a failed one. Returns the reaped ids.
 */
export async function interruptStaleRuns(db: DbClient, now = Date.now()): Promise<number[]> {
  const staleThreshold = new Date(now - STALE_TIMEOUT_MS);

  const staleRuns = await db
    .update(testRuns)
    .set({
      status: 'interrupted',
      updatedAt: new Date(now),
    })
    .where(
      and(
        or(eq(testRuns.status, 'running'), eq(testRuns.status, 'initializing')),
        quietSince(staleThreshold),
        or(not(awaitsBatchShards), quietSince(new Date(now - BATCH_SHARD_WAIT_MS))),
      ),
    )
    .returning({
      id: testRuns.id,
      projectId: testRuns.projectId,
      duration: testRuns.duration,
      totalTests: testRuns.totalTests,
      startTime: testRuns.startTime,
    });

  // The streaming events endpoint counts attempts (a flaky test's failed
  // attempt is one increment), and only /finish collapses those to
  // distinct-test counts. An interrupted run never reached /finish, so
  // recompute the counters from its persisted rows before anyone reads them
  // — otherwise the run keeps inflated failed/flaky totals that disagree
  // with the de-duplicated Tests list.
  for (const run of staleRuns) {
    const counts = await computeRunCountsFromRows(db, run.id);
    const totalTests = Math.max(run.totalTests ?? 0, counts.totalTests);

    await db
      .update(testRuns)
      .set({
        totalTests,
        passedTests: counts.passedTests,
        failedTests: counts.failedTests,
        skippedTests: counts.skippedTests,
        didNotRunTests: counts.didNotRunTests,
        flakyTests: counts.flakyTests,
      })
      .where(eq(testRuns.id, run.id));

    // Signal SSE subscribers so their connections close, then free event bus
    // memory. Echo the reconciled counts so live viewers keep the partial
    // results already streamed instead of snapping back to zeros.
    runEventBus.publish(run.id, {
      type: 'run-finished',
      data: {
        status: 'interrupted',
        duration: run.duration,
        totalTests,
        passedTests: counts.passedTests,
        failedTests: counts.failedTests,
        skippedTests: counts.skippedTests,
        didNotRunTests: counts.didNotRunTests,
        flakyTests: counts.flakyTests,
      },
    });
    runEventBus.cleanup(run.id);

    // App-wide consumers (run lists, the desktop shell's OS progress) track
    // in-flight runs from the global stream and only drop one on its end event.
    runEventBus.publishGlobal({ type: 'run-finished', runId: run.id, projectId: run.projectId, status: 'interrupted' });

    // Subscribers hear of the interruption. The finish-time side effects do not
    // run: a later event carrying the run's stream token revives it (revive-run.ts).
    await emitRunInterrupted(db, run.id);
  }

  // The analytics read the daily rollups, which count an interrupted run as a failed one: recompute
  // each project-day the sweep touched, once, then announce it as the finalize step does.
  if (staleRuns.length > 0) {
    try {
      await recomputeRollupCells(
        db,
        staleRuns.map((run) => ({ projectId: run.projectId, day: dayKey(run.startTime) })),
      );
      const lastRunOf = new Map(staleRuns.map((run) => [run.projectId, run.id]));
      for (const [projectId, runId] of lastRunOf)
        runEventBus.publishGlobal({ type: 'rollup-updated', runId, projectId });
    } catch (e) {
      console.error('[analytics] recomputing the rollups of interrupted runs failed', e);
    }
  }

  return staleRuns.map((run) => run.id);
}
