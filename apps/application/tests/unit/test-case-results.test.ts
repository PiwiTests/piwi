import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules load.
delete process.env.PIWI_DATABASE_URL;
const { getTestCase, getTestCaseStabilityTrend } = await import('../../shared/handlers/test-cases');
const { getProjectSpecHealth, getProjectTestCases } = await import('../../shared/handlers/projects');
const { loadSelectionCatalog } = await import('../../shared/handlers/selections');

let db: ReturnType<typeof drizzle<typeof schema>>;
/** Yesterday at noon UTC: every run of the fixture falls in one UTC day. */
const NOON = Date.parse(`${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`);

/**
 * "pays" (tests/cart) ran once in each of seven runs: passed twice, failed, timed
 * out, was skipped, did not run and was interrupted. "lists" (tests/admin) was
 * only ever skipped.
 */
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/cart/pay.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/admin/list.spec.ts', title: 'lists' },
  ]);
  const statuses = ['passed', 'passed', 'failed', 'timedout', 'skipped', 'didnotrun', 'interrupted'];
  await db.insert(schema.testRuns).values(
    statuses.map((_, i) => ({
      id: i + 1,
      projectId: 1,
      status: 'failed',
      startTime: new Date(NOON - (i + 1) * 60_000),
    })),
  );
  await db.insert(schema.testRunsCases).values([
    ...statuses.map((status, i) => ({
      testRunId: i + 1,
      testCaseId: 1,
      status,
      duration: 1000,
      browserName: 'chromium',
      createdAt: new Date(NOON - (i + 1) * 60_000),
    })),
    { testRunId: 1, testCaseId: 2, status: 'skipped', duration: 0, browserName: 'chromium' },
  ]);
});

describe('the pass rate of a test', () => {
  test('is its passed runs over the runs that passed or failed, on its page, in the catalog and in selections', async () => {
    expect((await getTestCase(db as never, 1))!.passRate).toBe(50);
    const catalog = await getProjectTestCases(db as never, 1);
    expect(catalog.items.find((t: any) => t.id === 1)!.passRate).toBe(0.5);
    expect(catalog.items.find((t: any) => t.id === 2)!.passRate).toBeNull();
    const selection = await loadSelectionCatalog(db as never, 1);
    expect(selection.find((t) => t.id === 1)!.passRate).toBe(0.5);
  });

  test('is the same rule on the Trend tab', async () => {
    const trend = await getTestCaseStabilityTrend(db as never, 1, { days: 2, granularity: 'day' });
    expect(trend.buckets.filter((b) => b.totalRuns > 0).map((b) => b.passRate)).toEqual([0.5]);
  });

  test('is the same rule in spec health, with none for an area no run passed or failed', async () => {
    const { specs } = await getProjectSpecHealth(db as never, 1, 30);
    expect(specs.find((s) => s.prefix === 'tests/cart')!.passRate).toBe(0.5);
    expect(specs.find((s) => s.prefix === 'tests/admin')!.passRate).toBeNull();
  });
});

