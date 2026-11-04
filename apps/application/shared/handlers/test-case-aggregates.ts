/**
 * A test's results in SQL, on SQLite and PostgreSQL alike: one result per run,
 * Playwright project and `--repeat-each` repetition, read from its final
 * attempt (the highest retry) as `finalAttempts` (`shared/utils/test-counts.ts`)
 * reads the rows in memory, and flaky as `isFlakyExecution` reads that attempt.
 * On a test's own pages (its page and Trend tab, the catalog, selections, spec
 * health) each such result is one of its runs. Each row stores whether it is
 * its result's final attempt (`final_attempt`), which every write of
 * `test_runs_cases` keeps through `settleFinalAttempts`, and whether it passed
 * after an earlier attempt failed (`passed_after_failure`), which every write
 * sets through `fillAttemptHistories`, so a query costs no lookup per
 * execution for either: a retry that comes without an attempt history is
 * given one, and its verdict, as it is stored, both completed when an earlier
 * attempt is stored after it (`settleFinalAttempts`).
 */
import { aliasedTable, and, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { testRunsCases } from '../../server/database/schema';
import { failedCountSql, passedCountSql, passRateSql } from '../utils/pass-rate-sql';
import { fixmeSkipPredicate } from '../utils/skip-kind';
import { attemptKey, isFlakyExecution, withAttemptHistory } from '../utils/test-counts';
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

/** Whether the result `row` is an attempt of holds a stored retry. */
function storedRetrySql(row: Executions): SQL {
  return sql`EXISTS (
      SELECT 1 FROM ${testRunsCases} AS ${sql.identifier(LATER)}
      WHERE ${later.retries} > 0
        AND ${sameResult(later, row)}
    )`;
}

/** Whether `row` is the final attempt of its result, as the row stores it (`settleFinalAttempts`). */
export function finalAttemptSql(row: Executions = testRunsCases): SQL {
  return sql`${row.finalAttempt} = true`;
}

/** How many tests one statement of `settleFinalAttempts` reads. */
const SETTLE_CHUNK = 500;

/** How many entries a stored attempt history keeps, as ingest caps the one a reporter sends. */
const MAX_HISTORY_ENTRIES = 30;

/** An execution of a batch, as `settleFinalAttempts` reads it: its result and its retry. */
interface BatchAttempt {
  testCaseId: number;
  browserName?: string | null;
  repeatEachIndex?: number | null;
  retries?: number | null;
}

/** The result `row` is an attempt of in its run: its test, Playwright project and repetition (`attemptKey`). */
function resultOf(row: BatchAttempt): string {
  return attemptKey({ ...row, repeatEachIndex: row.repeatEachIndex ?? 0 });
}

/** Which attempt of its result `row` is. */
function attemptOf(row: BatchAttempt): string {
  return `${resultOf(row)}\x00${row.retries ?? 0}`;
}

/**
 * Keep the stored attempts of run `testRunId` right after a write of `rows`, a
 * batch of its executions (each row inserted, or stored already by a request
 * that failed past its insert):
 * - an attempt of their tests with a later attempt of its result stored
 *   (`laterAttemptSql`) is marked as not final, and its verdict cleared: only
 *   a result's final attempt carries it. A row is stored as final, so an
 *   attempt stored after a later one is settled too;
 * - a stored retry of a result `rows` holds an attempt of is given the
 *   history `withAttemptHistory` builds from the result's stored attempts
 *   when it lists more of them than the stored one, so an attempt stored
 *   after its retry completes the retry's history, and its verdict with it,
 *   whether that attempt came with a history or not (`withoutHistory`, the
 *   rows `fillAttemptHistories` found without one). A history the reporter
 *   sent whole lists every attempt and is kept, as is one the batch carries.
 * Every write of `test_runs_cases` calls it after its insert with every row of
 * its batch, so sending a batch again repairs both: `persistRunCases` on the
 * server and in the demo. The stored attempts of the results of `rows` that
 * hold a stored retry are read once, `SETTLE_CHUNK` tests per statement.
 */
export async function settleFinalAttempts(
  db: DrizzleDB,
  testRunId: number,
  rows: ReadonlyArray<BatchAttempt>,
  withoutHistory: ReadonlyArray<BatchAttempt>,
): Promise<void> {
  const tests = [...new Set(rows.map((row) => row.testCaseId))];
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
      .set({ finalAttempt: false, passedAfterFailure: false })
      .where(
        inArray(
          testRunsCases.id,
          superseded.map((row) => row.id),
        ),
      );
  }
  await completeAttemptHistories(db, testRunId, rows, withoutHistory);
}

