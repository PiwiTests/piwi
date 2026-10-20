import { randomBytes } from 'node:crypto';
import { getDatabase } from '../../database';
import { testRuns } from '../../database/schema';
import { requireAuth } from '../../utils/auth';
import { cancelInstanceRuns } from '../../utils/cancel-instance-runs';
import { runEventBus } from '../../utils/run-events';
import { persistShardToken, shardTokenDigest, streamTokenDigest } from '../../utils/shard-tokens';
import { getProjectScope } from '../../utils/project-access';
import { withInstanceRunLock } from '../../utils/ingest-locks';
import { findActiveShardedRun } from '../../utils/sharded-runs';
import { resolveIngestProject } from '../../utils/ingest-project';
import { applyReporterKeep } from '#shared/handlers/run-keep';
import { resolveRunBranch } from '../../utils/run-branch';
import { runCommit, runOrigin } from '#shared/run-eligibility';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Initialize a streaming test run in setup phase',
    description:
      'Initialize a new streaming test run in "initializing" status. Returns a setup token to be used by the begin endpoint to transition the run to "running" status. Cancels any previous runs from the same instance. Supports sharded runs: when shardTotal > 1, a shard joins the initializing or running run of its instanceId.',
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

  return withInstanceRunLock(project.id, instanceId, async () => {
    if (isSharded && instanceId) {
      // Sharded setup: join the run another shard of the same instanceId set up,
      // whether it is still initializing or that shard already began it
      const existingShardedRun = await findActiveShardedRun(db, project.id, instanceId);

      if (existingShardedRun) {
        // Reuse — return existing runId with a fresh setup token
        const setupToken = randomBytes(32).toString('hex');
        runEventBus.addShardToken(existingShardedRun.id, setupToken);
        await persistShardToken(db, existingShardedRun.id, setupToken);
        await applyReporterKeep(db, existingShardedRun.id, body.keep);

        return {
          success: true,
          runId: existingShardedRun.id,
          projectId: project.id,
          setupToken,
        };
      }

      // First shard: cancel non-sharded runs, create sharded run
      await cancelInstanceRuns(db, project.id, instanceId, undefined, true);

      const setupToken = randomBytes(32).toString('hex');
      const metadata = { shardTokens: [shardTokenDigest(setupToken)] } as Record<string, unknown>;

      const testRunResult = await db
        .insert(testRuns)
        .values({
          projectId: project.id,
          status: 'initializing',
          startTime: new Date(body.startTime || new Date().toISOString()),
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
          streamToken: streamTokenDigest(setupToken),
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
      runEventBus.publishGlobal({ type: 'run-initializing', runId: testRun.id, projectId: project.id });
      runEventBus.cacheRunState(testRun.id, {
        streamToken: streamTokenDigest(setupToken),
        projectId: project.id,
        shardTokens: new Set(),
      });

      return {
        success: true,
        runId: testRun.id,
        projectId: project.id,
        setupToken,
      };
    }

    // Non-sharded: existing behaviour
    await cancelInstanceRuns(db, project.id, instanceId);

    const setupToken = randomBytes(32).toString('hex');

    const testRunResult = await db
      .insert(testRuns)
      .values({
        projectId: project.id,
        status: 'initializing',
        startTime: new Date(body.startTime || new Date().toISOString()),
        duration: null,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        didNotRunTests: 0,
        environment: body.environment || null,
        branch: resolveRunBranch(body.metadata),
        label: body.label || null,
        metadata: null,
        origin: runOrigin(null),
        commit: runCommit(null),
        instanceId,
        playwrightVersion: body.playwrightVersion || null,
        reporterVersion: body.reporterVersion || null,
        streamToken: streamTokenDigest(setupToken),
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
    runEventBus.publishGlobal({ type: 'run-initializing', runId: testRun.id, projectId: project.id });

    return {
      success: true,
      runId: testRun.id,
      projectId: project.id,
      setupToken,
    };
  });
});
