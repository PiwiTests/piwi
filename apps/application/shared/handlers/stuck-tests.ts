import { and, desc, eq, sql } from 'drizzle-orm';
import { testCases, testRuns, testRunsCases } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import { eligibleRunSql } from '../run-eligibility';
import { STUCK_HISTORY } from '../stuck-tests';

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
  const [testCase] = await db
    .select({ id: testCases.id, owner: testCases.owner })
    .from(testCases)
    .where(
      and(
        eq(testCases.projectId, test.projectId),
        eq(testCases.filePath, test.filePath),
        eq(testCases.suitePath, (test.suitePath ?? []).join('\x1f')),
        eq(testCases.title, test.title),
      ),
    )
    .limit(1);
  if (!testCase) return { passingDurations: [], owner: null };
  const conds = [
    eq(testRunsCases.testCaseId, testCase.id),
    sql`${testRunsCases.status} = 'passed'`,
    sql`${testRunsCases.duration} IS NOT NULL`,
    eligibleRunSql('baseline'),
  ];
  if (test.browserName) conds.push(eq(testRunsCases.browserName, test.browserName));
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
