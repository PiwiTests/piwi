import { testRuns } from '../database/schema';
import { apiError } from './api-error';
import { matchesStreamToken } from './shard-tokens';
import { eq } from 'drizzle-orm';
import type { DbClient as DB } from '../database';

/**
 * Validates the stream token for a test run. A run the stale-run cleanup marked
 * `interrupted` (no activity for 2 minutes) keeps its stream token, and a request
 * carrying that token, or one of the run's shard tokens, revives it to `running`.
 *
 * Throws a proper HTTP error on invalid state or token mismatch.
 * Mutates `testRun` in place on revival so callers see the updated state.
 *
 * @param isShardToken Optional callback for shard-aware token validation.
 */
export async function validateAndReviveRun(
  db: DB,
  runId: number,
  testRun: { status: string; streamToken: string | null },
  bodyStreamToken: string | null | undefined,
  isShardToken?: (token: string) => boolean,
): Promise<void> {
  const isInterrupted = testRun.status === 'interrupted';

  if (testRun.status !== 'running' && !isInterrupted) {
    throw apiError({
      statusCode: 409,
      message: 'Test run is not in running state',
    });
  }

  if (!bodyStreamToken) {
    throw apiError({
      statusCode: 403,
      message: 'Missing stream token',
    });
  }

  const valid = matchesStreamToken(testRun.streamToken, bodyStreamToken) || (isShardToken?.(bodyStreamToken) ?? false);
  if (!valid) {
    throw apiError({
      statusCode: 403,
      message: 'Invalid stream token',
    });
  }

  if (isInterrupted) {
    await db.update(testRuns).set({ status: 'running', updatedAt: new Date() }).where(eq(testRuns.id, runId));
    testRun.status = 'running';
  }
}