describe("a test's runs", () => {
  let runsDb: ReturnType<typeof drizzle<typeof schema>>;

  /** One attempt of a test: the run, the Playwright project, the retry, how it ended and how long it took. */
  type Attempt = [testRunId: number, browserName: string, retries: number, status: string, duration: number];

  /**
   * The rows of a test's attempts, each with its attempt history as the reporter sends it: the attempts of its
   * run, project and repetition up to it. `history: false` leaves it out, as a trace import does.
   */
  function rows(testCaseId: number, attempts: Attempt[], opts: { repeatEachIndex?: number; history?: boolean } = {}) {
    const history: Array<{ retry: number; status: string }> = [];
    return attempts.map(([testRunId, browserName, retries, status, duration]) => {
      history.push({ retry: retries, status });
      return {
        testRunId,
        testCaseId,
        browserName,
        repeatEachIndex: opts.repeatEachIndex ?? 0,
        retries,
        status,
        duration,
        attempts: opts.history === false ? null : history.map((a) => ({ ...a })),
        createdAt: new Date(NOON - 60 * 60_000 + testRunId * 60_000 + retries * 1000),
      };
    });
  }

  /**
   * "checks out" in three runs, with retries, `--repeat-each` and two Playwright
   * projects: ten attempts, seven runs. "pays" failed, then passed on its
   * retry. "refunds" passed on a retry in a run imported without attempt
   * histories, where its first attempt passed too.
   */
  beforeAll(async () => {
    runsDb = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(runsDb);
    await runsDb.insert(schema.projects).values({ id: 1, name: 'shop' });
    await runsDb.insert(schema.testCases).values([
      { id: 10, projectId: 1, filePath: 'tests/checkout/flow.spec.ts', title: 'checks out' },
      { id: 11, projectId: 1, filePath: 'tests/checkout/pay.spec.ts', title: 'pays' },
      { id: 12, projectId: 1, filePath: 'tests/refund/refund.spec.ts', title: 'refunds' },
    ]);
    await runsDb.insert(schema.testRuns).values(
      [101, 102, 103, 104, 105].map((id, i) => ({
        id,
        projectId: 1,
        status: 'failed',
        startTime: new Date(NOON - (5 - i) * 60_000),
      })),
    );
    // A non-final attempt lasts 10 s, so an average that read one would show it.
    await runsDb.insert(schema.testRunsCases).values([
      // Flaky in chromium, timed out in firefox.
      ...rows(10, [
        [101, 'chromium', 0, 'failed', 10_000],
        [101, 'chromium', 1, 'passed', 200],
      ]),
      ...rows(10, [[101, 'firefox', 0, 'timedout', 300]]),
      // Three repetitions: passed, flaky, skipped.
      ...rows(10, [[102, 'chromium', 0, 'passed', 400]], { repeatEachIndex: 0 }),
      ...rows(
        10,
        [
          [102, 'chromium', 0, 'failed', 10_000],
          [102, 'chromium', 1, 'passed', 500],
        ],
        { repeatEachIndex: 1 },
      ),
      ...rows(10, [[102, 'chromium', 0, 'skipped', 0]], { repeatEachIndex: 2 }),
      // Retried with its serial group after a pass: not flaky. Interrupted in firefox.
      ...rows(10, [
        [103, 'chromium', 0, 'passed', 10_000],
        [103, 'chromium', 1, 'passed', 600],
      ]),
      ...rows(10, [[103, 'firefox', 0, 'interrupted', 700]]),
      ...rows(11, [
        [104, 'chromium', 0, 'failed', 10_000],
        [104, 'chromium', 1, 'passed', 100],
      ]),
      ...rows(
        12,
        [
          [105, 'chromium', 0, 'passed', 10_000],
          [105, 'chromium', 1, 'passed', 100],
        ],
        { history: false },
      ),
    ]);
  });

  test('are one result per run, project and repetition on its page', async () => {
    expect(await getTestCase(runsDb as never, 10)).toMatchObject({
      totalRuns: 7,
      passedRuns: 4,
      failedRuns: 1,
      skippedRuns: 1,
      timedOutRuns: 1,
      flakyRuns: 2,
      recentFlakyRuns: 2,
      passRate: 80,
      avgDuration: 450,
    });
  });

  test('are the same in the catalog and in selections', async () => {
    const catalog = await getProjectTestCases(runsDb as never, 1);
    expect(catalog.items.find((t: any) => t.id === 10)).toMatchObject({
      status: 'flaky',
      totalRuns: 7,
      passedRuns: 4,
      failedRuns: 1,
      skippedRuns: 1,
      didNotRunRuns: 0,
      flakyRuns: 2,
      recentFlakyRuns: 2,
      passRate: 0.8,
      avgDuration: 450,
    });
    const selection = await loadSelectionCatalog(runsDb as never, 1, { withFailRanks: true });
    expect(selection.find((t) => t.id === 10)).toMatchObject({
      totalRuns: 7,
      passRate: 0.8,
      flaky: true,
      avgDurationMs: 450,
    });
    // A pass on a retry is not a failure of the run.
    expect(selection.find((t) => t.id === 11)).toMatchObject({ totalRuns: 1, flaky: true, firstFailRank: null });
  });

  test('read a pass on a retry with no attempt history as flaky, as a final attempt with no earlier row', async () => {
    expect(await getTestCase(runsDb as never, 12)).toMatchObject({ totalRuns: 1, flakyRuns: 1, recentFlakyRuns: 1 });
  });

  test('are the same on the Trend tab and in spec health', async () => {
    const trend = await getTestCaseStabilityTrend(runsDb as never, 10, { days: 2, granularity: 'day' });
    expect(trend.buckets.filter((b) => b.totalRuns > 0)).toMatchObject([
      { totalRuns: 7, passRate: 0.8, flakyRate: 0.29, avgDuration: 450 },
    ]);
    const { specs } = await getProjectSpecHealth(runsDb as never, 1, 30);
    expect(specs.find((s) => s.prefix === 'tests/checkout')).toEqual({
      prefix: 'tests/checkout',
      passRate: 0.83,
      flakyRate: 0.38,
      failureCount: 1,
      testCount: 8,
      avgDuration: 400,
    });
  });
});
