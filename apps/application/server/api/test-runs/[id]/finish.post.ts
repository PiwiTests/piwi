import { sql, eq } from 'drizzle-orm';
import { getDatabase, type DbClient } from '../../../database';
import { testRuns } from '../../../database/schema';
import { runEventBus } from '../../../utils/run-events';
import { sanitizeMetadata } from '../../../utils/sanitize';
import { carryIngestHealth } from '#shared/ingest-health';
import { resolveRunBranch } from '../../../utils/run-branch';
import { runCommit, runOrigin } from '#shared/run-eligibility';
import { validateAndReviveRun } from '../../../utils/revive-run';
import { matchesShardToken, readShardTokensFromMeta, withoutShardToken } from '../../../utils/shard-tokens';
import { updateRunMetadata } from '../../../utils/run-metadata';
import {
  finalizeShardedRun,
  longestDuration,
  publishShardProgress,
  withShardDurations,
} from '../../../utils/sharded-runs';
import { runFinalizeSideEffects } from '../../../utils/run-finalize-side-effects';
import { keepIncidentMetadata } from '#shared/run-incident';
import { withPendingStatus } from '../../../utils/finalizing-runs';
import { sumFailedAndTimedOut } from '#shared/utils/test-counts';
import { applyReporterKeep } from '#shared/handlers/run-keep';
import { sanitizeResourceReport } from '#shared/resource-report';
import { saveResourceReportPart } from '#shared/handlers/resource-reports';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Finish a streaming test run',
    description:
      'Finalize a streaming test run by setting its final status and calculating performance metrics. Supports pending uploads mode where reports are uploaded asynchronously after finishing. For sharded runs, the run finishes only after all shards report; test counters come from the streamed events.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              streamToken: { type: 'string' },
              status: { type: 'string' },
              duration: { type: 'number' },
              durations: { type: 'array', items: { type: 'number' } },
              hasPendingUploads: { type: 'boolean' },
              flakyTests: { type: 'integer' },
              shardIndex: { type: 'integer' },
              shardTotal: { type: 'integer' },
            },
            required: ['streamToken'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const id = parseInt(getRouterParam(event, 'id') || '0');

  if (!id) {
    throw apiError({
      statusCode: 400,
      message: 'Invalid test run ID',
    });
  }

  const body = await readBody(event);

  // Validate stream token
  if (!body.streamToken) {
    throw apiError({
      statusCode: 401,
      message: 'Missing stream token',
    });
  }

  const db = await getDatabase();

  // Verify the run exists and the stream token matches
  const testRunResults = await db.select().from(testRuns).where(eq(testRuns.id, id));
  const testRun = testRunResults[0];

  if (!testRun) {
    throw apiError({
      statusCode: 404,
      message: 'Test run not found',
    });
  }

  const isSharded = !!(testRun.shardTotal && testRun.shardTotal > 1);
  const shardTokens = isSharded ? readShardTokensFromMeta(testRun.metadata) : undefined;
  const isShardToken = shardTokens ? (token: string) => matchesShardToken(shardTokens, token) : undefined;
  await validateAndReviveRun(db, id, testRun, body.streamToken, isShardToken);

  const duration = body.duration ?? Date.now() - new Date(testRun.startTime).getTime();
  if (isSharded) return finishShard(db, id, body, duration);

  await applyReporterKeep(db, id, body.keep);

  // Determine final status
  const status = body.status ?? 'failed';

  // Compute performance metrics
  let avgTestDuration: number | null = null;
  let p90TestDuration: number | null = null;

  if (body.durations && Array.isArray(body.durations)) {
    const stats = durationStats(body.durations);
    if (stats) {
      avgTestDuration = stats.avg;
      p90TestDuration = stats.p90;
    }
  }

  // Calculate flaky tests count (default to 0 if not provided)
  const flakyTests = body.flakyTests ?? 0;

  const hasPendingUploads = body.hasPendingUploads === true;

  const incomingResources = sanitizeResourceReport(body.resourceReport);
  if (incomingResources) await saveResourceReportPart(db, id, incomingResources);

  // ── Non-sharded run (existing behaviour) ─────────────────────────────────

  // Fold timed-out into failed for both the DB write and the live SSE events.
  // Preserve the "use body value when provided, else keep existing DB value"
  // semantics — the reporter sends both fields, but older clients may omit them.
  const hasBodyFailed = body.failedTests !== undefined || body.timedOutTests !== undefined;
  const failedTestsValue = hasBodyFailed
    ? sumFailedAndTimedOut(body.failedTests, body.timedOutTests)
    : testRun.failedTests;

  // The reporter's final metadata, when it sends one, replaces the stored one
  // and keeps the incident flag and the ingest health the server recorded.
  const reportedMetadata = body.metadata
    ? keepIncidentMetadata(testRun.metadata, carryIngestHealth(sanitizeMetadata(body.metadata), testRun.metadata))
    : null;

  if (hasPendingUploads) {
    // The reported status waits in the metadata, where it survives a restart,
    // until the report upload or the stale-run sweep settles the run.
    const pendingMetadata = withPendingStatus(body.metadata ? reportedMetadata : testRun.metadata, status);
    const updateData: Record<string, unknown> = {
      status: 'finalizing',
      duration,
      streamToken: null,
      // The stale-run sweep measures the wait for the report upload from here.
      updatedAt: new Date(),
      ...(body.totalTests !== undefined && { totalTests: body.totalTests }),
      ...(body.passedTests !== undefined && { passedTests: body.passedTests }),
      ...(hasBodyFailed && { failedTests: failedTestsValue }),
      ...(body.skippedTests !== undefined && { skippedTests: body.skippedTests }),
      ...(body.didNotRunTests !== undefined && { didNotRunTests: body.didNotRunTests }),
      ...(body.flakyTests !== undefined && { flakyTests }),
      ...(avgTestDuration !== null && { avgTestDuration }),
      ...(p90TestDuration !== null && { p90TestDuration }),
      metadata: pendingMetadata,
      origin: runOrigin(pendingMetadata),
      commit: runCommit(pendingMetadata),
      ...(body.metadata && { branch: resolveRunBranch(body.metadata) }),
      ...(body.label !== undefined && { label: body.label }),
      ...(body.playwrightVersion && { playwrightVersion: body.playwrightVersion }),
      ...(body.reporterVersion && { reporterVersion: body.reporterVersion }),
      ...(body.setupSteps && { setupSteps: body.setupSteps }),
      ...(body.isFullRun !== undefined && { isFullRun: body.isFullRun !== false ? 1 : 0 }),
      ...(body.filterDetails !== undefined && { filterDetails: body.filterDetails ?? null }),
    };

    await db.update(testRuns).set(updateData).where(eq(testRuns.id, id));

    runEventBus.clearRunState(id);

    runEventBus.publish(id, {
      type: 'run-finalizing',
      data: {
        status,
        duration,
        totalTests: body.totalTests ?? testRun.totalTests,
        passedTests: body.passedTests ?? testRun.passedTests,
        failedTests: failedTestsValue,
        skippedTests: body.skippedTests ?? testRun.skippedTests,
        didNotRunTests: body.didNotRunTests ?? testRun.didNotRunTests,
        flakyTests,
      },
    });

    runEventBus.publishGlobal({ type: 'run-finalizing', runId: id, projectId: testRun.projectId, status });
  } else {
    const updateData: Record<string, unknown> = {
      status,
      duration,
      streamToken: null,
      ...(body.totalTests !== undefined && { totalTests: body.totalTests }),
      ...(body.passedTests !== undefined && { passedTests: body.passedTests }),
      ...(hasBodyFailed && { failedTests: failedTestsValue }),
      ...(body.skippedTests !== undefined && { skippedTests: body.skippedTests }),
      ...(body.didNotRunTests !== undefined && { didNotRunTests: body.didNotRunTests }),
      ...(body.flakyTests !== undefined && { flakyTests }),
      ...(avgTestDuration !== null && { avgTestDuration }),
      ...(p90TestDuration !== null && { p90TestDuration }),
      ...(body.metadata && {
        metadata: reportedMetadata,
        origin: runOrigin(reportedMetadata),
        commit: runCommit(reportedMetadata),
        branch: resolveRunBranch(body.metadata),
      }),
      ...(body.label !== undefined && { label: body.label }),
      ...(body.playwrightVersion && { playwrightVersion: body.playwrightVersion }),
      ...(body.reporterVersion && { reporterVersion: body.reporterVersion }),
      ...(body.setupSteps && { setupSteps: body.setupSteps }),
      ...(body.isFullRun !== undefined && { isFullRun: body.isFullRun !== false ? 1 : 0 }),
      ...(body.filterDetails !== undefined && { filterDetails: body.filterDetails ?? null }),
    };

    await db.update(testRuns).set(updateData).where(eq(testRuns.id, id));

    runEventBus.publish(id, {
      type: 'run-finished',
      data: {
        status,
        duration,
        totalTests: body.totalTests ?? testRun.totalTests,
        passedTests: body.passedTests ?? testRun.passedTests,
        failedTests: failedTestsValue,
        skippedTests: body.skippedTests ?? testRun.skippedTests,
        didNotRunTests: body.didNotRunTests ?? testRun.didNotRunTests,
        flakyTests,
      },
    });

    runEventBus.publishGlobal({ type: 'run-finished', runId: id, projectId: testRun.projectId, status });

    await runFinalizeSideEffects(db, id, {
      projectId: testRun.projectId,
      metadata: testRun.metadata,
      isFullRun: body.isFullRun === undefined ? testRun.isFullRun : body.isFullRun !== false ? 1 : 0,
      status,
    });

    runEventBus.cleanup(id);
  }

  return {
    success: true,
    runId: id,
    status: hasPendingUploads ? 'finalizing' : status,
  };
});

