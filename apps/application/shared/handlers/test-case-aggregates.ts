/**
 * A test's results in SQL, on SQLite and PostgreSQL alike: one result per run,
 * Playwright project and `--repeat-each` repetition, read from its final
 * attempt (the highest retry) as `finalAttempts` (`shared/utils/test-counts.ts`)
 * reads the rows in memory, and flaky as `isFlakyExecution` reads that attempt.
 * On a test's own pages (its page and Trend tab, the catalog, selections, spec
 * health) each such result is one of its runs. A later attempt of a result is
 * looked up on the unique index of `test_runs_cases` (run, test, repetition,
 * retries, project); the flaky check reads the row alone, so a query costs no
 * lookup per execution for it.
 */
import { aliasedTable, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { testRunsCases } from '../../server/database/schema';
import { failedCountSql, passedCountSql, passRateSql } from '../utils/pass-rate-sql';
import { fixmeSkipPredicate } from '../utils/skip-kind';

type Executions = typeof testRunsCases;

const LATER = 'later_attempt';
const later = aliasedTable(testRunsCases, LATER);

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
 * Only a retry, or an attempt without a project (the one row the unique index
 * lets repeat), can be another row's later attempt, so the lookup reads only
 * those: PostgreSQL then hashes a few rows instead of every execution.
 */
export function finalAttemptSql(row: Executions = testRunsCases): SQL {
  return sql`NOT EXISTS (
      SELECT 1 FROM ${testRunsCases} AS ${sql.identifier(LATER)}
      WHERE (${later.retries} > 0 OR ${later.browserName} IS NULL)
        AND ${sameResult(later, row)}
        AND (COALESCE(${later.retries}, 0) > COALESCE(${row.retries}, 0)
          OR (COALESCE(${later.retries}, 0) = COALESCE(${row.retries}, 0) AND ${later.id} > ${row.id}))
    )`;
}

/**
 * Whether `row`, the final attempt of its result, is flaky, as
 * `isFlakyExecution` reads it from the row alone: it passed on a retry, and
 * its attempt history (`attempts`, which the reporter sends complete with a
 * final attempt) holds an earlier attempt that failed or timed out, or holds
 * none. The history is compared as text with its spaces taken out, since
 * PostgreSQL renders `jsonb` with a space after each colon and SQLite stores
 * none. `isFlakyExecution` is also given, for a row that came without a
 * history (a trace import), one built from the run's stored attempts
 * (`withAttemptHistory`); this reads such a row as a pass on a retry, flaky,
 * as `flakyFinalAttempts` reads a final attempt with no earlier row.
 */
export function flakyResultSql(row: Executions = testRunsCases): SQL<boolean> {
  const history = sql`REPLACE(CAST(${row.attempts} AS TEXT), ' ', '')`;
  return sql<boolean>`(${row.status} = 'passed' AND COALESCE(${row.retries}, 0) > 0 AND (
      ${row.attempts} IS NULL
      OR ${history} NOT LIKE '%"retry"%"retry"%'
      OR ${history} LIKE '%"status":"failed"%'
      OR ${history} LIKE '%"status":"timed%'))`;
}

/** Whether a run ran the test: neither skipped nor did not run. An average duration reads only those. */
function ranSql(status: SQLWrapper): SQL {
  return sql`${status} NOT IN ('skipped', 'didnotrun')`;
}

/** How many of the rows match `condition`. */
function countOf(condition: SQL): SQL<number> {
  return sql<number>`SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END)`.mapWith(Number);
}

/**
 * A test's aggregates over the rows a query keeps, which `finalAttemptSql`
 * narrows to one per run: how many runs, how they ended (a timed-out run
 * counts as failed), the flaky ones (`flakyResultSql`), the pass rate
 * (`passRateSql`) and the average duration of the runs that ran. PostgreSQL
 * returns COUNT and SUM (int8), AVG and the pass-rate division (numeric) as
 * strings, so each is mapped to a number.
 */
export function testCaseAggregates(row: Executions = testRunsCases) {
  const passed = passedCountSql(row.status).mapWith(Number);
  const failed = failedCountSql(row.status).mapWith(Number);
  return {
    totalRuns: sql<number>`COUNT(${row.id})`.mapWith(Number),
    passedRuns: passed,
    failedRuns: failed,
    skippedRuns: countOf(sql`${row.status} = 'skipped'`),
    timedOutRuns: countOf(sql`${row.status} IN ('timedOut', 'timedout')`),
    fixmeRuns: countOf(fixmeSkipPredicate(row.status, row.testAnnotations)),
    didNotRunRuns: countOf(sql`${row.status} = 'didnotrun'`),
    flakyRuns: countOf(flakyResultSql(row)),
    passRate: passRateSql(passed, failed).mapWith(Number),
    avgDuration: sql<number | null>`AVG(CASE WHEN ${ranSql(row.status)} THEN ${row.duration} END)`.mapWith(Number),
  };
}

/** A test's latest executions, read by `recentFlakySql`. */
const RECENT = 'recent';
const recent = aliasedTable(testRunsCases, RECENT);

/**
 * How many of a test's last ten executions end a flaky run (`flakyResultSql`
 * on a final attempt), as a subquery: `testCaseId` names the test (a column of
 * the outer query, or an id) and `eligible`, over `test_runs_cases`, keeps the
 * executions the read counts. The ten are read first, so only the flaky
 * candidates among them look a later attempt up.
 */
export function recentFlakySql(testCaseId: SQLWrapper | number, eligible: SQL): SQL<number> {
  const columns = [
    testRunsCases.id,
    testRunsCases.testRunId,
    testRunsCases.testCaseId,
    testRunsCases.repeatEachIndex,
    testRunsCases.browserName,
    testRunsCases.retries,
    testRunsCases.status,
    testRunsCases.attempts,
  ];
  const latest = sql`SELECT ${sql.join(columns, sql`, `)}
      FROM ${testRunsCases}
      WHERE ${testRunsCases.testCaseId} = ${testCaseId}
        AND ${eligible}
      ORDER BY ${testRunsCases.createdAt} DESC
      LIMIT 10`;
  const count = sql`SELECT COUNT(*) FROM (${latest}) AS ${sql.identifier(RECENT)}
      WHERE ${flakyResultSql(recent)}
        AND ${finalAttemptSql(recent)}`;
  return sql<number>`(${count})`.mapWith(Number);
}
