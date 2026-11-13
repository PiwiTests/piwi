import { sql, type SQL } from 'drizzle-orm';
import { testCases, testRunsCases } from '../../server/database/schema';
import { finalAttemptSql } from './test-case-aggregates';

/** A column of a test case's newest execution `eligible` keeps, correlated on `test_cases`. */
function newestOf(column: typeof testRunsCases.status | typeof testRunsCases.testRunId, eligible: SQL): SQL {
  return sql`(
      SELECT ${column}
      FROM ${testRunsCases}
      WHERE ${testRunsCases.testCaseId} = ${testCases.id}
        AND ${eligible}
      ORDER BY ${testRunsCases.createdAt} DESC
      LIMIT 1
    )`;
}

/**
 * A test case's status in its latest run, as a SQL expression correlated on
 * `test_cases`: `failed` when the last attempt of one of its `--repeat-each`
 * repetitions or Playwright projects failed there, else the status of its
 * newest execution. The latest run is the run of that newest execution.
 * `eligible` is the condition over `test_runs_cases` that keeps the executions
 * the read counts. A test with no such execution reads null.
 */
export function latestRunStatusSql(eligible: SQL): SQL<string | null> {
  const newest = (column: typeof testRunsCases.status | typeof testRunsCases.testRunId) => newestOf(column, eligible);
  // Per repetition and project, the attempt with the most retries is the last one: it failed when no failed attempt
  // has fewer retries than the last.
  const failedRepetition = sql`EXISTS (
      SELECT 1
      FROM ${testRunsCases}
      WHERE ${testRunsCases.testRunId} = ${newest(testRunsCases.testRunId)}
        AND ${testRunsCases.testCaseId} = ${testCases.id}
      GROUP BY ${testRunsCases.repeatEachIndex}, ${testRunsCases.browserName}
      HAVING MAX(CASE WHEN ${testRunsCases.status} IN ('failed', 'timedOut', 'timedout') THEN COALESCE(${testRunsCases.retries}, 0) END)
        = MAX(COALESCE(${testRunsCases.retries}, 0))
    )`;
  return sql<string | null>`CASE WHEN ${failedRepetition} THEN 'failed' ELSE ${newest(testRunsCases.status)} END`;
}

/**
 * How long a test case took in its latest run, as `latestRunStatusSql` reads that run: the longest final attempt of its
 * `--repeat-each` repetitions and Playwright projects there, in ms. Null without an eligible execution or a duration.
 */
export function latestRunDurationSql(eligible: SQL): SQL<number | null> {
  return sql<number | null>`(
      SELECT MAX(${testRunsCases.duration})
      FROM ${testRunsCases}
      WHERE ${testRunsCases.testRunId} = ${newestOf(testRunsCases.testRunId, eligible)}
        AND ${testRunsCases.testCaseId} = ${testCases.id}
        AND ${finalAttemptSql()}
    )`;
}
