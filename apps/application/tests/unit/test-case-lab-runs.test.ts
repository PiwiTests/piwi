import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { getTestCase, getTestCaseStabilityTrend } = await import('../../shared/handlers/test-cases');
const { getProjectTestCases } = await import('../../shared/handlers/projects');
const { runOrigin } = await import('../../shared/run-eligibility');

let db: ReturnType<typeof drizzle<typeof schema>>;
const MINUTE = 60_000;
const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MINUTE);

/**
 * One test case with three real executions (two passed, one failed) and, more
 * recently, a probe run that failed plus a flake-lab arm of two executions: a
 * failure and a retry-pass. Every stat reads the three real executions only.
 */
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  const run = (id: number, minutesAgo: number, metadata: object | null) => ({
    id,
    projectId: 1,
    status: 'passed',
    startTime: at(minutesAgo),
    metadata,
    origin: runOrigin(metadata),
  });
  await db
    .insert(schema.testRuns)
    .values([
      run(1, 50, null),
      run(2, 40, null),
      run(3, 30, { ci: true }),
      run(4, 20, { piwiProbe: true }),
      run(5, 10, { piwiFlakeLab: { experimentId: 'exp-1', armId: 'slow-cart' } }),
    ]);
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'adds to cart' });
  const execution = (
    id: number,
    testRunId: number,
    minutesAgo: number,
    status: string,
    duration: number,
    retries = 0,
  ) => ({
    id,
    testRunId,
    testCaseId: 1,
    status,
    duration,
    retries,
    createdAt: at(minutesAgo),
  });
  await db
    .insert(schema.testRunsCases)
    .values([
      execution(1, 1, 50, 'passed', 1000),
      execution(2, 2, 40, 'failed', 2000),
      execution(3, 3, 30, 'passed', 3000),
      execution(4, 4, 20, 'failed', 30_000),
      execution(5, 5, 10, 'failed', 30_000),
      execution(6, 5, 9, 'passed', 30_000, 1),
    ]);
});

describe('test case stats leave lab runs out', () => {
  test('the header counts real executions only', async () => {
    const testCase = await getTestCase(db as never, 1);
    expect(testCase).toMatchObject({
      totalRuns: 3,
      passedRuns: 2,
      failedRuns: 1,
      flakyRuns: 0,
      recentFlakyRuns: 0,
      avgDuration: 2000,
      passRate: 67,
      lastExecutionId: 3,
    });
    expect(testCase!.lastRunAt).toEqual(at(30));
    expect(testCase!.recentExecutions.map((e: { id: number }) => e.id)).toEqual([3, 2, 1]);
  });

  // Sorted by file, the page is picked first and only its tests' executions are joined.
  test.each(['lastRun', 'file'] as const)(
    'the test-cases list sorted by %s aggregates real executions only',
    async (sort) => {
      const { items } = await getProjectTestCases(db as never, 1, { maxAgeDays: 1, sort });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        totalRuns: 3,
        passedRuns: 2,
        failedRuns: 1,
        flakyRuns: 0,
        recentFlakyRuns: 0,
        avgDuration: 2000,
        lastStatus: 'passed',
        status: 'passed',
      });
      expect(items[0].lastRun).toBe(at(30).getTime());
    },
  );

  // These runs name no environment: a scope that names one leaves them all out.
  test('the test-cases list sorted by file leaves out a run with no environment from an environment scope', async () => {
    const scope = { environments: ['ci'], branches: [], allBranches: true, fullRunsOnly: false };
    const { items } = await getProjectTestCases(db as never, 1, { sort: 'file', scope });
    expect(items[0]).toMatchObject({ totalRuns: 0, passedRuns: 0, failedRuns: 0 });
  });

  test('the stability trend buckets real executions only', async () => {
    const trend = await getTestCaseStabilityTrend(db as never, 1, { days: 2, granularity: 'day', now: NOW });
    expect(trend.buckets.reduce((sum, b) => sum + b.totalRuns, 0)).toBe(3);
  });
});
