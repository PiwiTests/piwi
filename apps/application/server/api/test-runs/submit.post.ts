import { eq } from 'drizzle-orm';
import { getDatabase } from '../../database';
import { testRuns } from '../../database/schema';
import { requireAuth } from '../../utils/auth';
import { parseLocation } from '#shared/parse-location';
import { persistRunCases, type RunCaseInput } from '../../utils/persist-run-cases';
import { sanitizeMetadata } from '../../utils/sanitize';
import { resolveRunBranch } from '../../utils/run-branch';
import { runCommit, runOrigin } from '#shared/run-eligibility';
import { runEventBus } from '../../utils/run-events';
import {
  addBatchShard,
  batchShardRun,
  batchShardTally,
  finalizeShardedRun,
  publishShardProgress,
} from '../../utils/sharded-runs';
import { cancelInstanceRuns } from '../../utils/cancel-instance-runs';
import { runFinalizeSideEffects } from '../../utils/run-finalize-side-effects';
import { getProjectScope } from '../../utils/project-access';
import { resolveIngestProject } from '../../utils/ingest-project';
import { sumFailedAndTimedOut } from '#shared/utils/test-counts';
import { applyReporterKeep } from '#shared/handlers/run-keep';
import { sanitizeResourceReport } from '#shared/resource-report';
import { saveResourceReportPart } from '#shared/handlers/resource-reports';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Submit test results as JSON',
    description:
      'Submit Playwright test run results as a JSON payload. Creates or updates a project, test run, and test cases. Supports sharded runs via shardIndex / shardTotal.',
    'x-required-permission': 'run:submit',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              projectName: { type: 'string' },
              status: { type: 'string' },
              startTime: { type: 'string', format: 'date-time' },
              shardIndex: { type: 'integer' },
              shardTotal: { type: 'integer' },
            },
            required: ['projectName', 'status', 'startTime'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  // `run:submit` on at least one project, from the route meta; the project itself is checked below.
  const user = await requireAuth(event);

  const body = await readBody(event);

  // Validate required fields
  if (!body.projectName || !body.status || !body.startTime) {
    throw apiError({
      statusCode: 400,
      message: 'Missing required fields: projectName, status, startTime',
    });
  }

  const incomingResources = sanitizeResourceReport(body.resourceReport);

  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any, 'run:submit');

  const project = await resolveIngestProject(db, scope, body.projectName, body.projectDescription);

  const shardTotal = body.shardTotal as number | undefined;
  const instanceId = body.instanceId || null;
  const isSharded = !!(shardTotal && shardTotal > 1);

  const testCases: any[] = Array.isArray(body.testCases) ? body.testCases : [];

  if (isSharded && instanceId) {
    // A shard of a batch run: its executions join the run its instance's shards
    // share, and the last shard to arrive settles it.
    const run = await batchShardRun(db, project.id, instanceId, body);
    if (incomingResources) await saveResourceReportPart(db, run.id, incomingResources);
    await applyReporterKeep(db, run.id, body.keep);
    if (testCases.length > 0) await persistRunCases(db, project.id, run.id, testCases.map(toRunCase));
    await addBatchShard(db, run.id, batchShardTally(body, testCases));
    if (!(await finalizeShardedRun(db, run.id, 'run-submitted'))) await publishShardProgress(db, run.id);
    return { success: true, runId: run.id, projectId: project.id };
  }

  // A run of its own: not sharded, or sharded with no instance id to join its shards by
  await cancelInstanceRuns(db, project.id, instanceId, undefined, isSharded);

  const metadata = sanitizeMetadata(body.metadata || null);
  const testRunResult = await db
    .insert(testRuns)
    .values({
      projectId: project.id,
      status: body.status,
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
      shardTotal: isSharded ? shardTotal : null,
      shardIndex: isSharded ? ((body.shardIndex as number | undefined) ?? null) : null,
      shardsFinished: isSharded ? 0 : undefined,
      isFullRun: body.isFullRun !== false ? 1 : 0,
      filterDetails: body.filterDetails ?? null,
    })
    .returning();

  const testRun = testRunResult[0];

  if (!testRun) {
    throw apiError({
      statusCode: 500,
      message: 'Failed to create test run',
    });
  }
  if (incomingResources) await saveResourceReportPart(db, testRun.id, incomingResources);
  await applyReporterKeep(db, testRun.id, body.keep);

  // Insert test cases if provided and calculate flaky tests
  let flakyTestCount = 0;
  if (body.testCases && Array.isArray(body.testCases) && body.testCases.length > 0) {
    flakyTestCount = body.testCases.filter(
      (testCase: { status: string; retries?: number }) => testCase.status === 'passed' && (testCase.retries || 0) > 0,
    ).length;

    const cases: RunCaseInput[] = body.testCases.map(toRunCase);

    await persistRunCases(db, project.id, testRun.id, cases);
  }

  // Update test run with flaky test count if any were found
  if (flakyTestCount > 0) {
    await db.update(testRuns).set({ flakyTests: flakyTestCount }).where(eq(testRuns.id, testRun.id));
  }

  // Compute and store performance summary (avgTestDuration, p90TestDuration)
  if (body.testCases && Array.isArray(body.testCases) && body.testCases.length > 0) {
    const stats = durationStats(body.testCases.map((tc: { duration?: number | null }) => tc.duration));
    if (stats) {
      await db
        .update(testRuns)
        .set({ avgTestDuration: stats.avg, p90TestDuration: stats.p90 })
        .where(eq(testRuns.id, testRun.id));
    }
  }

  runEventBus.publishGlobal({ type: 'run-submitted', runId: testRun.id, projectId: project.id, status: body.status });

  await runFinalizeSideEffects(db, testRun.id, {
    projectId: project.id,
    metadata: testRun.metadata,
    isFullRun: testRun.isFullRun,
    status: testRun.status,
  });

  return {
    success: true,
    runId: testRun.id,
    projectId: project.id,
  };
});