/**
 * One shard of a sharded run reports its end. The shard's token leaves the
 * run's shard tokens in the same write that records its test durations, so a
 * replayed `/finish` finds it gone and changes nothing. The run's test counters
 * are not touched: every case (synthesized didnotrun ones included) arrives as
 * a streamed event, which the events endpoint already counted. Only flakyTests
 * adds up here, since the events tally has no flaky notion. The run settles
 * once every shard finished.
 */
async function finishShard(db: DbClient, id: number, body: Record<string, any>, duration: number) {
  const recorded = await updateRunMetadata(db, id, (metadata) => {
    const remaining = withoutShardToken(metadata, body.streamToken);
    return remaining && withShardDurations(remaining, Array.isArray(body.durations) ? body.durations : []);
  });
  runEventBus.removeShardToken(id, body.streamToken);

  if (!recorded) {
    const [current] = await db.select({ status: testRuns.status }).from(testRuns).where(eq(testRuns.id, id));
    return { success: true, runId: id, status: current?.status ?? 'running' };
  }

  await applyReporterKeep(db, id, body.keep);
  // This shard's resource report, in its own row: shards finishing at once
  // each write theirs, and none overwrites another's.
  const incomingResources = sanitizeResourceReport(body.resourceReport);
  if (incomingResources) await saveResourceReportPart(db, id, incomingResources);

  await db
    .update(testRuns)
    .set({
      updatedAt: new Date(),
      flakyTests: sql`${testRuns.flakyTests} + ${body.flakyTests ?? 0}`,
      shardsFinished: sql`${testRuns.shardsFinished} + 1`,
      duration: longestDuration(duration),
      // The first shard to report a branch names the run's branch.
      branch: sql`COALESCE(${testRuns.branch}, ${resolveRunBranch(body.metadata)})`,
      ...(body.isFullRun !== undefined && { isFullRun: body.isFullRun !== false ? 1 : 0 }),
      ...(body.filterDetails !== undefined && { filterDetails: body.filterDetails ?? null }),
    })
    .where(eq(testRuns.id, id));

  const finalStatus = await finalizeShardedRun(db, id, 'run-finished');
  if (!finalStatus) await publishShardProgress(db, id);

  return { success: true, runId: id, status: finalStatus ?? 'running' };
}
