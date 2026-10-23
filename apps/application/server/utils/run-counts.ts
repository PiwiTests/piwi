import { eq } from 'drizzle-orm';
import { testRunsCases } from '../database/schema';
import type { DbClient } from '../database';
import { distinctRunCountsFromAttempts } from '#shared/utils/test-counts';

/**
 * A run's counters, one per test result, computed from its persisted
 * `test_runs_cases` rows. The final attempt of each repetition of a test (per
 * test case, browser and `--repeat-each` repetition) decides that result, so
 * retries never inflate the totals while each repetition counts once,
 * timed-out folds into failed, and a result that passed only after a retry
 * counts as passed and as flaky (never as a failure). The persisted rows are
 * the single source the run views count from, so any path that must
 * (re)derive a run's stored counters uses this and cannot drift from what the
 * Tests list shows.
 */
export async function computeRunCountsFromRows(db: DbClient, runId: number) {
  const rows = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      retries: testRunsCases.retries,
      status: testRunsCases.status,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.testRunId, runId));
  return distinctRunCountsFromAttempts(rows);
}
