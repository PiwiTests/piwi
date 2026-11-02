/**
 * A test's results in SQL, on SQLite and PostgreSQL alike: one result per run,
 * Playwright project and `--repeat-each` repetition, read from its final
 * attempt (the highest retry), as `finalAttempts` and `flakyFinalAttempts`
 * (`shared/utils/test-counts.ts`) read the rows in memory. The subqueries look
 * the other attempts of a result up on the unique index of `test_runs_cases`
 * (run, test, repetition, retries, project).
 */
import { aliasedTable, sql, type SQL } from 'drizzle-orm';
import { testRunsCases } from '../../server/database/schema';
import { failedStatusSql } from '../utils/pass-rate-sql';

type Executions = typeof testRunsCases;

const LATER = 'later_attempt';
const EARLIER = 'earlier_attempt';
const later = aliasedTable(testRunsCases, LATER);
const earlier = aliasedTable(testRunsCases, EARLIER);

/** Whether `other` is an attempt of the same result as `row`: one run, test, Playwright project and repetition. */
function sameResult(other: Executions, row: Executions): SQL {
  return sql`${other.testRunId} = ${row.testRunId}
      AND ${other.testCaseId} = ${row.testCaseId}
      AND ${other.repeatEachIndex} = ${row.repeatEachIndex}
      AND COALESCE(${other.browserName}, '') = COALESCE(${row.browserName}, '')`;
}

/**
 * Whether `row` is the final attempt of its result: no attempt of the same run,
 * test, project and repetition has more retries, nor as many and a higher id.
 */
export function finalAttemptSql(row: Executions = testRunsCases): SQL {
  return sql`NOT EXISTS (
      SELECT 1 FROM ${testRunsCases} AS ${sql.identifier(LATER)}
      WHERE ${sameResult(later, row)}
        AND (COALESCE(${later.retries}, 0) > COALESCE(${row.retries}, 0)
          OR (COALESCE(${later.retries}, 0) = COALESCE(${row.retries}, 0) AND ${later.id} > ${row.id}))
    )`;
}

/** The attempts of `row`'s result stored before it, with fewer retries. */
function earlierAttempts(row: Executions, condition?: SQL): SQL {
  return sql`SELECT 1 FROM ${testRunsCases} AS ${sql.identifier(EARLIER)}
      WHERE ${sameResult(earlier, row)}
        AND COALESCE(${earlier.retries}, 0) < COALESCE(${row.retries}, 0)${condition ? sql` AND ${condition}` : sql``}`;
}

/**
 * 1 when `row`, the final attempt of its result, is flaky, else 0: it passed
 * after an earlier attempt of the same result failed or timed out, or, with no
 * earlier attempt stored, it passed on a retry. This is `flakyFinalAttempts`
 * over the stored rows. `isFlakyExecution` reads a row's own attempt history
 * (`attempts`) instead, so for a result whose earlier attempts were never
 * stored as rows (a payload of final attempts only), a pass on a retry reads
 * flaky here even when its history holds no failure.
 */
export function flakyResultSql(row: Executions = testRunsCases): SQL<number> {
  return sql<number>`CASE WHEN ${row.status} = 'passed' AND COALESCE(${row.retries}, 0) > 0 THEN
      CASE WHEN EXISTS (${earlierAttempts(row, failedStatusSql(earlier.status))})
        OR NOT EXISTS (${earlierAttempts(row)}) THEN 1 ELSE 0 END
    ELSE 0 END`;
}
