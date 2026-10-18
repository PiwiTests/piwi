import { randomBytes } from 'node:crypto';
import { getDatabase } from '../../../database';
import { testRuns } from '../../../database/schema';
import { eq, sql } from 'drizzle-orm';
import { cancelInstanceRuns } from '../../../utils/cancel-instance-runs';
import { sanitizeMetadata } from '../../../utils/sanitize';
import { carryIngestHealth } from '#shared/ingest-health';
import { resolveRunBranch } from '../../../utils/run-branch';
import { runCommit, runOrigin } from '#shared/run-eligibility';
import { runEventBus } from '../../../utils/run-events';
import {
  knownShardTokens,
  matchesShardToken,
  matchesStreamToken,
  shardTokenDigest,
  streamTokenDigest,
  withShardTokens,
} from '../../../utils/shard-tokens';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Transition test run from initializing to running',
    description:
      'Begins a streaming test run by transitioning it from "initializing" to "running" status. Requires the setup token returned by the setup endpoint, which it accepts once. Supports sharded runs: every shard begins with its own setup token, and a shard beginning a run another shard already began joins it with a stream token of its own.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              setupToken: { type: 'string' },
              totalTests: { type: 'integer' },
              metadata: { type: 'object' },
              shardIndex: { type: 'integer' },
              shardTotal: { type: 'integer' },
            },
            required: ['setupToken'],
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

  // Validate setup token
  if (!body.setupToken) {
    throw apiError({
      statusCode: 401,
      message: 'Missing setup token',
    });
  }

  const db = await getDatabase();

  // Verify the run exists and the setup token matches
  const testRunResults = await db.select().from(testRuns).where(eq(testRuns.id, id));
  const testRun = testRunResults[0];

  if (!testRun) {
    throw apiError({
      statusCode: 404,
      message: 'Test run not found',
    });
  }

  const isSharded = !!(testRun.shardTotal && testRun.shardTotal > 1);

  // A sharded run also takes a shard that begins after the stale-run sweep marked
  // it interrupted: that shard's events revive it.
  const canBegin =
    testRun.status === 'initializing' ||
    testRun.status === 'running' ||
    (isSharded && testRun.status === 'interrupted');

  if (!canBegin) {
    throw apiError({
      statusCode: 409,
      message: 'Test run cannot be transitioned to running state',
    });
  }

  // A sharded run accepts the setup token of any of its shards, held in memory
  // or only in the run's metadata.
  const isValidShardSetupToken =
    isSharded &&
    matchesShardToken(knownShardTokens(runEventBus.getRunState(id)?.shardTokens, testRun.metadata), body.setupToken);

  if (!matchesStreamToken(testRun.streamToken, body.setupToken) && !isValidShardSetupToken) {
    throw apiError({
      statusCode: 403,
      message: 'Invalid setup token',
    });
  }

  // Generate a new stream token for the running phase
  const streamToken = randomBytes(32).toString('hex');

  if (testRun.status === 'initializing') {
    // First shard to begin: cancel other runs, transition to running
    await cancelInstanceRuns(db, testRun.projectId, testRun.instanceId, id, isSharded);

    // A shard's stream token is one of the run's shard tokens, so two shards that
    // begin at once both keep theirs. The set is cached before the write, so a
    // shard token registered while the write runs joins it.
    const shardTokens = isSharded ? swapShardToken(id, testRun.metadata, body.setupToken, streamToken) : undefined;
    runEventBus.cacheRunState(id, {
      streamToken: streamTokenDigest(streamToken),
      projectId: testRun.projectId,
      ...(shardTokens ? { shardTokens } : {}),
    });

    const metadata = carryIngestHealth(sanitizeMetadata(body.metadata || testRun.metadata), testRun.metadata);

    await db
      .update(testRuns)
      .set({
        status: 'running',
        streamToken: streamTokenDigest(streamToken),
        totalTests: body.totalTests || 0,
        metadata: shardTokens ? withShardTokens(metadata, shardTokens) : metadata,
        origin: runOrigin(metadata),
        commit: runCommit(metadata),
        branch: resolveRunBranch(body.metadata) ?? testRun.branch,
        playwrightVersion: body.playwrightVersion || testRun.playwrightVersion,
        reporterVersion: body.reporterVersion || testRun.reporterVersion,
        isFullRun: body.isFullRun !== false ? 1 : 0,
        filterDetails: body.filterDetails ?? testRun.filterDetails,
        ...(isSharded ? { shardTotal: testRun.shardTotal, shardsFinished: testRun.shardsFinished } : {}),
      })
      .where(eq(testRuns.id, id));

    runEventBus.publishGlobal({ type: 'run-started', runId: testRun.id, projectId: testRun.projectId });
  } else if (isSharded) {
    // Another shard began the run: this shard streams on a token of its own and
    // adds its slice of the planned suite to the run's total.
    const shardTokens = swapShardToken(id, testRun.metadata, body.setupToken, streamToken);
    const cachedState = runEventBus.getRunState(id);
    if (cachedState) runEventBus.cacheRunState(id, { ...cachedState, shardTokens });

    await db
      .update(testRuns)
      .set({
        metadata: withShardTokens(testRun.metadata, shardTokens),
        origin: runOrigin(testRun.metadata),
        commit: runCommit(testRun.metadata),
        ...(body.totalTests ? { totalTests: sql`${testRuns.totalTests} + ${body.totalTests}` } : {}),
        updatedAt: new Date(),
      })
      .where(eq(testRuns.id, id));
  } else {
    // Run is already running and the caller presented its stream token: hand
    // the same token back so the caller can continue streaming. This can happen
    // when multiple worker processes race to /begin on the same run (parallel
    // self-monitoring).
    return {
      success: true,
      runId: testRun.id,
      projectId: testRun.projectId,
      streamToken: body.setupToken,
    };
  }

  return {
    success: true,
    runId: testRun.id,
    projectId: testRun.projectId,
    streamToken,
  };
});

/**
 * A sharded run's shard tokens, from memory and its metadata, with the setup
 * token a shard spent on `/begin` swapped for the stream token it was handed.
 * The other shards' setup tokens stay.
 */
function swapShardToken(runId: number, metadata: unknown, setupToken: string, streamToken: string): Set<string> {
  const tokens = knownShardTokens(runEventBus.getRunState(runId)?.shardTokens, metadata);
  tokens.delete(shardTokenDigest(setupToken));
  tokens.add(shardTokenDigest(streamToken));
  return tokens;
}
