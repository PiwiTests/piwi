import { randomBytes } from 'node:crypto';
import { getDatabase } from '../../database';
import { testRuns } from '../../database/schema';
import { eq, and, or, sql } from 'drizzle-orm';
import { requireAuth } from '../../utils/auth';
import { cancelInstanceRuns } from '../../utils/cancel-instance-runs';
import { sanitizeMetadata } from '../../utils/sanitize';
import { resolveRunBranch } from '../../utils/run-branch';
import { runCommit, runOrigin } from '#shared/run-eligibility';
import { runEventBus } from '../../utils/run-events';
import { persistShardToken, shardTokenDigest } from '../../utils/shard-tokens';
import { getProjectScope } from '../../utils/project-access';
import { resolveIngestProject } from '../../utils/ingest-project';
import { applyReporterKeep } from '#shared/handlers/run-keep';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Start a streaming test run',
    description:
      'Start a new streaming test run directly in "running" status. Returns a stream token for authenticating subsequent streaming event submissions. Cancels any previous runs from the same instance. Supports sharded runs: when shardTotal > 1, reuses an existing run from the same instanceId.',
    'x-required-permission': 'run:submit',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              projectName: { type: 'string' },
              startTime: { type: 'string', format: 'date-time' },
              environment: { type: 'string' },
              metadata: { type: 'object' },
              instanceId: { type: 'string' },
              shardIndex: { type: 'integer' },
              shardTotal: { type: 'integer' },
            },
            required: ['projectName'],
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
  if (!body.projectName) {
    throw apiError({
      statusCode: 400,
      message: 'Missing required field: projectName',
    });
  }

  const db = await getDatabase();
  const scope = await getProjectScope(db, user as any, 'run:submit');

  const project = await resolveIngestProject(db, scope, body.projectName, body.projectDescription);

  const instanceId = body.instanceId || null;
  const shardTotal = body.shardTotal as number | undefined;
  const isSharded = !!(shardTotal && shardTotal > 1);

  if (isSharded && instanceId) {
    // Sharded run: look for an existing active run with the same instanceId and projectId
    const existingRuns = await db
      .select()
      .from(testRuns)
      .where(
        and(
          eq(testRuns.projectId, project.id),
          eq(testRuns.instanceId, instanceId),
          or(eq(testRuns.status, 'running'), eq(testRuns.status, 'initializing')),
        ),
      );

    const existingShardedRun = existingRuns.find((r) => r.shardTotal && r.shardTotal > 1);

    if (existingShardedRun) {
      // Reuse the existing run — generate a fresh per-shard stream token
      const streamToken = randomBytes(32).toString('hex');
      runEventBus.addShardToken(existingShardedRun.id, streamToken);
      await persistShardToken(
        db,
        existingShardedRun.id,
        streamToken,
        existingShardedRun.metadata as Record<string, unknown> | null,
      );

      // Each shard contributes its slice of the planned suite, so the run's
      // total is the sum across shards.
      if (body.totalTests) {
        await db
          .update(testRuns)
          .set({ totalTests: sql`${testRuns.totalTests} + ${body.totalTests}` })
          .where(eq(testRuns.id, existingShardedRun.id));
      }
      await applyReporterKeep(db, existingShardedRun.id, body.keep);

      return {
        success: true,
        runId: existingShardedRun.id,
        projectId: project.id,
        streamToken,
      };
    }

    // First shard to arrive: cancel non-sharded runs, then create a new sharded run
    await cancelInstanceRuns(db, project.id, instanceId, undefined, true);

    const streamToken = randomBytes(32).toString('hex');
    const metadata = {
      ...(sanitizeMetadata(body.metadata ?? {}) ?? {}),
      shardTokens: [shardTokenDigest(streamToken)],
    } as Record<string, unknown>;

    const testRunResult = await db
      .insert(testRuns)
      .values({
        projectId: project.id,
        status: 'running',
        startTime: new Date(body.startTime || new Date().toISOString()),
        duration: null,
        totalTests: body.totalTests || 0,
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
        streamToken,
        shardTotal,
        shardIndex: body.shardIndex ?? null,
        shardsFinished: 0,
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

    await applyReporterKeep(db, testRun.id, body.keep);
    runEventBus.publishGlobal({ type: 'run-started', runId: testRun.id, projectId: project.id });
    runEventBus.cacheRunState(testRun.id, { streamToken, projectId: project.id, shardTokens: new Set() });

    return {
      success: true,
      runId: testRun.id,
      projectId: project.id,
      streamToken,
    };
  }

  // Non-sharded: cancel previous runs, create a new one (existing behaviour)
  await cancelInstanceRuns(db, project.id, instanceId);

  const streamToken = randomBytes(32).toString('hex');
  const metadata = sanitizeMetadata(body.metadata || null);

  const testRunResult = await db
    .insert(testRuns)
    .values({
      projectId: project.id,
      status: 'running',
      startTime: new Date(body.startTime || new Date().toISOString()),
      duration: null,
      totalTests: body.totalTests || 0,
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
      streamToken,
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

  await applyReporterKeep(db, testRun.id, body.keep);
  runEventBus.publishGlobal({ type: 'run-started', runId: testRun.id, projectId: project.id });
  runEventBus.cacheRunState(testRun.id, { streamToken, projectId: project.id });

  return {
    success: true,
    runId: testRun.id,
    projectId: project.id,
    streamToken,
  };
});
