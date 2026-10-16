import { sql, eq } from 'drizzle-orm';
import { getDatabase } from '../../../database';
import { testRuns } from '../../../database/schema';
import { runEventBus } from '../../../utils/run-events';
import { computeRunCountsFromRows } from '../../../utils/run-counts';
import { sanitizeMetadata } from '../../../utils/sanitize';
import { carryIngestHealth } from '#shared/ingest-health';
import { resolveRunBranch } from '../../../utils/run-branch';
import { runCommit, runOrigin } from '#shared/run-eligibility';
import { validateAndReviveRun } from '../../../utils/revive-run';
import { matchesShardToken, readShardTokensFromMeta, removeStoredShardToken } from '../../../utils/shard-tokens';
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
  await applyReporterKeep(db, id, body.keep);

  // Determine final status
  const status = body.status ?? 'failed';
  const duration = body.duration ?? Date.now() - new Date(testRun.startTime).getTime();

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

  // This reporter's resource report, in its own row: shards finishing at once
  // each write theirs, and none overwrites another's.
  const incomingResources = sanitizeResourceReport(body.resourceReport);
  if (incomingResources) await saveResourceReportPart(db, id, incomingResources);

  if (isSharded) {
    // Sharded run: track shardsFinished; duration is the maximum across shards.
    // The test counters are NOT touched here — every case (including
    // synthesized didnotrun ones) arrives as a streamed event, and the events
    // endpoint already increments the counters per inserted row. Adding the
    // shards' finish totals on top would count every execution twice. Only
    // flakyTests accumulates here: the events tally has no flaky notion, so
    // the shards' finish bodies are its single source.

    // Merge this shard's durations with any previously accumulated ones
    const allDurations: number[] = [];
    const currentMeta = (testRun.metadata as Record<string, unknown>) ?? {};
    const prevDurations = currentMeta.shardDurations as number[] | undefined;
    if (prevDurations) allDurations.push(...prevDurations);
    if (body.durations && Array.isArray(body.durations)) allDurations.push(...body.durations);

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
      status: 'running', // keep running until all shards finish
      flakyTests: sql`${testRuns.flakyTests} + ${flakyTests}`,
      shardsFinished: sql`${testRuns.shardsFinished} + 1`,
      // Portable "max of two values": SQLite's scalar MAX(a,b) is an aggregate in
      // Postgres, so use a CASE expression that runs on both dialects.
      duration: sql`CASE WHEN coalesce(${testRuns.duration}, 0) > ${duration} THEN coalesce(${testRuns.duration}, 0) ELSE ${duration} END`,
      metadata: { ...currentMeta, shardDurations: allDurations },
      origin: runOrigin(currentMeta),
      commit: runCommit(currentMeta),
      // The first shard to report a branch names the run's branch.
      branch: sql`COALESCE(${testRuns.branch}, ${resolveRunBranch(body.metadata)})`,
      ...(body.isFullRun !== undefined && { isFullRun: body.isFullRun !== false ? 1 : 0 }),
      ...(body.filterDetails !== undefined && { filterDetails: body.filterDetails ?? null }),
    };

    await db.update(testRuns).set(updateData).where(eq(testRuns.id, id));

    // Remove this shard's token so it cannot send more events
    runEventBus.removeShardToken(id, body.streamToken);
    await removeStoredShardToken(db, id, body.streamToken);

    // Re-read the updated row to check if all shards have finished
    const updated = await db.select().from(testRuns).where(eq(testRuns.id, id));
    const updatedRun = updated[0];

    let finalStatus: string | undefined;

    if (
      updatedRun &&
      updatedRun.shardsFinished != null &&
      updatedRun.shardTotal != null &&
      updatedRun.shardsFinished >= updatedRun.shardTotal
    ) {
      // All shards done — recompute distinct-test counters from the persisted
      // rows (the per-shard events counted attempts) and derive the final status
      // from them, so a flaky-only sharded run reads as passed with no failures.
      const counts = await computeRunCountsFromRows(db, id);
      finalStatus = counts.failedTests > 0 ? 'failed' : 'passed';

      if (allDurations.length > 0) {
        const aggStats = durationStats(allDurations);
        if (aggStats) {
          avgTestDuration = aggStats.avg;
          p90TestDuration = aggStats.p90;
        }
      }

      // Store accumulated durations in metadata for future shards (if somehow more arrive)
      // Preserve existing metadata (including shardTokens) and merge in aggregated durations
      const existingMeta = (updatedRun.metadata as Record<string, unknown>) ?? {};
      const finalMeta = { ...existingMeta, shardDurations: allDurations };

      await db
        .update(testRuns)
        .set({
          status: finalStatus,
          streamToken: null,
          duration: updatedRun.duration, // keep max duration
          // The planned total (summed across shards at /start), or the distinct
          // rows when a shard reported no planned count.
          totalTests: Math.max(updatedRun.totalTests ?? 0, counts.totalTests),
          passedTests: counts.passedTests,
          failedTests: counts.failedTests,
          skippedTests: counts.skippedTests,
          didNotRunTests: counts.didNotRunTests,
          flakyTests: counts.flakyTests,
          avgTestDuration,
          p90TestDuration,
          metadata: finalMeta,
          origin: runOrigin(finalMeta),
          commit: runCommit(finalMeta),
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, id));

      // Publish run-finished event
      runEventBus.publish(id, {
        type: 'run-finished',
        data: {
          status: finalStatus,
          duration: updatedRun.duration,
          totalTests: Math.max(updatedRun.totalTests ?? 0, counts.totalTests),
          passedTests: counts.passedTests,
          failedTests: counts.failedTests,
          skippedTests: counts.skippedTests,
          didNotRunTests: counts.didNotRunTests,
          flakyTests: counts.flakyTests,
        },
      });

      runEventBus.publishGlobal({
        type: 'run-finished',
        runId: id,
        projectId: testRun.projectId,
        status: finalStatus,
      });

      await runFinalizeSideEffects(db, id, {
        projectId: testRun.projectId,
        metadata: testRun.metadata,
        isFullRun: updatedRun.isFullRun,
        status: finalStatus,
      });

      runEventBus.cleanup(id);
    } else {
      // Not all shards done yet — publish progress update
      runEventBus.publish(id, {
        type: 'run-progress',
        data: {
          totalTests: updatedRun?.totalTests ?? testRun.totalTests,
          passedTests: updatedRun?.passedTests ?? testRun.passedTests,
          failedTests: updatedRun?.failedTests ?? testRun.failedTests,
          skippedTests: updatedRun?.skippedTests ?? testRun.skippedTests,
          didNotRunTests: updatedRun?.didNotRunTests ?? testRun.didNotRunTests,
          shardsFinished: updatedRun?.shardsFinished ?? 0,
          shardTotal: updatedRun?.shardTotal,
        },
      });
    }

    return {
      success: true,
      runId: id,
      status: finalStatus ?? 'running',
    };
  }

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
