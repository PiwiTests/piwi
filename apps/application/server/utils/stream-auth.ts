import { eq } from 'drizzle-orm';
import { apiError } from './api-error';
import { testRuns } from '../database/schema';
import { runEventBus } from './run-events';
import { validateAndReviveRun } from './revive-run';
import { knownShardTokens, matchesShardToken, matchesStreamToken, readShardTokensFromMeta } from './shard-tokens';
import type { DbClient as DB } from '../database';

/** The streaming routes whose token travels in the body. */
export type BodyTokenRoute = 'begin' | 'events' | 'finish' | 'live-resources';

/** The first reporter release that also sends a streaming run's token in `RUN_TOKEN_HEADER`. */
const RUN_TOKEN_HEADER_SINCE = [0, 65, 0];

/**
 * Whether the reporter of `reporterVersion` sends a streaming run's token in `RUN_TOKEN_HEADER`: 0.65.0 or later, a
 * prerelease counting as its release. A version that is missing or not `major.minor.patch` counts as older.
 */
export function sendsRunTokenHeader(reporterVersion: string | null | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(reporterVersion ?? '');
  if (!match) return false;
  for (const [i, since] of RUN_TOKEN_HEADER_SINCE.entries()) {
    const part = Number(match[i + 1]);
    if (part !== since) return part > since;
  }
  return true;
}

/**
 * Refuse a streaming request before its route reads the body that carries its token, with the answer the route gives
 * once it read it.
 *
 * - 404 for a run that does not exist, 409 for one the route does not take: `begin` takes an initializing or running
 *   run, or an interrupted sharded one; the others take a running or interrupted run, and `events` and
 *   `live-resources` any run in the run cache, which `authorizeStreamToken` trusts.
 * - The token in `RUN_TOKEN_HEADER`, `header`, is checked as the body's is, against the same tokens: 403 when it is
 *   not the run's (its setup token for `begin`), 401 when it is missing or empty and the run's reporter sends it
 *   (`sendsRunTokenHeader`). The token of a run whose reporter does not send it is checked once the body is read.
 */
export async function requireStreamingRun(
  db: DB,
  runId: number,
  route: BodyTokenRoute,
  header: string | undefined,
): Promise<void> {
  const presented = header || undefined;
  const begin = route === 'begin';
  const invalid = () => apiError({ statusCode: 403, message: begin ? 'Invalid setup token' : 'Invalid stream token' });
  const cached = route === 'events' || route === 'live-resources' ? runEventBus.getRunState(runId) : undefined;
  if (cached && presented !== undefined) {
    if (!matchesStreamToken(cached.streamToken, presented) && !matchesShardToken(cached.shardTokens, presented)) {
      throw invalid();
    }
    return;
  }

  const [run] = await db
    .select({
      status: testRuns.status,
      shardTotal: testRuns.shardTotal,
      streamToken: testRuns.streamToken,
      metadata: testRuns.metadata,
      reporterVersion: testRuns.reporterVersion,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .limit(1);
  // A run in the run cache takes the request without a row, as `authorizeStreamToken` does.
  if (!run && cached) return;
  if (!run) throw apiError({ statusCode: 404, message: 'Test run not found' });
  const sharded = !!(run.shardTotal && run.shardTotal > 1);
  if (begin) {
    if (run.status !== 'initializing' && run.status !== 'running' && !(sharded && run.status === 'interrupted')) {
      throw apiError({ statusCode: 409, message: 'Test run cannot be transitioned to running state' });
    }
  } else if (!cached && run.status !== 'running' && run.status !== 'interrupted') {
    throw apiError({ statusCode: 409, message: 'Test run is not in running state' });
  }

  if (presented === undefined) {
    if (!sendsRunTokenHeader(run.reporterVersion)) return;
    throw apiError({ statusCode: 401, message: begin ? 'Missing setup token' : 'Missing stream token' });
  }
  // The shard tokens each route checks the body's token against.
  const shardTokens = !sharded
    ? undefined
    : begin
      ? knownShardTokens(runEventBus.getRunState(runId)?.shardTokens, run.metadata)
      : readShardTokensFromMeta(run.metadata);
  if (!matchesStreamToken(run.streamToken, presented) && !matchesShardToken(shardTokens, presented)) throw invalid();
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
