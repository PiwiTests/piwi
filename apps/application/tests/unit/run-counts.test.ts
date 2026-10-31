import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the helper.
delete process.env.PIWI_DATABASE_URL;
const { computeRunCountsFromRows } = await import('../../server/utils/run-counts');

let db: ReturnType<typeof drizzle<typeof schema>>;

// One row per (test, browser, attempt), as the streaming events endpoint
// persists them. Run 1 mixes every outcome; run 2 exists only to prove the
// helper scopes its count to the run it is asked about.
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);

  await db.insert(schema.projects).values([{ id: 1, name: 'Alpha' }]);
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'failed', startTime: new Date(), isFullRun: 1 },
    { id: 2, projectId: 1, status: 'failed', startTime: new Date(), isFullRun: 1 },
  ]);

  const cases: Array<{ id: number; title: string }> = [];
  for (let i = 1; i <= 13; i++) cases.push({ id: i, title: `test ${i}` });
  await db.insert(schema.testCases).values(cases.map((c) => ({ ...c, projectId: 1, filePath: 'a.spec.ts' })));

  const rows: Array<{ testRunId: number; testCaseId: number; status: string; retries: number; browserName: string }> =
    [];
  const add = (testRunId: number, testCaseId: number, status: string, retries: number, browserName = 'chromium') =>
    rows.push({ testRunId, testCaseId, status, retries, browserName });

  // Run 1: 3 hard failures, 4 flaky (fail then pass on retry), 2 skipped,
  // 1 didn't-run, 1 clean pass, and 1 test that timed out on both attempts
  // (folds into failed). 18 attempt rows across 12 distinct tests.
  add(1, 1, 'failed', 0);
  add(1, 2, 'failed', 0);
  add(1, 3, 'failed', 0);
  for (const tc of [4, 5, 6, 7]) {
    add(1, tc, 'failed', 0);
    add(1, tc, 'passed', 1);
  }
  add(1, 8, 'skipped', 0);
  add(1, 9, 'skipped', 0);
  add(1, 10, 'didnotrun', 0);
  add(1, 11, 'passed', 0);
  add(1, 12, 'timedOut', 0, 'firefox');
  add(1, 12, 'timedout', 1, 'firefox');

  // Run 2: a single failure, only to confirm run-scoping.
  add(2, 13, 'failed', 0);

  await db.insert(schema.testRunsCases).values(rows);
});

describe('computeRunCountsFromRows', () => {
  test('collapses attempt rows to distinct-test counters, folding timed-out and counting flaky as passed', async () => {
    const counts = await computeRunCountsFromRows(db, 1);
    expect(counts).toEqual({
      totalTests: 12,
      passedTests: 5, // 4 passed-on-retry + 1 clean pass
      failedTests: 4, // 3 hard failures + 1 timed-out (folded in)
      skippedTests: 2,
      didNotRunTests: 1,
      flakyTests: 4, // the passed-on-retry tests, a subset of passedTests
    });
    // A flaky test's earlier failed attempt is not a failure.
    expect(counts.passedTests + counts.failedTests + counts.skippedTests + counts.didNotRunTests).toBe(
      counts.totalTests,
    );
  });

  test('scopes the count to the requested run', async () => {
    const counts = await computeRunCountsFromRows(db, 2);
    expect(counts.totalTests).toBe(1);
    expect(counts.failedTests).toBe(1);
    expect(counts.passedTests).toBe(0);
  });
});
