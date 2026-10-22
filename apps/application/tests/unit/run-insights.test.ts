import { describe, test, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler module (which imports the barrel) is loaded.
delete process.env.PIWI_DATABASE_URL;
const { computeRunInsights } = await import('../../shared/handlers/run-insights');
const { runOrigin } = await import('../../shared/run-eligibility');

let db: ReturnType<typeof drizzle<typeof schema>>;

const HOUR_MS = 60 * 60 * 1000;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  await db.insert(schema.projects).values({ id: 1, name: 'web' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/a.spec.ts', title: 'checkout' },
    { id: 2, projectId: 1, filePath: 'tests/a.spec.ts', title: 'login' },
    { id: 3, projectId: 1, filePath: 'tests/a.spec.ts', title: 'search' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 10, projectId: 1, status: 'passed', isFullRun: 1, startTime: new Date(Date.now() - 2 * HOUR_MS) },
    { id: 11, projectId: 1, status: 'failed', isFullRun: 1, startTime: new Date(Date.now() - HOUR_MS) },
  ]);
});

type Attempt = { testCaseId: number; browserName: string; status: string; retries: number; repeatEachIndex?: number };

async function attempts(testRunId: number, rows: Attempt[]) {
  await db.insert(schema.testRunsCases).values(rows.map((row) => ({ testRunId, ...row })));
}

describe('computeRunInsights', () => {
  test('compares the final attempt of each test on each browser', async () => {
    await attempts(10, [
      { testCaseId: 1, browserName: 'chromium', status: 'passed', retries: 0 },
      { testCaseId: 1, browserName: 'firefox', status: 'passed', retries: 0 },
      { testCaseId: 2, browserName: 'chromium', status: 'passed', retries: 0 },
      { testCaseId: 3, browserName: 'chromium', status: 'failed', retries: 0 },
      { testCaseId: 3, browserName: 'chromium', status: 'failed', retries: 1 },
    ]);
    await attempts(11, [
      // Failed three times on both browsers: one regression per browser, not six.
      { testCaseId: 1, browserName: 'chromium', status: 'failed', retries: 0 },
      { testCaseId: 1, browserName: 'chromium', status: 'failed', retries: 1 },
      { testCaseId: 1, browserName: 'chromium', status: 'failed', retries: 2 },
      { testCaseId: 1, browserName: 'firefox', status: 'failed', retries: 0 },
      { testCaseId: 1, browserName: 'firefox', status: 'failed', retries: 1 },
      { testCaseId: 1, browserName: 'firefox', status: 'failed', retries: 2 },
      // Failed once, then passed on retry: newly flaky, not a regression.
      { testCaseId: 2, browserName: 'chromium', status: 'failed', retries: 0 },
      { testCaseId: 2, browserName: 'chromium', status: 'passed', retries: 1 },
      // Failed in the baseline after a retry, passes now.
      { testCaseId: 3, browserName: 'chromium', status: 'passed', retries: 0 },
    ]);

    const insights = await computeRunInsights(db as never, 11);

    expect(insights.hasBaseline).toBe(true);
    expect(insights.newRegressions.map((r) => r.title)).toEqual(['checkout', 'checkout']);
    expect(insights.newFlaky.map((r) => r.title)).toEqual(['login']);
    expect(insights.flakyOnRetry.map((r) => r.title)).toEqual(['login']);
    expect(insights.recovered.map((r) => r.title)).toEqual(['search']);
    expect(insights.recurrences).toEqual([]);
    expect(insights).toMatchObject({ totalTests: 4, passedTests: 2, failedTests: 2, passRate: 50 });
    expect(insights).toMatchObject({ baselinePassRate: 75, passRateDelta: -25 });
  });

  test('lists a test flaky on retry once, whatever its repetitions', async () => {
    await attempts(10, [{ testCaseId: 2, browserName: 'chromium', status: 'passed', retries: 0 }]);
    await attempts(11, [
      { testCaseId: 2, browserName: 'chromium', status: 'failed', retries: 0, repeatEachIndex: 0 },
      { testCaseId: 2, browserName: 'chromium', status: 'passed', retries: 1, repeatEachIndex: 0 },
      { testCaseId: 2, browserName: 'chromium', status: 'failed', retries: 0, repeatEachIndex: 1 },
      { testCaseId: 2, browserName: 'chromium', status: 'failed', retries: 1, repeatEachIndex: 1 },
      { testCaseId: 2, browserName: 'chromium', status: 'passed', retries: 2, repeatEachIndex: 1 },
      { testCaseId: 2, browserName: 'chromium', status: 'passed', retries: 0, repeatEachIndex: 2 },
    ]);

    const insights = await computeRunInsights(db as never, 11);

    expect(insights.flakyOnRetry).toEqual([expect.objectContaining({ title: 'login', retries: 2 })]);
  });

  test('without a passing run, failedFallback compares with the last failed one', async () => {
    await db.insert(schema.projects).values({ id: 2, name: 'never-green', defaultBranch: 'main' });
    await db.insert(schema.testRuns).values(
      [
        {
          id: 20,
          projectId: 2,
          status: 'failed',
          isFullRun: 1,
          branch: 'main',
          startTime: new Date(Date.now() - 4 * HOUR_MS),
        },
        {
          id: 21,
          projectId: 2,
          status: 'interrupted',
          isFullRun: 1,
          branch: 'main',
          startTime: new Date(Date.now() - 3 * HOUR_MS),
        },
        {
          id: 22,
          projectId: 2,
          status: 'failed',
          isFullRun: 1,
          branch: 'main',
          startTime: new Date(Date.now() - 2 * HOUR_MS),
          metadata: { piwiProbe: true },
        },
        {
          id: 23,
          projectId: 2,
          status: 'failed',
          isFullRun: 1,
          branch: 'main',
          startTime: new Date(Date.now() - HOUR_MS),
        },
      ].map((row) => ({ ...row, origin: runOrigin(row.metadata) })),
    );
    await attempts(20, [
      { testCaseId: 1, browserName: 'chromium', status: 'passed', retries: 0 },
      { testCaseId: 2, browserName: 'chromium', status: 'failed', retries: 0 },
    ]);
    await attempts(23, [
      { testCaseId: 1, browserName: 'chromium', status: 'failed', retries: 0 },
      { testCaseId: 2, browserName: 'chromium', status: 'failed', retries: 0 },
    ]);

    const strict = await computeRunInsights(db as never, 23);
    expect(strict.hasBaseline).toBe(false);
    expect(strict.baseBranches).toEqual([]);

    const insights = await computeRunInsights(db as never, 23, { failedFallback: true });
    expect(insights.baseline?.id).toBe(20);
    expect(insights.baselineMatch).toEqual({ branch: 'same', environment: null, outcome: 'failed' });
    expect(insights.baselineNote).toBe('No earlier full run passed; the last failed run on main.');
    expect(insights.baseBranches).toEqual(['main']);
    expect(insights.newRegressions.map((r) => r.title)).toEqual(['checkout']);
    expect(insights.recurrences.map((r) => r.title)).toEqual(['login']);
    // Every earlier finished run is on offer, newest first, the probe run left out.
    expect(insights.earlierRuns.map((r) => [r.id, r.status])).toEqual([
      [21, 'interrupted'],
      [20, 'failed'],
    ]);
  });
});
