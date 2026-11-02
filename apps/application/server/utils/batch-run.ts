import { eq } from 'drizzle-orm';
import { testRuns } from '../database/schema';
import type { DbClient } from '../database';
import { apiError } from './api-error';
import { cancelInstanceRuns } from './cancel-instance-runs';
import { withPendingStatus } from './finalizing-runs';
import { persistRunCases } from './persist-run-cases';
import { mapWireCaseToRunCase } from './map-wire-case';
import { resolveRunBranch } from './run-branch';
import { storeOrDiscardRun } from './run-deliveries';
import { storableRunErrors } from './storable-values';
import { sanitizeMetadata } from './sanitize';
import { countFlakyBatchCases } from './sharded-runs';
import { streamTokenDigest } from './shard-tokens';
import { runCommit, runOrigin } from '#shared/run-eligibility';
import { sumFailedAndTimedOut } from '#shared/utils/test-counts';
import { durationStats } from '#shared/utils/stats';
import { applyReporterKeep } from '#shared/handlers/run-keep';
import { sanitizeResourceReport } from '#shared/resource-report';
import { saveResourceReportPart } from '#shared/handlers/resource-reports';
import type { TestRunSubmitPayload } from '#shared/types';

/**
 * Create the run of a batch delivery that joins no sharded run (`/submit`, `/upload/results`): it replaces the
 * instance's run still in flight (`cancelInstanceRuns`), and its executions are stored, then its flaky count and
 * duration statistics. When the executions fail to store, the run is removed and the error goes on
 * (`storeOrDiscardRun`).
 *
 * `awaitingFiles` holds the run `finalizing` until its files are in: the status the delivery sent waits in its
 * metadata (`withPendingStatus`), and the run keeps the digest of the stream token its files go with
 * (`/case-files`). An upload with `runId` settles it (`settleFinalizingRun`), or the stale-run sweep does.
 *
 * Returns the run as inserted.
 */
export async function createBatchRun(
  db: DbClient,
  projectId: number,
  body: TestRunSubmitPayload,
  awaitingFiles?: { streamToken: string },
): Promise<typeof testRuns.$inferSelect> {
  const shardTotal = body.shardTotal;
  const instanceId = body.instanceId || null;
  const isSharded = !!(shardTotal && shardTotal > 1);
  const testCases = Array.isArray(body.testCases) ? body.testCases : [];

  await cancelInstanceRuns(db, projectId, instanceId, undefined, isSharded);

  const sanitized = sanitizeMetadata(body.metadata || null);
  const metadata = awaitingFiles ? withPendingStatus(sanitized, body.status) : sanitized;
  const testRunResult = await db
    .insert(testRuns)
    .values({
      projectId,
      status: awaitingFiles ? 'finalizing' : body.status,
      startTime: new Date(body.startTime),
      duration: body.duration || null,
      totalTests: body.totalTests || 0,
      passedTests: body.passedTests || 0,
      failedTests: sumFailedAndTimedOut(body.failedTests, body.timedOutTests),
      skippedTests: body.skippedTests || 0,
      didNotRunTests: body.didNotRunTests || 0,
      environment: body.environment || null,
      branch: resolveRunBranch(body.metadata),
      label: body.label || null,
      metadata,
      origin: runOrigin(metadata),
      commit: runCommit(metadata),
      instanceId,
      playwrightVersion: body.playwrightVersion || null,
      reporterVersion: body.reporterVersion || null,
      ...(awaitingFiles && { streamToken: streamTokenDigest(awaitingFiles.streamToken) }),
      shardTotal: isSharded ? shardTotal : null,
      shardIndex: isSharded ? (body.shardIndex ?? null) : null,
      shardsFinished: isSharded ? 0 : undefined,
      isFullRun: body.isFullRun !== false ? 1 : 0,
      filterDetails: body.filterDetails ?? null,
      ...(body.setupSteps && { setupSteps: body.setupSteps }),
      runErrors: storableRunErrors(body.runErrors),
    })
    .returning();

  const testRun = testRunResult[0];

  if (!testRun) {
    throw apiError({
      statusCode: 500,
      message: 'Failed to create test run',
    });
  }
  const incomingResources = sanitizeResourceReport(body.resourceReport);
  if (incomingResources) await saveResourceReportPart(db, testRun.id, incomingResources);
  await applyReporterKeep(db, testRun.id, body.keep);

  // Insert test cases if provided and calculate flaky tests
  let flakyTestCount = 0;
  if (testCases.length > 0) {
    flakyTestCount = countFlakyBatchCases(testCases);

    await storeOrDiscardRun(db, testRun.id, () =>
      persistRunCases(db, projectId, testRun.id, testCases.map(mapWireCaseToRunCase)),
    );
  }

  // Update test run with flaky test count if any were found
  if (flakyTestCount > 0) {
    await db.update(testRuns).set({ flakyTests: flakyTestCount }).where(eq(testRuns.id, testRun.id));
  }

  // Compute and store performance summary (avgTestDuration, p90TestDuration)
  if (testCases.length > 0) {
    const stats = durationStats(testCases.map((tc) => tc.duration));
    if (stats) {
      await db
        .update(testRuns)
        .set({ avgTestDuration: stats.avg, p90TestDuration: stats.p90 })
        .where(eq(testRuns.id, testRun.id));
    }
  }

  return testRun;
}
