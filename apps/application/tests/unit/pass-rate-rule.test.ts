import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { passRate, passRatePercent } = await import('../../shared/utils/pass-rate');
const { failedCountSql, passedCountSql, passRateSql } = await import('../../shared/utils/pass-rate-sql');

describe('the pass rate', () => {
  test('is the passed results over the results that passed or failed', () => {
    expect(passRate({ passed: 3, failed: 1 })).toBe(0.75);
    expect(passRatePercent({ passed: 3, failed: 1 })).toBe(75);
    expect(passRatePercent({ passed: 2, failed: 1 }, 1)).toBe(66.7);
    expect(passRatePercent({ passed: 7, failed: 73 }, 1)).toBe(8.8);
  });

  test('has no value without a passed or failed result, never 0 % or 100 %', () => {
    expect(passRate({ passed: 0, failed: 0 })).toBeNull();
    expect(passRatePercent({ passed: 0, failed: 0 })).toBeNull();
    expect(passRate({ passed: 0, failed: 2 })).toBe(0);
    expect(passRate({ passed: 2, failed: 0 })).toBe(1);
  });

  test('reads a missing or negative count as none', () => {
    expect(passRate({ passed: Number.NaN, failed: 1 })).toBe(0);
    expect(passRate({ passed: -1, failed: 0 })).toBeNull();
  });
});

describe('the pass rate in SQL', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(db);
    await db.insert(schema.projects).values({ id: 1, name: 'shop' });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'adds' },
      { id: 2, projectId: 1, filePath: 'cart.spec.ts', title: 'removes' },
    ]);
    const statuses = ['passed', 'passed', 'failed', 'timedout', 'timedOut', 'skipped', 'didnotrun', 'interrupted'];
    await db
      .insert(schema.testRuns)
      .values(statuses.map((_, i) => ({ id: i + 1, projectId: 1, status: 'failed', startTime: new Date() })));
    await db
      .insert(schema.testRunsCases)
      .values([
        ...statuses.map((status, i) => ({ testRunId: i + 1, testCaseId: 1, status })),
        { testRunId: 1, testCaseId: 2, status: 'skipped' },
      ]);
  });

  test('counts a timed-out result as failed, and a skipped, did-not-run or interrupted one in neither term', async () => {
    const passed = passedCountSql(schema.testRunsCases.status);
    const failed = failedCountSql(schema.testRunsCases.status);
    const rows = await db
      .select({
        testCaseId: schema.testRunsCases.testCaseId,
        passed: passed.mapWith(Number),
        failed: failed.mapWith(Number),
        rate: passRateSql(passed, failed),
      })
      .from(schema.testRunsCases)
      .groupBy(schema.testRunsCases.testCaseId)
      .orderBy(schema.testRunsCases.testCaseId);
    expect(rows).toEqual([
      { testCaseId: 1, passed: 2, failed: 3, rate: 0.4 },
      { testCaseId: 2, passed: 0, failed: 0, rate: null },
    ]);
    expect(rows[0]!.rate).toBe(passRate({ passed: 2, failed: 3 }));
  });
});