/** A submitted test case, as `persistRunCases` stores it. */
function toRunCase(testCase: any): RunCaseInput {
  const { filePath, line, column } = testCase.location
    ? parseLocation(testCase.location)
    : { filePath: 'unknown', line: null, column: null };
  return {
    filePath,
    suitePath: testCase.suitePath ?? null,
    suiteConfig: testCase.suiteConfig ?? null,
    testAnnotations: testCase.testAnnotations ?? null,
    tags: testCase.tags ?? null,
    locks: testCase.locks ?? null,
    testMeta: testCase.testMeta ?? null,
    title: testCase.title,
    status: testCase.status,
    duration: testCase.duration,
    timeout: testCase.timeout,
    error: testCase.error,
    retries: testCase.retries,
    attempts: testCase.attempts ?? null,
    line,
    column,
    steps: testCase.steps,
    stepEvents: testCase.stepEvents,
    slowestStep: testCase.slowestStep,
    slowestStepDuration: testCase.slowestStepDuration,
    wastedTimeMs: testCase.wastedTimeMs,
    networkRequests: testCase.networkRequests,
    webVitals: testCase.webVitals,
    pageState: testCase.pageState,
    pageInventory: testCase.pageInventory,
    locatorPages: testCase.locatorPages,
    codeReach: testCase.codeReach,
    coverage: testCase.coverage,
    resources: testCase.resources ?? null,
    aiUsage: testCase.aiUsage,
    consoleLogs: testCase.consoleLogs,
    dialogs: testCase.dialogs,
    ariaSnapshot: testCase.ariaSnapshot as string | null | undefined,
    ariaSnapshotJson: testCase.ariaSnapshotJson as string | null | undefined,
    testSource: testCase.testSource ?? null,
    testSourceFrames: testCase.testSourceFrames ?? null,
    workerIndex: testCase.workerIndex,
    shardIndex: testCase.shardIndex ?? null,
    startedAt: testCase.startedAt ?? null,
    browser: testCase.browser ?? null,
    locatorSnapshots: testCase.locatorSnapshots ?? null,
    didNotRunReason: testCase.didNotRunReason ?? null,
    expectedStatus: testCase.expectedStatus ?? null,
    blockedBy: testCase.blockedBy ?? null,
  };
}
