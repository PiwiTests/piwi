import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { getProjectTestCases } = await import('../../shared/handlers/projects');

let db: ReturnType<typeof drizzle<typeof schema>>;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/**
 * One test: two executions in the last 30 days (a pass and a failure), and
 * older ones a "Last 30 days" catalog leaves out (two failures and a pass on a
 * retry, 60 days ago).
 */
const EXECUTIONS = [
  { daysAgo: 60, status: 'failed', duration: 9_000, retries: 0 },
  { daysAgo: 60, status: 'failed', duration: 9_000, retries: 0 },
  { daysAgo: 60, status: 'passed', duration: 9_000, retries: 1 },
  { daysAgo: 5, status: 'passed', duration: 1_000, retries: 0 },
  { daysAgo: 2, status: 'failed', duration: 3_000, retries: 0 },
];

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'adds to cart' });
  await db.insert(schema.testRuns).values(
    EXECUTIONS.map((e, i) => ({
      id: i + 1,
      projectId: 1,
      status: e.status,
      startTime: new Date(NOW - e.daysAgo * DAY),
    })),
  );
  await db.insert(schema.testRunsCases).values(
    EXECUTIONS.map((e, i) => ({
      testRunId: i + 1,
      testCaseId: 1,
      status: e.status,
      duration: e.duration,
      retries: e.retries,
      createdAt: new Date(NOW - e.daysAgo * DAY + i),
    })),
  );
});

describe("the catalog's period", () => {
  // Sorted by file, the page is picked first and only its tests' executions are joined.
  test.each(['lastRun', 'file'] as const)('bounds the numbers of the tests it lists (sorted by %s)', async (sort) => {
    const { items } = await getProjectTestCases(db as never, 1, { maxAgeDays: 30, sort });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      totalRuns: 2,
      passedRuns: 1,
      failedRuns: 1,
      flakyRuns: 0,
      recentFlakyRuns: 0,
      avgDuration: 2_000,
      status: 'failed',
    });
  });

  test('a status filter reads the period too', async () => {
    const flaky = await getProjectTestCases(db as never, 1, { maxAgeDays: 30, statuses: ['flaky'] });
    expect(flaky.total).toBe(0);
  });

  test('all time counts every execution', async () => {
    const { items } = await getProjectTestCases(db as never, 1, { maxAgeDays: 0 });
    expect(items[0]).toMatchObject({ totalRuns: 5, passedRuns: 2, failedRuns: 3, flakyRuns: 1, status: 'flaky' });
  });
});
