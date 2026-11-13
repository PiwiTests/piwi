import { randomBytes } from 'node:crypto';
import { getDatabase } from '../../database';
import { testRuns, type User } from '../../database/schema';
import { eq, sql } from 'drizzle-orm';
import { requireAuth } from '../../utils/auth';
import { runReporterId } from '../../utils/run-viewer';
import { cancelInstanceRuns } from '../../utils/cancel-instance-runs';
import { sanitizeMetadata } from '../../utils/sanitize';
import { resolveRunBranch } from '../../utils/run-branch';
import { runCommit, runOrigin, withRequestOrigin } from '#shared/run-eligibility';
import { checkRequestToken, grantedProject, presentsRequestToken, spendRequestToken } from '../../utils/request-tokens';
import { runEventBus } from '../../utils/run-events';
import { pinProjectRepository } from '../../utils/scm/project-repository';
import { persistShardToken, shardTokenDigest, streamTokenDigest } from '../../utils/shard-tokens';
import { getProjectScope } from '../../utils/project-access';
import { withInstanceRunLock } from '../../utils/ingest-locks';
import { findActiveShardedRun } from '../../utils/sharded-runs';
import { resolveIngestProject } from '../../utils/ingest-project';
import { applyReporterKeep } from '#shared/handlers/run-keep';
import { publicRunUrl } from '#shared/run-url';
import { saveEnvironmentSnapshots } from '#shared/handlers/environment-snapshots';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Start a streaming test run',
    description:
      'Start a new streaming test run directly in "running" status. Returns a stream token for authenticating subsequent streaming event submissions. The answer names the run’s page (`runUrl`): under `PIWI_SITE_URL` when it is set, else as a path under the address the client reached. Cancels the runs of the same instance still initializing or running; a finalizing one settles on its own. Supports sharded runs: when shardTotal > 1, reuses an existing run from the same instanceId and shardTotal.',
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
              reporterVersion: {
                type: 'string',
                description:
                  'The reporter’s version. From 0.65.0 the run’s `events`, `finish` and `live-resources` carry its token in the `X-Piwi-Run-Token` header too, and a request without it is refused.',
              },
            },
            required: ['projectName'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  // A request token starts its request's run, checked once the body is read and spent once the run is stored, so a
  // refused or failed start leaves it to a retry; otherwise `run:submit` on at least one project, from the route meta,
  // and the project itself is checked below.
  const signedIn = presentsRequestToken(event) ? null : await requireAuth(event);

  const body = await readBody(event);

  // Validate required fields
  if (!body.projectName) {
    throw apiError({
      statusCode: 400,
      message: 'Missing required field: projectName',
    });
  }
  const grant = await checkRequestToken(event, body);
  const user = (grant ? grant.requester : signedIn) as User;

  const db = await getDatabase();
  const project = grant
    ? await grantedProject(db, grant)
    : await resolveIngestProject(
        db,
        await getProjectScope(db, user as any, 'run:submit'),
        body.projectName,
        body.projectDescription,
      );

  // A requested run belongs to no instance: it cancels no other run, and no other run cancels it.
  const instanceId = grant ? null : body.instanceId || null;
  const shardTotal = body.shardTotal as number | undefined;
  const isSharded = !!(shardTotal && shardTotal > 1);

  return withInstanceRunLock(project.id, instanceId, async () => {
    if (isSharded && instanceId) {
      // Sharded run: look for an existing active run with the same instanceId and projectId
      const existingShardedRun = await findActiveShardedRun(db, project.id, instanceId, shardTotal!);

      if (existingShardedRun) {
        // Reuse the existing run — generate a fresh per-shard stream token
        const streamToken = randomBytes(32).toString('hex');
        runEventBus.addShardToken(existingShardedRun.id, streamToken);
        await persistShardToken(db, existingShardedRun.id, streamToken);

        // Each shard contributes its slice of the planned suite, so the run's
        // total is the sum across shards.
        if (body.totalTests) {
          await db
            .update(testRuns)
            .set({ totalTests: sql`${testRuns.totalTests} + ${body.totalTests}` })
            .where(eq(testRuns.id, existingShardedRun.id));
        }
        await applyReporterKeep(db, existingShardedRun.id, body.keep);
        await saveEnvironmentSnapshots(db, existingShardedRun.id, body.environments);

        return {
          success: true,
          runId: existingShardedRun.id,
          runUrl: publicRunUrl(existingShardedRun.id),
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
          reporterId: runReporterId(event, signedIn),
          instanceId,
          playwrightVersion: body.playwrightVersion || null,
          reporterVersion: body.reporterVersion || null,
          streamToken: streamTokenDigest(streamToken),
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
      await saveEnvironmentSnapshots(db, testRun.id, body.environments);
      await pinProjectRepository(db, project.id, metadata);
      runEventBus.publishGlobal({ type: 'run-started', runId: testRun.id, projectId: project.id });
      runEventBus.cacheRunState(testRun.id, {
        streamToken: streamTokenDigest(streamToken),
        projectId: project.id,
        shardTokens: new Set(),
      });

      return {
        success: true,
        runId: testRun.id,
        runUrl: publicRunUrl(testRun.id),
        projectId: project.id,
        streamToken,
      };
    }

    // Non-sharded: cancel previous runs, create a new one (existing behaviour)
    await cancelInstanceRuns(db, project.id, instanceId);

    const streamToken = randomBytes(32).toString('hex');
    const sanitized = sanitizeMetadata(body.metadata || null);
    const metadata = grant ? withRequestOrigin(sanitized, grant.requestId) : sanitized;

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
        requesterId: grant?.requester.id ?? null,
        reporterId: runReporterId(event, signedIn),
        instanceId,
        playwrightVersion: body.playwrightVersion || null,
        reporterVersion: body.reporterVersion || null,
        streamToken: streamTokenDigest(streamToken),
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

    // A requested run is never kept: retention and its requester remove it.
    if (grant) await spendRequestToken(db, grant, testRun.id);
    else await applyReporterKeep(db, testRun.id, body.keep);
    await saveEnvironmentSnapshots(db, testRun.id, body.environments);
    // A private run pins nothing of the project's.
    if (!grant) await pinProjectRepository(db, project.id, metadata);
    runEventBus.publishGlobal({ type: 'run-started', runId: testRun.id, projectId: project.id });
    runEventBus.cacheRunState(testRun.id, { streamToken: streamTokenDigest(streamToken), projectId: project.id });

    return {
      success: true,
      runId: testRun.id,
      runUrl: publicRunUrl(testRun.id),
      projectId: project.id,
      streamToken,
    };
  });
});
