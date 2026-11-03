/**
 * A test's results in SQL, on SQLite and PostgreSQL alike: one result per run,
 * Playwright project and `--repeat-each` repetition, read from its final
 * attempt (the highest retry) as `finalAttempts` (`shared/utils/test-counts.ts`)
 * reads the rows in memory, and flaky as `isFlakyExecution` reads that attempt.
 * On a test's own pages (its page and Trend tab, the catalog, selections, spec
 * health) each such result is one of its runs. Each row stores whether it is
 * its result's final attempt (`final_attempt`), which every write of
 * `test_runs_cases` keeps through `settleFinalAttempts`; the flaky check reads
 * the row alone, so a query costs no lookup per execution for either: a retry
 * that comes without an attempt history is given one as it is stored
 * (`fillAttemptHistories`).
 */
import { aliasedTable, and, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { testRunsCases } from '../../server/database/schema';
import { failedCountSql, passedCountSql, passRateSql } from '../utils/pass-rate-sql';
import { fixmeSkipPredicate } from '../utils/skip-kind';
import { attemptKey, withAttemptHistory } from '../utils/test-counts';
import type { DrizzleDB } from './db';

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
 * Whether the same run, test, project and repetition as `row` holds a later
 * attempt than `row`: one with more retries, or as many and a higher id. Only
 * a retry, or an attempt without a project (the one row the unique index lets
 * repeat), can be another row's later attempt, so the lookup reads only those.
 * The `backfill_final_attempt` migrations hold the same SQL.
 */
function laterAttemptSql(row: Executions): SQL {
  return sql`EXISTS (
      SELECT 1 FROM ${testRunsCases} AS ${sql.identifier(LATER)}
      WHERE (${later.retries} > 0 OR ${later.browserName} IS NULL)
        AND ${sameResult(later, row)}
        AND (COALESCE(${later.retries}, 0) > COALESCE(${row.retries}, 0)
          OR (COALESCE(${later.retries}, 0) = COALESCE(${row.retries}, 0) AND ${later.id} > ${row.id}))
    )`;
}

/** Whether `row` is the final attempt of its result, as the row stores it (`settleFinalAttempts`). */
export function finalAttemptSql(row: Executions = testRunsCases): SQL {
  return sql`${row.finalAttempt} = true`;
}

/** How many tests one statement of `settleFinalAttempts` reads. */
const SETTLE_CHUNK = 500;

/**
 * Keep `final_attempt` right after rows of tests `testCaseIds` were added to
 * run `testRunId`: each of their attempts with a later attempt of its result
 * stored (`laterAttemptSql`) is no longer a final attempt. A row is stored as
 * one, so an attempt stored after a later one is settled too. Every write of
 * `test_runs_cases` calls it with the tests it wrote: `persistRunCases` on the
 * server and in the demo.
 */
export async function settleFinalAttempts(
  db: DrizzleDB,
  testRunId: number,
  testCaseIds: Iterable<number>,
): Promise<void> {
  const tests = [...new Set(testCaseIds)];
  for (let i = 0; i < tests.length; i += SETTLE_CHUNK) {
    const superseded = await db
      .select({ id: testRunsCases.id })
      .from(testRunsCases)
      .where(
        and(
          eq(testRunsCases.testRunId, testRunId),
          inArray(testRunsCases.testCaseId, tests.slice(i, i + SETTLE_CHUNK)),
          finalAttemptSql(),
          laterAttemptSql(testRunsCases),
        ),
      );
    if (superseded.length === 0) continue;
    await db
      .update(testRunsCases)
      .set({ finalAttempt: false })
      .where(
        inArray(
          testRunsCases.id,
          superseded.map((row) => row.id),
        ),
      );
  }
}

/** An execution about to be stored, as `fillAttemptHistories` reads it. */
interface NewAttempt {
  testCaseId: number;
  browserName?: string | null;
  repeatEachIndex?: number | null;
  retries?: number | null;
  status: string;
  duration?: number | null;
  startedAt?: number | null;
  attempts?: unknown;
}

/** How many entries a stored attempt history keeps, as ingest caps the one a reporter sends. */
const MAX_HISTORY_ENTRIES = 30;

/** Whether an execution came without an attempt history. */
function lacksHistory(attempts: unknown): boolean {
  return !Array.isArray(attempts) || attempts.length === 0;
}

/**
 * Give each retry among `rows`, the executions about to be stored in run
 * `testRunId`, that came without an attempt history (an older reporter) the
 * one `withAttemptHistory` builds from the attempts of its result up to it:
 * the run's stored attempts and the earlier ones of the batch, a stored
 * attempt counting once when the batch repeats it. `flakyResultSql` then reads
 * the row as the run page reads the run's rows. A row that came with a history
 * keeps it. The stored attempts are read in one query, only when a retry lacks
 * a history. Every write of `test_runs_cases` calls it before its insert:
 * `persistRunCases` on the server and in the demo.
 */
export async function fillAttemptHistories(db: DrizzleDB, testRunId: number, rows: NewAttempt[]): Promise<void> {
  const missing = new Set(rows.filter((row) => (row.retries ?? 0) > 0 && lacksHistory(row.attempts)));
  if (missing.size === 0) return;
  const stored = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      retries: testRunsCases.retries,
      status: testRunsCases.status,
      duration: testRunsCases.duration,
      startedAt: testRunsCases.startedAt,
    })
    .from(testRunsCases)
    .where(
      and(
        eq(testRunsCases.testRunId, testRunId),
        inArray(testRunsCases.testCaseId, [...new Set([...missing].map((row) => row.testCaseId))]),
      ),
    );
  const attemptOf = (row: { retries?: number | null } & Parameters<typeof attemptKey>[0]) =>
    `${attemptKey(row)}\x00${row.retries ?? 0}`;
  const storedAttempts = new Set(stored.map(attemptOf));
  const pool = [
    ...stored.map((row) => ({ ...row, attempts: null, source: null })),
    ...rows
      .map((row) => ({ ...row, repeatEachIndex: row.repeatEachIndex ?? 0, source: row }))
      .filter((row) => !storedAttempts.has(attemptOf(row))),
  ];
  for (const row of withAttemptHistory(pool)) {
    if (!row.source || !missing.has(row.source) || !Array.isArray(row.attempts)) continue;
    row.source.attempts = row.attempts.slice(0, MAX_HISTORY_ENTRIES);
  }
}

