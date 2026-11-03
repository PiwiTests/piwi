import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules load.
delete process.env.PIWI_DATABASE_URL;
const { getAnalyticsPortfolio } = await import('../../shared/handlers/analytics/portfolio');
const { getAnalyticsPassRateHeatmap } = await import('../../shared/handlers/analytics/pass-rate-heatmap');
const { getAnalyticsBrowserMatrix } = await import('../../shared/handlers/analytics/browser-matrix');
const { getAnalyticsStats } = await import('../../shared/handlers/analytics/stats');
const { backfillDailyRollups } = await import('../../shared/handlers/analytics/rollups');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const SCOPE = parseAnalyticsScope({ days: '30' });

let db: ReturnType<typeof drizzle<typeof schema>>;

/**
 * Project 1 skips most of its suite by design: each run passes 6 tests, fails 2,
 * skips 10 and does not run 2. Project 2 ran nothing to an outcome. On
 * project 1's latest run, a test failed then passed on its retry in chromium,
 * and was skipped in webkit.
 */
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'docs' },
  ]);
  const run = (id: number, projectId: number, days: number, counts: Partial<typeof schema.testRuns.$inferInsert>) => ({
    id,
    projectId,
    status: 'failed',
    startTime: daysAgo(days),
    isFullRun: 1,
    duration: 60_000,
    ...counts,
  });
  const mostlySkipped = { totalTests: 20, passedTests: 6, failedTests: 2, skippedTests: 10, didNotRunTests: 2 };
  await db
    .insert(schema.testRuns)
    .values([
      run(1, 1, 5, mostlySkipped),
      run(2, 1, 2, { ...mostlySkipped, flakyTests: 1 }),
      run(3, 2, 2, { status: 'passed', totalTests: 4, passedTests: 0, skippedTests: 4 }),
    ]);
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'pays' });
  await db.insert(schema.testRunsCases).values([
    { testRunId: 2, testCaseId: 1, status: 'failed', retries: 0, browserName: 'chromium', finalAttempt: false },
    { testRunId: 2, testCaseId: 1, status: 'passed', retries: 1, browserName: 'chromium' },
    { testRunId: 2, testCaseId: 1, status: 'skipped', retries: 0, browserName: 'webkit' },
  ]);
  await backfillDailyRollups(db as never);
});

describe('the analytics pass rate', () => {
  test('rates the tests that passed or failed, skipped and did-not-run ones in neither term', async () => {
    const stats = await getAnalyticsStats(db as never, SCOPE, 'all', { metrics: ['test-pass-rate'] });
    // 12 passed and 4 failed over project 1's two runs; project 2 adds neither.
    expect(stats.tiles[0]).toMatchObject({ metric: 'test-pass-rate', value: 75 });
  });

  test('gives a project with no passed or failed test no pass rate in the portfolio and the heatmap', async () => {
    const portfolio = await getAnalyticsPortfolio(db as never, SCOPE, 'all');
    expect(portfolio.find((p) => p.projectId === 1)!.passRate).toBe(75);
    expect(portfolio.find((p) => p.projectId === 2)!.passRate).toBeNull();

    const heatmap = await getAnalyticsPassRateHeatmap(db as never, SCOPE, 'all');
    expect(heatmap.rows.map((r) => r.projectId)).toEqual([1]);
    expect(heatmap.rows[0]!.cells.filter((c) => c !== null)).toEqual([75, 75]);
  });

  test('counts a pass on a retry as passed, and a skipped test in no term, in the browser matrix', async () => {
    const matrix = await getAnalyticsBrowserMatrix(db as never, SCOPE, 'all');
    expect(matrix.browsers).toEqual(['chromium', 'webkit']);
    expect(matrix.rows[0]!.cells).toEqual([100, null]);
  });
});
