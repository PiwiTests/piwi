import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { testRunsCases } from '../database/schema';
import { isFlakyExecution, withAttemptHistory } from '#shared/utils/test-counts';
import type { DrizzleDB } from '#shared/handlers/db';
import { getAppSetting, setAppSetting } from './app-settings';

/**
 * The app setting that records how far {@link backfillAttemptHistories} got on this instance:
 * `{ after: <id> }` while it runs, `{ doneAt: <ISO date> }` once it went through every execution.
 */
export const ATTEMPT_HISTORY_BACKFILL_SETTING = 'attempt_history_backfill';

type BackfillProgress = { after: number } | { doneAt: string };

/** How many retries stored without an attempt history one page of the backfill reads. */
const ATTEMPT_HISTORY_BACKFILL_PAGE = 500;

/** How many entries an attempt history keeps, as ingest caps one (`persistRunCases`). */
const MAX_HISTORY_ENTRIES = 30;

/**
 * Give each retry stored without an attempt history (a trace import, an older
 * reporter) the history the run's stored attempts of its test, Playwright
 * project and repetition make, up to it, in the shape ingest stores
 * (`withAttemptHistory`), and, on a final attempt, the verdict that history
 * gives it (`passedAfterFailure`, `isFlakyExecution`), which every reader of a
 * stored execution takes from the column. A retry with no earlier stored attempt keeps no
 * history. Reads the executions in pages of {@link ATTEMPT_HISTORY_BACKFILL_PAGE}
 * from `after` (an execution id) and calls `onPage` with the last id of each
 * page done. Returns how many executions it gave a history.
 */
export async function backfillAttemptHistories(
  db: DrizzleDB,
  options: { after?: number; onPage?: (lastId: number) => Promise<void> } = {},
): Promise<number> {
  let after = options.after ?? 0;
  let filled = 0;
  for (;;) {
    const page = await db
      .select({ id: testRunsCases.id, testRunId: testRunsCases.testRunId, testCaseId: testRunsCases.testCaseId })
      .from(testRunsCases)
      .where(
        and(
          gt(testRunsCases.id, after),
          sql`${testRunsCases.retries} > 0`,
          sql`(${testRunsCases.attempts} IS NULL OR CAST(${testRunsCases.attempts} AS TEXT) = '[]')`,
        ),
      )
      .orderBy(asc(testRunsCases.id))
      .limit(ATTEMPT_HISTORY_BACKFILL_PAGE);
    if (page.length === 0) return filled;

    const testsByRun = new Map<number, Set<number>>();
    for (const row of page) {
      const tests = testsByRun.get(row.testRunId) ?? new Set<number>();
      tests.add(row.testCaseId);
      testsByRun.set(row.testRunId, tests);
    }
    const wanted = new Set(page.map((row) => row.id));
    for (const [testRunId, tests] of testsByRun) {
      const attempts = await db
        .select({
          id: testRunsCases.id,
          testCaseId: testRunsCases.testCaseId,
          browserName: testRunsCases.browserName,
          repeatEachIndex: testRunsCases.repeatEachIndex,
          retries: testRunsCases.retries,
          status: testRunsCases.status,
          duration: testRunsCases.duration,
          startedAt: testRunsCases.startedAt,
          attempts: testRunsCases.attempts,
          finalAttempt: testRunsCases.finalAttempt,
        })
        .from(testRunsCases)
        .where(and(eq(testRunsCases.testRunId, testRunId), inArray(testRunsCases.testCaseId, [...tests])))
        .orderBy(asc(testRunsCases.id));
      for (const row of withAttemptHistory(attempts)) {
        if (!wanted.has(row.id) || !Array.isArray(row.attempts) || row.attempts.length === 0) continue;
        const history = row.attempts.slice(0, MAX_HISTORY_ENTRIES);
        await db
          .update(testRunsCases)
          .set({
            attempts: history,
            passedAfterFailure: row.finalAttempt && isFlakyExecution({ ...row, attempts: history }),
          })
          .where(
            and(
              eq(testRunsCases.id, row.id),
              sql`(${testRunsCases.attempts} IS NULL OR CAST(${testRunsCases.attempts} AS TEXT) = '[]')`,
            ),
          );
        filled++;
      }
    }
    after = page.at(-1)!.id;
    await options.onPage?.(after);
  }
}

/**
 * Run {@link backfillAttemptHistories} once per instance, from where an earlier
 * start left it ({@link ATTEMPT_HISTORY_BACKFILL_SETTING}), recording its
 * progress after each page and the date once it is done.
 */
export async function backfillAttemptHistoriesOnce(db: DrizzleDB): Promise<number | null> {
  const progress = await getAppSetting<BackfillProgress>(db, ATTEMPT_HISTORY_BACKFILL_SETTING);
  if (progress && 'doneAt' in progress) return null;
  const filled = await backfillAttemptHistories(db, {
    after: progress?.after ?? 0,
    onPage: (after) => setAppSetting(db, ATTEMPT_HISTORY_BACKFILL_SETTING, { after } satisfies BackfillProgress),
  });
  await setAppSetting(db, ATTEMPT_HISTORY_BACKFILL_SETTING, {
    doneAt: new Date().toISOString(),
  } satisfies BackfillProgress);
  return filled;
}
