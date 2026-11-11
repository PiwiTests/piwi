import { and, desc, eq, sql } from 'drizzle-orm';
import { testCases, testRuns, testRunsCases } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import { eligibleRunSql } from '../run-eligibility';
import { STUCK_HISTORY, usualDurationKey, usualDurationMs } from '../stuck-tests';
import { joinSuitePath, splitSuitePath } from '../utils/suites';
import { storedIdentity, storedTestIdentity } from '../../server/utils/storable-values';

/** A running test as its begin event names it. */
export interface RunningTest {
  projectId: number;
  filePath: string;
  suitePath: readonly string[] | null;
  title: string;
  browserName: string | null;
}

/** A running test's history: the durations of its last passing executions, newest first, and its owner. */
export interface RunningTestHistory {
  passingDurations: number[];
  owner: string | null;
}

/**
 * The durations of a running test's last `STUCK_HISTORY` passing executions on its browser, newest first, in runs
 * eligible as a baseline (no lab or investigation run, no environment incident), and its owner. The test is found by
 * its natural key: file, describe path and title. Empty for a test never run before.
 */
export async function runningTestHistory(db: DrizzleDB, test: RunningTest): Promise<RunningTestHistory> {
  // The names as the test's rows store them (`storedTestIdentity`, `storedIdentity` for its project).
  const [stored, browserName] = await Promise.all([
    storedTestIdentity({
      filePath: test.filePath,
      suitePath: test.suitePath ? [...test.suitePath] : null,
      title: test.title,
    }),
    test.browserName ? storedIdentity(test.browserName) : null,
  ]);
  const [testCase] = await db
    .select({ id: testCases.id, owner: testCases.owner })
    .from(testCases)
    .where(
      and(
        eq(testCases.projectId, test.projectId),
        eq(testCases.filePath, stored.filePath),
        eq(testCases.suitePath, joinSuitePath(stored.suitePath)),
        eq(testCases.title, stored.title),
      ),
    )
    // The test case its external ID names wins over one a rename left under the same key.
    .orderBy(sql`${testCases.externalId} IS NULL`, desc(testCases.id))
    .limit(1);
  if (!testCase) return { passingDurations: [], owner: null };
  const conds = [
    eq(testRunsCases.testCaseId, testCase.id),
    sql`${testRunsCases.status} = 'passed'`,
    sql`${testRunsCases.duration} IS NOT NULL`,
    eligibleRunSql('baseline'),
  ];
  if (browserName) conds.push(eq(testRunsCases.browserName, browserName));
  const rows: Array<{ duration: number | null }> = await db
    .select({ duration: testRunsCases.duration })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(...conds))
    .orderBy(desc(testRunsCases.createdAt), desc(testRunsCases.id))
    .limit(STUCK_HISTORY);
  return {
    passingDurations: rows.flatMap((row) => (typeof row.duration === 'number' ? [row.duration] : [])),
    owner: testCase.owner ?? null,
  };
}

/** A test's usual duration in a run's project, as `runUsualDurations` lists it. */
export interface UsualDuration {
  filePath: string;
  suitePath: string[];
  title: string;
  /** The Playwright project its passes ran in; null for none. */
  browser: string | null;
  /** The longest of its last `STUCK_HISTORY` passing executions on that project, in ms (`usualDurationMs`). */
  usualMs: number;
}

/**
 * The usual duration of every test of a run's project on each Playwright project it ran in, from the passing
 * executions the Stuck? rule reads (`runningTestHistory`: the last `STUCK_HISTORY` of each, in runs eligible as a
 * baseline), in one query: the run page's Timeline draws it behind a running attempt. A test with fewer passes than
 * the rule needs is left out. Where two tests share a file, describe path and title, the one an external ID names
 * wins, as `runningTestHistory` picks it. Empty for an unknown run.
 */
export async function runUsualDurations(db: DrizzleDB, runId: number): Promise<{ tests: UsualDuration[] }> {
  const [run] = await db.select({ projectId: testRuns.projectId }).from(testRuns).where(eq(testRuns.id, runId));
  if (!run) return { tests: [] };
  const browserKey = sql<string>`COALESCE(${testRunsCases.browserName}, '')`;
  const ranked = db.$with('ranked').as(
    db
      .select({
        testCaseId: testRunsCases.testCaseId,
        browser: sql<string>`COALESCE(${testRunsCases.browserName}, '')`.as('browser_key'),
        duration: testRunsCases.duration,
        rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${testRunsCases.testCaseId}, ${browserKey} ORDER BY ${testRunsCases.createdAt} DESC, ${testRunsCases.id} DESC)`.as(
          'rn',
        ),
      })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .where(
        and(
          eq(testRuns.projectId, run.projectId),
          sql`${testRunsCases.status} = 'passed'`,
          sql`${testRunsCases.duration} IS NOT NULL`,
          eligibleRunSql('baseline'),
        ),
      ),
  );
  const rows = await db
    .with(ranked)
    .select({
      testCaseId: ranked.testCaseId,
      browser: ranked.browser,
      duration: ranked.duration,
      filePath: testCases.filePath,
      suitePath: testCases.suitePath,
      title: testCases.title,
      externalId: testCases.externalId,
    })
    .from(ranked)
    .innerJoin(testCases, eq(testCases.id, ranked.testCaseId))
    .where(sql`${ranked.rn} <= ${STUCK_HISTORY}`);

  const byTest = new Map<string, { row: (typeof rows)[number]; durations: number[] }>();
  for (const row of rows) {
    const key = `${row.testCaseId}\x00${row.browser}`;
    const entry = byTest.get(key);
    if (entry) entry.durations.push(Number(row.duration));
    else byTest.set(key, { row, durations: [Number(row.duration)] });
  }
  // The test an external ID names first, then the newest, as `runningTestHistory` picks one of a name.
  const entries = [...byTest.values()].sort(
    (a, b) =>
      Number(a.row.externalId == null) - Number(b.row.externalId == null) || b.row.testCaseId - a.row.testCaseId,
  );
  const tests = new Map<string, UsualDuration>();
  for (const { row, durations } of entries) {
    const usualMs = usualDurationMs(durations);
    if (usualMs === null) continue;
    const test: UsualDuration = {
      filePath: row.filePath,
      suitePath: splitSuitePath(row.suitePath),
      title: row.title,
      browser: row.browser || null,
      usualMs,
    };
    const key = usualDurationKey(test);
    if (!tests.has(key)) tests.set(key, test);
  }
  return { tests: [...tests.values()] };
}
