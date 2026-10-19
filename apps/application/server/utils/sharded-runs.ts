import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { testRuns } from '../database/schema';
import { apiError } from './api-error';
import type { DbClient } from '../database';
import { durationStats } from '#shared/utils/stats';
import { computeRunCountsFromRows } from './run-counts';
import { runEventBus } from './run-events';
import { runFinalizeSideEffects } from './run-finalize-side-effects';
import { updateRunMetadata, type MetadataObject } from './run-metadata';
import { cancelInstanceRuns } from './cancel-instance-runs';
import { withInstanceRunLock } from './ingest-locks';
import { sanitizeMetadata } from './sanitize';
import { resolveRunBranch } from './run-branch';
import { runCommit, runOrigin } from '#shared/run-eligibility';
import { sumFailedAndTimedOut } from '#shared/utils/test-counts';

/**
 * The initializing or running sharded run of a project instance, which another
 * shard of the same instance joins rather than starting a run of its own.
 */
export async function findActiveShardedRun(db: DbClient, projectId: number, instanceId: string) {
  const [run] = await db
    .select()
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, projectId),
        eq(testRuns.instanceId, instanceId),
        or(eq(testRuns.status, 'running'), eq(testRuns.status, 'initializing')),
        gt(testRuns.shardTotal, 1),
      ),
    )
    .orderBy(testRuns.id)
    .limit(1);
  return run;
}

/** The test durations a sharded run's shards reported so far. */
function shardDurations(metadata: MetadataObject): number[] {
  const durations = metadata.shardDurations;
  return Array.isArray(durations) ? durations.filter((d): d is number => typeof d === 'number') : [];
}

/** A copy of a sharded run's metadata with one shard's test durations added to the others'. */
export function withShardDurations(metadata: MetadataObject, durations: unknown[]): MetadataObject {
  const added = durations.filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
  return { ...metadata, shardDurations: [...shardDurations(metadata), ...added] };
}

/** One shard's tally in a batch submission (`/submit` or `/upload`) of a sharded run. */
export interface BatchShardTally {
  totalTests: number;
  passedTests: number;
  /** Failed and timed-out, folded. */
  failedTests: number;
  skippedTests: number;
  didNotRunTests: number;
  flakyTests: number;
  duration: number;
  /** The shard's test durations. */
  durations: unknown[];
}

/** The run-level fields of a batch submission, as `/submit` and the `testRun` field of `/upload` carry them. */
type BatchRunBody = Record<string, any>;

/** A batch shard's tally, from its run-level counters and its test cases. */
export function batchShardTally(
  body: BatchRunBody,
  testCases: ReadonlyArray<{ status?: unknown; retries?: unknown; duration?: unknown }>,
): BatchShardTally {
  return {
    totalTests: body.totalTests ?? 0,
    passedTests: body.passedTests ?? 0,
    failedTests: sumFailedAndTimedOut(body.failedTests, body.timedOutTests),
    skippedTests: body.skippedTests ?? 0,
    didNotRunTests: body.didNotRunTests ?? 0,
    flakyTests: testCases.filter((tc) => tc.status === 'passed' && Number(tc.retries ?? 0) > 0).length,
    duration: typeof body.duration === 'number' ? body.duration : 0,
    durations: testCases.map((tc) => tc.duration),
  };
}

/**
 * The run a shard of a batch submission joins: the instance's active sharded
 * run, or a new one, running with no shard counted yet, for the first shard to
 * arrive. A new run cancels the instance's earlier non-sharded runs.
 */
export function batchShardRun(db: DbClient, projectId: number, instanceId: string, body: BatchRunBody) {
  return withInstanceRunLock(projectId, instanceId, async () => {
    const active = await findActiveShardedRun(db, projectId, instanceId);
    if (active) return active;

    await cancelInstanceRuns(db, projectId, instanceId, undefined, true);
    const metadata = sanitizeMetadata(body.metadata || null);
    const [run] = await db
      .insert(testRuns)
      .values({
        projectId,
        status: 'running',
        startTime: new Date(body.startTime),
        duration: null,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        didNotRunTests: 0,
        environment: body.environment || null,
        branch: resolveRunBranch(body.metadata),
        label: body.label || null,
        metadata,
        origin: runOrigin(metadata),
        commit: runCommit(metadata),
        instanceId,
        playwrightVersion: body.playwrightVersion || null,
        reporterVersion: body.reporterVersion || null,
        shardTotal: body.shardTotal,
        shardIndex: body.shardIndex ?? null,
        shardsFinished: 0,
        isFullRun: body.isFullRun !== false ? 1 : 0,
        filterDetails: body.filterDetails ?? null,
      })
      .returning();
    if (!run) throw apiError({ statusCode: 500, message: 'Failed to create test run' });
    runEventBus.publishGlobal({ type: 'run-started', runId: run.id, projectId });
    return run;
  });
}

