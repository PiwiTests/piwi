import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { withStoredVerdicts } from './stored-verdicts';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler module (which imports the barrel) is loaded.
delete process.env.PIWI_DATABASE_URL;
const { computeRunInsights } = await import('../../shared/handlers/run-insights');
const { runOrigin } = await import('../../shared/run-eligibility');

let db: ReturnType<typeof drizzle<typeof schema>>;

const HOUR_MS = 60 * 60 * 1000;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
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

type Attempt = {
  testCaseId: number;
  browserName: string;
  status: string;
  retries: number;
  repeatEachIndex?: number;
  workerIndex?: number;
  parallelIndex?: number;
  shardIndex?: number;
};

async function attempts(testRunId: number, rows: Attempt[]) {
  await db.insert(schema.testRunsCases).values(withStoredVerdicts(rows.map((row) => ({ testRunId, ...row }))));
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

  test('reads a pass rate over the tests that passed or failed, and none when no test did', async () => {
    await attempts(10, [
      { testCaseId: 1, browserName: 'chromium', status: 'skipped', retries: 0 },
      { testCaseId: 2, browserName: 'chromium', status: 'didnotrun', retries: 0 },
    ]);
    await attempts(11, [
      { testCaseId: 1, browserName: 'chromium', status: 'passed', retries: 0 },
      { testCaseId: 2, browserName: 'chromium', status: 'skipped', retries: 0 },
      { testCaseId: 3, browserName: 'chromium', status: 'didnotrun', retries: 0 },
      { testCaseId: 3, browserName: 'firefox', status: 'interrupted', retries: 0 },
    ]);

    const insights = await computeRunInsights(db as never, 11);

    expect(insights).toMatchObject({ totalTests: 4, passedTests: 1, failedTests: 0, passRate: 100 });
    expect(insights).toMatchObject({ baselinePassRate: null, passRateDelta: null });
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

  test('counts the tests of each worker by its lane, a worker Playwright started again once', async () => {
    await attempts(10, [{ testCaseId: 1, browserName: 'chromium', status: 'passed', retries: 0 }]);
    await attempts(11, [
      // Lane 0: its first process failed, and its retry ran in the process Playwright started in its place.
      { testCaseId: 1, browserName: 'chromium', status: 'failed', retries: 0, workerIndex: 0, parallelIndex: 0 },
      { testCaseId: 1, browserName: 'chromium', status: 'passed', retries: 1, workerIndex: 2, parallelIndex: 0 },
      { testCaseId: 1, browserName: 'firefox', status: 'passed', retries: 0, workerIndex: 0, parallelIndex: 0 },
      { testCaseId: 2, browserName: 'chromium', status: 'passed', retries: 0, workerIndex: 1, parallelIndex: 1 },
      { testCaseId: 3, browserName: 'chromium', status: 'passed', retries: 0, workerIndex: 1, parallelIndex: 1 },
    ]);

    const insights = await computeRunInsights(db as never, 11);

    expect(insights.workerImbalance).toEqual([
      { worker: 1, workerIndex: null, shardIndex: null, count: 2 },
      { worker: 2, workerIndex: null, shardIndex: null, count: 2 },
    ]);
    expect(insights.workerImbalanceWarning).toBeNull();
  });

  test('counts the workers of each shard apart, and names them as the run page does', async () => {
    await attempts(10, [{ testCaseId: 1, browserName: 'chromium', status: 'passed', retries: 0 }]);
    const ran = (testCaseId: number, browserName: string, shardIndex: number, parallelIndex: number): Attempt => ({
      testCaseId,
      browserName,
      status: 'passed',
      retries: 0,
      workerIndex: parallelIndex,
      parallelIndex,
      shardIndex,
    });
    await attempts(11, [
      ran(1, 'chromium', 1, 0),
      ran(1, 'firefox', 1, 0),
      ran(1, 'webkit', 1, 0),
      ran(2, 'chromium', 2, 0),
      ran(3, 'chromium', 2, 1),
      ran(3, 'firefox', 2, 1),
    ]);

    const insights = await computeRunInsights(db as never, 11);

    expect(insights.workerImbalance).toEqual([
      { worker: 1, workerIndex: null, shardIndex: 1, count: 3 },
      { worker: 1, workerIndex: null, shardIndex: 2, count: 1 },
      { worker: 2, workerIndex: null, shardIndex: 2, count: 2 },
    ]);
    expect(insights.workerImbalanceWarning).toBe('Worker 1 of shard 1 ran 3\u00d7 more tests than worker 1 of shard 2');
  });

  test('counts the results of a reporter that sends no lane by their worker process', async () => {
    await attempts(10, [{ testCaseId: 1, browserName: 'chromium', status: 'passed', retries: 0 }]);
    await attempts(11, [
      { testCaseId: 1, browserName: 'chromium', status: 'passed', retries: 0, workerIndex: 0 },
      { testCaseId: 2, browserName: 'chromium', status: 'passed', retries: 0, workerIndex: 1 },
      { testCaseId: 3, browserName: 'chromium', status: 'passed', retries: 0, workerIndex: 1 },
    ]);

    const insights = await computeRunInsights(db as never, 11);

    expect(insights.workerImbalance).toEqual([
      { worker: null, workerIndex: 0, shardIndex: null, count: 1 },
      { worker: null, workerIndex: 1, shardIndex: null, count: 2 },
    ]);
    expect(insights.workerImbalanceWarning).toBe('Worker 1 ran 2\u00d7 more tests than worker 0');
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
