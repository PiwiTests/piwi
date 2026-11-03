import { eq } from 'drizzle-orm';
import { apiError } from './api-error';
import { testRuns } from '../database/schema';
import { runEventBus } from './run-events';
import { validateAndReviveRun } from './revive-run';
import { matchesShardToken, matchesStreamToken, readShardTokensFromMeta } from './shard-tokens';
import type { DbClient as DB } from '../database';

/** The streaming routes whose token travels in the body. */
export type BodyTokenRoute = 'begin' | 'events' | 'finish' | 'live-resources';

/**
 * Refuse a streaming request before its route reads the body that carries its token, with the answer the route gives
 * once it read it: 404 for a run that does not exist, 409 for one the route does not take. `begin` takes an
 * initializing or running run, or an interrupted sharded one; the others take a running or interrupted run, and
 * `events` and `live-resources` any run in the run cache, which `authorizeStreamToken` trusts.
 */
export async function requireStreamingRun(db: DB, runId: number, route: BodyTokenRoute): Promise<void> {
  if ((route === 'events' || route === 'live-resources') && runEventBus.getRunState(runId)) return;
  const [run] = await db
    .select({ status: testRuns.status, shardTotal: testRuns.shardTotal })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .limit(1);
  if (!run) throw apiError({ statusCode: 404, message: 'Test run not found' });
  if (route === 'begin') {
    const sharded = !!(run.shardTotal && run.shardTotal > 1);
    if (run.status === 'initializing' || run.status === 'running' || (sharded && run.status === 'interrupted')) return;
    throw apiError({ statusCode: 409, message: 'Test run cannot be transitioned to running state' });
  }
  if (run.status !== 'running' && run.status !== 'interrupted') {
    throw apiError({ statusCode: 409, message: 'Test run is not in running state' });
  }
}

/**
 * Authorize a streaming request by its stream token and return the run's `projectId`.
 *
 * Fast path: when the run is cached in memory (warm), validate the token against
 * the cached main/shard tokens with no DB round-trip. Only a running run is
 * cached: every path that ends a run (its finish, its cancel by another run of
 * its instance, the stale-run sweep) drops it. On a cache miss — server
 * restart, an interrupted run being revived, a run that ended — it falls back
 * to a full DB lookup + `validateAndReviveRun`, then warms the cache so
 * subsequent requests skip the SELECT.
 *
 * Shared by the `events`, `heartbeat` and `live-resources` endpoints, which need
 * identical token validation. Throws 404 if the run doesn't exist, 409 when it
 * is no longer running, 403 on an invalid token.
 */
export async function authorizeStreamToken(db: DB, runId: number, streamToken: string): Promise<{ projectId: number }> {
  const cachedState = runEventBus.getRunState(runId);
  if (cachedState) {
    const valid =
      matchesStreamToken(cachedState.streamToken, streamToken) ||
      matchesShardToken(cachedState.shardTokens, streamToken);
    if (!valid) throw apiError({ statusCode: 403, message: 'Invalid stream token' });
    return { projectId: cachedState.projectId };
  }

  const testRunResults = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  const testRun = testRunResults[0];

  if (!testRun) throw apiError({ statusCode: 404, message: 'Test run not found' });

  const isSharded = !!(testRun.shardTotal && testRun.shardTotal > 1);
  const shardTokens = isSharded ? readShardTokensFromMeta(testRun.metadata) : undefined;
  const isShardToken = shardTokens ? (token: string) => matchesShardToken(shardTokens, token) : undefined;
  await validateAndReviveRun(db, runId, testRun, streamToken, isShardToken);

  // Warm the cache so subsequent requests skip this SELECT. The run's own token is
  // cached, not the presented one, which may be a shard's.
  if (testRun.streamToken) {
    runEventBus.cacheRunState(runId, { streamToken: testRun.streamToken, projectId: testRun.projectId, shardTokens });
  }
  return { projectId: testRun.projectId };
}
