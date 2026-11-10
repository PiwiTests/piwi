import { randomBytes } from 'node:crypto';
import { getDatabase } from '../../database';
import { testRuns, type User } from '../../database/schema';
import { requireAuth } from '../../utils/auth';
import { cancelInstanceRuns } from '../../utils/cancel-instance-runs';
import { runEventBus } from '../../utils/run-events';
import { persistShardToken, shardTokenDigest, streamTokenDigest, withShardSetupTokens } from '../../utils/shard-tokens';
import { getProjectScope } from '../../utils/project-access';
import { withInstanceRunLock } from '../../utils/ingest-locks';
import { findActiveShardedRun } from '../../utils/sharded-runs';
import { resolveIngestProject } from '../../utils/ingest-project';
import { applyReporterKeep } from '#shared/handlers/run-keep';
import { resolveRunBranch } from '../../utils/run-branch';
import { runCommit, runOrigin, withRequestOrigin } from '#shared/run-eligibility';
import { checkRequestToken, grantedProject, presentsRequestToken, spendRequestToken } from '../../utils/request-tokens';
import { liveViewRelay, storeLiveViewKey } from '../../utils/live-view';
import { publicRunUrl } from '#shared/run-url';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Initialize a streaming test run in setup phase',
    description:
      'Initialize a new streaming test run in "initializing" status. Returns a setup token to be used by the begin endpoint to transition the run to "running" status. The answer names the run’s page (`runUrl`): under `PIWI_SITE_URL` when it is set, else as a path under the address the client reached. Cancels the runs of the same instance still initializing or running; a finalizing one settles on its own. Supports sharded runs: when shardTotal > 1, a shard joins the initializing or running run of its instanceId and shardTotal. With `liveView: true`, a project that turned its live view on also gets `liveView.key`, a key of this run alone that its test workers hold their live view stream with: the workers of a CI run at once, those of a run outside CI only once its developer shares it. It opens nothing else and ends with the run; the run keeps its digest, never the key, so an instance started again takes it back while the run lasts. The desktop app, which no teammate reaches, gives none and answers `liveView.refused: local` instead.',
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
              reporterVersion: {
                type: 'string',
                description:
                  'The reporter’s version. From 0.65.0 the run’s `begin`, `events`, `finish` and `live-resources` carry its token in the `X-Piwi-Run-Token` header too, and a request without it is refused.',
              },
              liveView: {
                type: 'boolean',
                description: 'Ask for a live view key, which a project with the live view on gives',
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
  /**
   * The run's live view key for its workers, when the reporter asks and the project turned the live view on, its
   * digest kept with the run. The desktop app gives none, saying why: no teammate reaches it.
   */
  const liveViewOf = async (runId: number) => {
    if (body.liveView !== true || grant) return {};
    if (process.env.PIWI_DESKTOP_TOKEN) return { liveView: { refused: 'local' } };
    const key = project.liveView ? liveViewRelay.mintKey(runId, project.id) : null;
    if (!key) return {};
    await storeLiveViewKey(db, runId, key);
    return { liveView: { key } };
  };
  const shardTotal = body.shardTotal as number | undefined;
  const isSharded = !!(shardTotal && shardTotal > 1);

  return withInstanceRunLock(project.id, instanceId, async () => {
    if (isSharded && instanceId) {
      // Sharded setup: join the run another shard of the same instanceId set up,
      // whether it is still initializing or that shard already began it
      const existingShardedRun = await findActiveShardedRun(db, project.id, instanceId, shardTotal!);

      if (existingShardedRun) {
        // Reuse — return existing runId with a fresh setup token
        const setupToken = randomBytes(32).toString('hex');
        runEventBus.addShardToken(existingShardedRun.id, setupToken);
        await persistShardToken(db, existingShardedRun.id, setupToken, { setup: true });
        await applyReporterKeep(db, existingShardedRun.id, body.keep);

        return {
          success: true,
          runId: existingShardedRun.id,
          runUrl: publicRunUrl(existingShardedRun.id),
          projectId: project.id,
          setupToken,
          ...(await liveViewOf(existingShardedRun.id)),
        };
      }

      // First shard: cancel non-sharded runs, create sharded run
      await cancelInstanceRuns(db, project.id, instanceId, undefined, true);

      const setupToken = randomBytes(32).toString('hex');
      const digest = shardTokenDigest(setupToken);
      // The shard is in its global setup until its `/begin` spends the token.
      const metadata = withShardSetupTokens({ shardTokens: [digest] }, [digest]);

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
        runUrl: publicRunUrl(testRun.id),
        projectId: project.id,
        setupToken,
        ...(await liveViewOf(testRun.id)),
      };
    }

    // Non-sharded: existing behaviour
    await cancelInstanceRuns(db, project.id, instanceId);

    const setupToken = randomBytes(32).toString('hex');
    const requestMetadata = grant ? withRequestOrigin(null, grant.requestId) : null;

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
        metadata: requestMetadata,
        origin: runOrigin(requestMetadata),
        commit: runCommit(requestMetadata),
        requesterId: grant?.requester.id ?? null,
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

    // A requested run is never kept: retention and its requester remove it.
    if (grant) await spendRequestToken(db, grant, testRun.id);
    else await applyReporterKeep(db, testRun.id, body.keep);
    runEventBus.publishGlobal({ type: 'run-initializing', runId: testRun.id, projectId: project.id });

    return {
      success: true,
      runId: testRun.id,
      runUrl: publicRunUrl(testRun.id),
      projectId: project.id,
      setupToken,
      ...(await liveViewOf(testRun.id)),
    };
  });
});
