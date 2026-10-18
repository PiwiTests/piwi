import { eq } from 'drizzle-orm';
import { apiError } from './api-error';
import { testRuns } from '../database/schema';
import { runEventBus } from './run-events';
import { validateAndReviveRun } from './revive-run';
import { matchesShardToken, matchesStreamToken, readShardTokensFromMeta } from './shard-tokens';
import type { DbClient as DB } from '../database';

/**
 * Authorize a streaming request by its stream token and return the run's `projectId`.
 *
 * Fast path: when the run is cached in memory (warm), validate the token against
 * the cached main/shard tokens with no DB round-trip. On a cache miss — server
 * restart, or an interrupted run being revived — it falls back to a full DB
 * lookup + `validateAndReviveRun`, then warms the cache so subsequent requests
 * skip the SELECT.
 *
 * Shared by the `events` and `heartbeat` endpoints, which need identical token
 * validation. Throws 404 if the run doesn't exist, 403 on an invalid token.
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