/** The history part of `settleFinalAttempts`. */
async function completeAttemptHistories(
  db: DrizzleDB,
  testRunId: number,
  rows: ReadonlyArray<BatchAttempt>,
  withoutHistory: ReadonlyArray<BatchAttempt>,
): Promise<void> {
  const results = new Set(rows.map(resultOf));
  const bare = new Set(withoutHistory);
  const carried = new Set(rows.filter((row) => !bare.has(row)).map(attemptOf));
  const tests = [...new Set(rows.map((row) => row.testCaseId))];
  for (let i = 0; i < tests.length; i += SETTLE_CHUNK) {
    const stored = await db
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
      .where(
        and(
          eq(testRunsCases.testRunId, testRunId),
          inArray(testRunsCases.testCaseId, tests.slice(i, i + SETTLE_CHUNK)),
          storedRetrySql(testRunsCases),
        ),
      );
    const ofResults = stored.filter((row) => results.has(resultOf(row)));
    const listed = new Map(ofResults.map((row) => [row.id, Array.isArray(row.attempts) ? row.attempts.length : 0]));
    const rebuilt = withAttemptHistory(ofResults.map((row) => ({ ...row, attempts: null as unknown })));
    for (const row of rebuilt) {
      if ((row.retries ?? 0) === 0 || carried.has(attemptOf(row)) || !Array.isArray(row.attempts)) continue;
      const attempts = row.attempts.slice(0, MAX_HISTORY_ENTRIES);
      if (attempts.length <= listed.get(row.id)!) continue;
      await db
        .update(testRunsCases)
        .set({ attempts, passedAfterFailure: row.finalAttempt && isFlakyExecution({ ...row, attempts }) })
        .where(eq(testRunsCases.id, row.id));
    }
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
  passedAfterFailure?: boolean;
}

/** Whether an execution came without an attempt history. */
function lacksHistory(attempts: unknown): boolean {
  return !Array.isArray(attempts) || attempts.length === 0;
}

/**
 * Give each retry among `rows`, the executions about to be stored in run
 * `testRunId`, that came without an attempt history (an older reporter) the
 * one `withAttemptHistory` builds from the attempts of its result up to it:
 * the run's stored attempts and the earlier ones of the batch, a stored
 * attempt counting once when the batch repeats it. A row that came with a
 * history keeps it. Then set each row's verdict (`passedAfterFailure`): it
 * passed after an earlier attempt failed or timed out, as `isFlakyExecution`
 * reads it with that history, which every reader of a stored execution takes
 * from the column. A row is stored as its result's final attempt, and
 * `settleFinalAttempts` clears the verdict of one a later attempt supersedes,
 * so only a final attempt carries it. The stored attempts are read in one query, only when a
 * retry lacks a history. Returns the rows that came without a history, which
 * `settleFinalAttempts` tells apart from the histories the batch carries when
 * it completes the stored histories, and the verdicts, of their results.
 * Every write of `test_runs_cases` calls it before its
 * insert: `persistRunCases` on the server and in the demo.
 */
export async function fillAttemptHistories(
  db: DrizzleDB,
  testRunId: number,
  rows: NewAttempt[],
): Promise<NewAttempt[]> {
  const withoutHistory = rows.filter((row) => lacksHistory(row.attempts));
  const missing = new Set(withoutHistory.filter((row) => (row.retries ?? 0) > 0));
  if (missing.size > 0) await fillMissingHistories(db, testRunId, rows, missing);
  for (const row of rows) {
    row.passedAfterFailure = isFlakyExecution({
      ...row,
      attempts: Array.isArray(row.attempts) ? row.attempts : null,
    });
  }
  return withoutHistory;
}

/** The history part of `fillAttemptHistories`: `missing` are the retries of `rows` that came without one. */
async function fillMissingHistories(
  db: DrizzleDB,
  testRunId: number,
  rows: NewAttempt[],
  missing: ReadonlySet<NewAttempt>,
): Promise<void> {
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
 * Whether `row` is the final attempt of a flaky result: it passed after an
 * earlier attempt failed or timed out, the verdict stored with it
 * (`passed_after_failure`, set by `fillAttemptHistories` and kept by
 * `settleFinalAttempts`, which clears it on an attempt a later one
 * supersedes). The partial index `idx_trc_passed_after_failure` repeats the
 * condition, so a query that spells it this way can use it.
 */
export function flakyResultSql(row: Executions = testRunsCases): SQL<boolean> {
  return sql<boolean>`(${row.passedAfterFailure} = true)`;
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
  const columns = [testRunsCases.passedAfterFailure, testRunsCases.finalAttempt];
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