/**
 * Whether `row`, the final attempt of its result, is flaky, as
 * `isFlakyExecution` reads it from the row alone: it passed on a retry, and
 * its attempt history (`attempts`, which the reporter sends complete with a
 * final attempt, its own attempt last) holds an earlier attempt that failed or
 * timed out, or no earlier attempt: a history of one attempt is its own. The
 * history is compared as text with its spaces taken out, since PostgreSQL
 * renders `jsonb` with a space after each colon and SQLite stores none. A
 * trace import stores each attempt with the history of the run's attempts
 * before it (`importTraceRun`), as the reporter does, and a retry stored
 * without one is given it at startup (`backfillAttemptHistories`). A retry
 * left without a history has no earlier stored attempt: it is flaky when it
 * passed, as `flakyFinalAttempts` reads a final attempt with no earlier row.
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
 * counts as failed, an interrupted one in no outcome but its own), the flaky
 * ones (`flakyResultSql`), the pass rate (`passRateSql`) and the average
 * duration of the runs that ran. PostgreSQL returns COUNT and SUM (int8), AVG
 * and the pass-rate division (numeric) as strings, so each is mapped to a
 * number.
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
    interruptedRuns: countOf(sql`${row.status} = 'interrupted'`),
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
 * executions the read counts.
 */
export function recentFlakySql(testCaseId: SQLWrapper | number, eligible: SQL): SQL<number> {
  const columns = [testRunsCases.retries, testRunsCases.status, testRunsCases.attempts, testRunsCases.finalAttempt];
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