/**
 * Count a shard of a batch submission into its run, once its executions are
 * stored: the counters add up, the run's duration is its longest shard's, and
 * the shard counts as finished.
 */
export async function addBatchShard(db: DbClient, runId: number, tally: BatchShardTally): Promise<void> {
  await updateRunMetadata(db, runId, (metadata) => withShardDurations(metadata, tally.durations), {
    updatedAt: new Date(),
    totalTests: sql`${testRuns.totalTests} + ${tally.totalTests}`,
    passedTests: sql`${testRuns.passedTests} + ${tally.passedTests}`,
    failedTests: sql`${testRuns.failedTests} + ${tally.failedTests}`,
    skippedTests: sql`${testRuns.skippedTests} + ${tally.skippedTests}`,
    didNotRunTests: sql`${testRuns.didNotRunTests} + ${tally.didNotRunTests}`,
    flakyTests: sql`${testRuns.flakyTests} + ${tally.flakyTests}`,
    shardsFinished: sql`${testRuns.shardsFinished} + 1`,
    duration: longestDuration(tally.duration),
  });
}

/**
 * The larger of the run's duration and `duration`. SQLite's scalar MAX(a,b) is
 * an aggregate in PostgreSQL, so a CASE expression runs on both dialects.
 */
export function longestDuration(duration: number) {
  return sql`CASE WHEN coalesce(${testRuns.duration}, 0) > ${duration} THEN coalesce(${testRuns.duration}, 0) ELSE ${duration} END`;
}

/**
 * Settle a sharded run once every shard reported: its counters from its stored
 * executions, its status from them, its duration statistics from every shard's
 * durations, then the finalize side effects. The write applies only to a run
 * still running with every shard finished, so of shards finishing at once
 * exactly one settles the run and runs the side effects.
 *
 * `event` is the lifecycle event announced on the global stream. Returns the
 * final status, or null when a shard is still missing or another request
 * settled the run.
 */
export async function finalizeShardedRun(
  db: DbClient,
  runId: number,
  event: 'run-finished' | 'run-submitted',
): Promise<string | null> {
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!run || run.shardTotal == null || (run.shardsFinished ?? 0) < run.shardTotal) return null;

  const counts = await computeRunCountsFromRows(db, runId);
  const status = counts.failedTests > 0 ? 'failed' : 'passed';
  const stats = durationStats(shardDurations((run.metadata as MetadataObject | null) ?? {}));
  // The planned total (summed across shards), or the distinct rows when a shard planned none.
  const totalTests = Math.max(run.totalTests ?? 0, counts.totalTests);

  const [settled] = await db
    .update(testRuns)
    .set({
      status,
      streamToken: null,
      totalTests,
      passedTests: counts.passedTests,
      failedTests: counts.failedTests,
      skippedTests: counts.skippedTests,
      didNotRunTests: counts.didNotRunTests,
      flakyTests: counts.flakyTests,
      avgTestDuration: stats?.avg ?? null,
      p90TestDuration: stats?.p90 ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(testRuns.id, runId),
        inArray(testRuns.status, ['running', 'interrupted']),
        sql`${testRuns.shardsFinished} >= ${testRuns.shardTotal}`,
      ),
    )
    .returning();
  if (!settled) return null;

  runEventBus.publish(runId, {
    type: 'run-finished',
    data: {
      status,
      duration: settled.duration,
      totalTests,
      passedTests: counts.passedTests,
      failedTests: counts.failedTests,
      skippedTests: counts.skippedTests,
      didNotRunTests: counts.didNotRunTests,
      flakyTests: counts.flakyTests,
    },
  });
  runEventBus.publishGlobal({ type: event, runId, projectId: settled.projectId, status });

  await runFinalizeSideEffects(db, runId, {
    projectId: settled.projectId,
    metadata: settled.metadata,
    isFullRun: settled.isFullRun,
    status,
  });

  runEventBus.cleanup(runId);
  return status;
}

/** Announce on a sharded run's stream how many of its shards reported, while others are still missing. */
export async function publishShardProgress(db: DbClient, runId: number): Promise<void> {
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!run) return;
  runEventBus.publish(runId, {
    type: 'run-progress',
    data: {
      totalTests: run.totalTests,
      passedTests: run.passedTests,
      failedTests: run.failedTests,
      skippedTests: run.skippedTests,
      didNotRunTests: run.didNotRunTests,
      shardsFinished: run.shardsFinished ?? 0,
      shardTotal: run.shardTotal,
    },
  });
}
