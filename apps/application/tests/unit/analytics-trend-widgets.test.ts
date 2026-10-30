import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { runAnalyticsWidget } = await import('../../shared/handlers/analytics');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { backfillDailyRollups } = await import('../../shared/handlers/analytics/rollups');
const { WIDGET_DOCUMENTS } = await import('../../shared/reports/widget-documents');
const { makeFormatter } = await import('../../shared/reports/format');
const { findMovers } = await import('../../shared/handlers/analytics/movers');
const { evaluateInsightRules } = await import('../../shared/analytics/insight-rules');
const { sentencesFor } = await import('../../shared/reports/sentences');

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
let db: ReturnType<typeof drizzle<typeof schema>>;

const docCtx = { f: makeFormatter('en'), s: sentencesFor('en'), baseUrl: null, markers: [], drawMarkers: true };

interface RunSeed {
  projectId: number;
  daysAgo: number;
  totalTests?: number;
  passedTests?: number;
  failedTests?: number;
  skippedTests?: number;
  didNotRunTests?: number;
  flakyTests?: number;
  environment?: string;
  status?: string;
}

async function seedRun(seed: RunSeed): Promise<number> {
  const [row] = await db
    .insert(schema.testRuns)
    .values({
      projectId: seed.projectId,
      status: seed.status ?? ((seed.failedTests ?? 0) > 0 ? 'failed' : 'passed'),
      startTime: daysAgo(seed.daysAgo),
      duration: 60_000,
      totalTests: seed.totalTests ?? 10,
      passedTests: seed.passedTests ?? 10,
      failedTests: seed.failedTests ?? 0,
      skippedTests: seed.skippedTests ?? 0,
      didNotRunTests: seed.didNotRunTests ?? 0,
      flakyTests: seed.flakyTests ?? 0,
      isFullRun: 1,
      environment: seed.environment,
    })
    .returning({ id: schema.testRuns.id });
  return row!.id;
}

const scope = (query: Record<string, string> = {}) => parseAnalyticsScope({ days: '14', ...query });

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'checkout' },
    { id: 2, name: 'search' },
  ]);
  // Previous period: a 10-test suite. Current period: it grows to 12, with skipped and not-run tests.
  const previousRun = await seedRun({ projectId: 1, daysAgo: 20, totalTests: 10, passedTests: 10 });
  const currentRun = await seedRun({
    projectId: 1,
    daysAgo: 5,
    totalTests: 12,
    passedTests: 10,
    skippedTests: 1,
    didNotRunTests: 1,
    flakyTests: 2,
  });
  await seedRun({ projectId: 2, daysAgo: 3, totalTests: 8, passedTests: 8 });
  await seedRun({ projectId: 2, daysAgo: 2, totalTests: 8, passedTests: 6, failedTests: 2, environment: 'staging' });
  await seedRun({ projectId: 2, daysAgo: 1, totalTests: 8, passedTests: 8, environment: 'staging' });

  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'pay.spec.ts', title: 'pays', owner: 'team-pay' },
    { id: 2, projectId: 1, filePath: 'cart.spec.ts', title: 'adds to cart', owner: 'team-cart' },
    { id: 3, projectId: 1, filePath: 'search.spec.ts', title: 'searches' },
  ]);
  await db.insert(schema.testRunsCases).values([
    // Test 1: stable before, flaky now and slower. Test 2: flaky before, stable now and faster.
    { testRunId: previousRun, testCaseId: 1, status: 'passed', duration: 1000, retries: 0 },
    { testRunId: previousRun, testCaseId: 2, status: 'passed', duration: 4000, retries: 1 },
    { testRunId: currentRun, testCaseId: 1, status: 'passed', duration: 3000, retries: 1, wastedTimeMs: 60_000 },
    { testRunId: currentRun, testCaseId: 2, status: 'passed', duration: 1000, retries: 0 },
    { testRunId: currentRun, testCaseId: 3, status: 'failed', duration: 120_000, retries: 0 },
  ]);
  await db.insert(schema.quarantinedTests).values([
    { projectId: 1, testCaseId: 3, createdAt: daysAgo(10) },
    { projectId: 1, testCaseId: 2, createdAt: daysAgo(25), releasedAt: daysAgo(12) },
  ]);
  const cluster = (id: number, over: Partial<typeof schema.failureClusters.$inferInsert>) => ({
    id,
    projectId: 1,
    fingerprint: `fp-${id}`,
    signature: `Error ${id}`,
    firstSeenRunId: previousRun,
    lastSeenRunId: currentRun,
    ...over,
  });
  await db.insert(schema.failureClusters).values([
    // Fixed in the period after 2 and 4 days; one regressed since.
    cluster(1, {
      status: 'resolved',
      createdAt: daysAgo(8),
      updatedAt: daysAgo(6),
      fixLandedAt: daysAgo(6),
      timeToResolutionMs: 2 * DAY_MS,
      assignee: 'team-pay',
    }),
    cluster(2, {
      status: 'resolved',
      createdAt: daysAgo(9),
      updatedAt: daysAgo(5),
      fixLandedAt: daysAgo(5),
      timeToResolutionMs: 4 * DAY_MS,
      fixVerification: 'regressed',
      assignee: 'team-pay',
    }),
    // Fixed in the comparison period after 1 day.
    cluster(3, {
      status: 'resolved',
      createdAt: daysAgo(22),
      updatedAt: daysAgo(21),
      fixLandedAt: daysAgo(21),
      timeToResolutionMs: DAY_MS,
    }),
    // Still open: one 40 days old and assigned, one opened in the period and unassigned.
    cluster(4, { status: 'open', createdAt: daysAgo(40), updatedAt: daysAgo(1), assignee: 'team-cart' }),
    cluster(5, { status: 'open', createdAt: daysAgo(3), updatedAt: daysAgo(1) }),
  ]);
  await backfillDailyRollups(db as any);
});

describe('suite growth', () => {
  test('reads the suite size, its change and the skipped and did-not-run shares', async () => {
    const data = (await runAnalyticsWidget(db as any, 'suite-growth', scope({ projects: '1' }))) as any;
    expect(data.suiteSize).toBe(12);
    expect(data.previousSuiteSize).toBe(10);
    expect(data.delta).toBe(2);
    expect(data.skippedPct).toBe(8.3);
    expect(data.didNotRunPct).toBe(8.3);
    expect(data.points.filter((p: any) => p.suiteSize !== null).map((p: any) => p.suiteSize)).toEqual([12]);
  });

  test('maps to a size series and a share series in a report', async () => {
    const data = await runAnalyticsWidget(db as any, 'suite-growth', scope({ projects: '1' }));
    const blocks = WIDGET_DOCUMENTS['suite-growth'](data, docCtx, {});
    expect(blocks.map((b) => b.kind)).toEqual(['series', 'series']);
    expect((blocks[0] as any).summary).toBe('Suite size: 12 (+2)');
  });
});

describe('flaky debt', () => {
  test('reads flaky occurrences per run, distinct flaky tests and the quarantine over time', async () => {
    const data = (await runAnalyticsWidget(db as any, 'flaky-debt', scope({ projects: '1' }))) as any;
    expect(data.flakyPerRun).toBe(2);
    expect(data.previousFlakyPerRun).toBe(0);
    expect(data.flakyTests).toBe(1);
    expect(data.quarantined).toBe(1);
    expect(data.previousQuarantined).toBe(1);
    const last = data.points[data.points.length - 1];
    expect(last.quarantined).toBe(1);
  });

  test('narrows to a test filter', async () => {
    const data = (await runAnalyticsWidget(
      db as any,
      'flaky-debt',
      scope({ projects: '1', browser: 'webkit' }),
    )) as any;
    expect(data.flakyTests).toBe(0);
  });

  test('maps to two series in a report', async () => {
    const data = await runAnalyticsWidget(db as any, 'flaky-debt', scope({ projects: '1' }));
    expect(WIDGET_DOCUMENTS['flaky-debt'](data, docCtx, {}).map((b) => b.kind)).toEqual(['series', 'series']);
  });
});

describe('time to fix', () => {
  test('counts opened and fixed causes, the median, p90 and held share, and open causes by age', async () => {
    const data = (await runAnalyticsWidget(db as any, 'time-to-fix', scope({ projects: '1' }))) as any;
    expect(data.opened).toBe(3);
    expect(data.fixed).toBe(2);
    expect(data.medianDays).toBe(3);
    expect(data.p90Days).toBe(4);
    expect(data.previousMedianDays).toBe(1);
    expect(data.fixesHeldPct).toBe(50);
    expect(data.openByAge.map((g: any) => g.count)).toEqual([0, 1, 0, 1, 0]);
    expect(data.points.reduce((n: number, p: any) => n + p.fixed, 0)).toBe(2);
  });

  test('maps to tiles, a series and the age table in a report', async () => {
    const data = await runAnalyticsWidget(db as any, 'time-to-fix', scope({ projects: '1' }));
    expect(WIDGET_DOCUMENTS['time-to-fix'](data, docCtx, {}).map((b) => b.kind)).toEqual(['stats', 'series', 'table']);
  });
});

describe('ownership', () => {
  test('one row per owner, the Unowned row last', async () => {
    const data = (await runAnalyticsWidget(db as any, 'ownership', scope({ projects: '1' }))) as any;
    expect(data.totalOpenClusters).toBe(2);
    expect(data.rows.map((r: any) => r.owner)).toEqual(['team-cart', 'team-pay', null]);
    const pay = data.rows.find((r: any) => r.owner === 'team-pay');
    expect(pay).toMatchObject({ openClusters: 0, flakyTests: 1, wastedMinutes: 1, medianTimeToFixDays: 3 });
    const unowned = data.rows.find((r: any) => r.owner === null);
    // The unassigned open cause, and the failed test with no owner (two minutes of failed attempt).
    expect(unowned).toMatchObject({ openClusters: 1, flakyTests: 0, wastedMinutes: 2 });
  });

  test('keeps the Unowned row whatever the limit', async () => {
    const data = (await runAnalyticsWidget(db as any, 'ownership', scope({ projects: '1' }), 'all', {
      limit: 5,
    })) as any;
    expect(data.rows[data.rows.length - 1].owner).toBeNull();
  });

  test('maps to a table in a report', async () => {
    const data = await runAnalyticsWidget(db as any, 'ownership', scope({ projects: '1' }));
    const [block] = WIDGET_DOCUMENTS.ownership(data, docCtx, {}) as any[];
    expect(block.kind).toBe('table');
    expect(block.rows.map((r: any) => r.cells.owner)).toEqual(['team-cart', 'team-pay', 'Unowned']);
  });
});

describe('environment comparison', () => {
  test('one row per environment with its pass rate, run success and runs', async () => {
    const data = (await runAnalyticsWidget(db as any, 'environment-comparison', scope({ projects: '2' }))) as any;
    const byEnv = Object.fromEntries(data.rows.map((r: any) => [r.environment, r]));
    expect(byEnv.staging.passRate.value).toBe(87.5);
    expect(byEnv.staging.runSuccessRate.value).toBe(50);
    expect(byEnv.staging.runs).toBe(2);
    expect(byEnv[''].label).toBe('No environment');
    expect(byEnv[''].passRate.value).toBe(100);
    expect(byEnv.staging.points.some((p: any) => p.value !== null)).toBe(true);
  });

  test('maps to a series and a table in a report', async () => {
    const data = await runAnalyticsWidget(db as any, 'environment-comparison', scope({ projects: '2' }));
    expect(WIDGET_DOCUMENTS['environment-comparison'](data, docCtx, {}).map((b) => b.kind)).toEqual([
      'series',
      'table',
    ]);
  });
});

describe('movers', () => {
  test('finds the tests that became flaky and stopped being flaky against the comparison period', async () => {
    const data = (await runAnalyticsWidget(db as any, 'movers', scope({ projects: '1' }))) as any;
    expect(data.comparisonLabel).not.toBeNull();
    const kinds = Object.fromEntries(data.groups.map((g: any) => [g.kind, g.items.map((i: any) => i.title)]));
    expect(kinds).toEqual({ 'became-flaky': ['pays'], 'stopped-flaky': ['adds to cart'] });
  });

  test('without a comparison there is nothing to move against', async () => {
    const data = (await runAnalyticsWidget(db as any, 'movers', scope({ projects: '1', compare: 'none' }))) as any;
    expect(data).toEqual({ groups: [], comparisonLabel: null });
  });

  test('a duration moves past 25 %, with enough executions and above the noise floor', () => {
    const stat = (avg: number, executions = 3, flaky = 0) => ({
      projectId: 1,
      testCaseId: avg,
      executions,
      flaky,
      avgPassedMs: avg,
    });
    const key = (s: { testCaseId: number }) => `1:${s.testCaseId}`;
    const pairs = [
      [stat(1000), stat(1300)], // +30 % → slower
      [stat(2000), stat(1400)], // −30 % → faster
      [stat(3000), stat(3600)], // +20 % → no move
      [stat(50), stat(150)], // under the noise floor
      [stat(4000, 1), stat(8000, 1)], // too few executions
    ] as const;
    const previous = new Map(pairs.map(([a]) => [key(a), a]));
    const current = new Map(pairs.map(([a, b]) => [key(a), { ...b, testCaseId: a.testCaseId }]));
    const moves = findMovers(current, previous);
    expect(moves.map((m) => [m.testCaseId, m.kind, m.changePct])).toEqual([
      [1000, 'slower', 30],
      [2000, 'faster', -30],
    ]);
  });

  test('maps to one table per direction in a report', async () => {
    const data = await runAnalyticsWidget(db as any, 'movers', scope({ projects: '1' }));
    expect(WIDGET_DOCUMENTS.movers(data, docCtx, {}).map((b) => b.kind)).toEqual(['table', 'table']);
  });
});

describe('the trend insight rules', () => {
  const base = {
    scope: parseAnalyticsScope({ days: '14' }),
    portfolio: [],
    ciTime: {
      points: [],
      bucketDays: 1,
      totalMinutes: 0,
      runCount: 0,
      prevTotalMinutes: null,
      deltaPct: null,
      avgRunMinutes: null,
    },
    wastedTime: {
      points: [],
      bucketDays: 1,
      totalWaitMinutes: 0,
      totalFailedExecMinutes: 0,
      byProject: [],
      cost: null,
      timeoutReclaimable: null,
    },
    clusters: { totalOpen: 0, resolvedInPeriod: 0, byErrorType: [], clusters: [] },
    flakyTests: [],
    regressionVelocity: {
      points: [],
      bucketDays: 1,
      totalRegressions: 0,
      totalNewFlaky: 0,
      prevRegressions: null,
      deltaPct: null,
    },
    slowEndpoints: { endpoints: [], totalRequests: 0 },
    timeoutHygiene: { rows: [], oversizedCount: 0, staleSlowCount: 0, totalEstimatedSavingMs: 0, topProjectId: null },
  };
  const ttf = (medianDays: number | null, previousMedianDays: number | null, fixed = 4) => ({
    points: [],
    bucketDays: 1,
    opened: 0,
    fixed,
    medianDays,
    p90Days: null,
    previousMedianDays,
    fixesHeldPct: null,
    openByAge: [],
  });
  const ids = (ctx: object) => evaluateInsightRules({ ...base, ...ctx } as any).map((i) => i.ruleId);

  test('time-to-fix-growth fires when the median is half again as long and a day longer', () => {
    expect(ids({ timeToFix: ttf(3, 1.5) })).toEqual(['time-to-fix-growth']);
    expect(ids({ timeToFix: ttf(2, 1.5) })).toEqual([]);
    expect(ids({ timeToFix: ttf(6, 2, 2) })).toEqual([]);
    const [insight] = evaluateInsightRules({ ...base, timeToFix: ttf(4, 2) } as any);
    expect(insight!.severity).toBe('warning');
    expect(insight!.message).toBe('Median time to fix grew to 4 days vs the previous 14 days');
  });

  test('suite-shrank fires past five tests and five percent', () => {
    const growth = (suiteSize: number, previousSuiteSize: number) => ({
      points: [],
      bucketDays: 1,
      suiteSize,
      previousSuiteSize,
      delta: suiteSize - previousSuiteSize,
      skippedPct: null,
      didNotRunPct: null,
    });
    expect(ids({ suiteGrowth: growth(90, 100) })).toEqual(['suite-shrank']);
    expect(ids({ suiteGrowth: growth(96, 100) })).toEqual([]);
    expect(ids({ suiteGrowth: growth(900, 1000) })).toEqual(['suite-shrank']);
    expect(ids({ suiteGrowth: growth(960, 1000) })).toEqual([]);
  });

  test('quarantine-debt-growth fires on three more tests, or half again as many', () => {
    const debt = (quarantined: number, previousQuarantined: number) => ({
      points: [],
      bucketDays: 1,
      flakyPerRun: null,
      previousFlakyPerRun: null,
      flakyTests: 0,
      quarantined,
      previousQuarantined,
    });
    expect(ids({ flakyDebt: debt(5, 2) })).toEqual(['quarantine-debt-growth']);
    expect(ids({ flakyDebt: debt(3, 2) })).toEqual(['quarantine-debt-growth']);
    expect(ids({ flakyDebt: debt(11, 10) })).toEqual([]);
  });

  test('owner-load fires when one owner holds more than half the open failure causes', () => {
    const row = (owner: string | null, openClusters: number) => ({
      owner,
      openClusters,
      flakyTests: 0,
      wastedMinutes: 0,
      medianTimeToFixDays: null,
    });
    expect(ids({ ownership: { rows: [row('team-pay', 3), row(null, 2)], totalOpenClusters: 5 } })).toEqual([
      'owner-load',
    ]);
    expect(ids({ ownership: { rows: [row('team-pay', 2), row('team-cart', 2)], totalOpenClusters: 4 } })).toEqual([]);
    // The Unowned row is nobody's load.
    expect(ids({ ownership: { rows: [row(null, 4), row('team-pay', 1)], totalOpenClusters: 5 } })).toEqual([]);
  });

  test('the insights widget evaluates them over the seeded data', async () => {
    const insights = (await runAnalyticsWidget(db as any, 'insights', scope({ projects: '1' }))) as any[];
    expect(Array.isArray(insights)).toBe(true);
  });
});

describe('the stability trend of a test case', () => {
  test('buckets its executions by time, a bucket without an execution a gap', async () => {
    const { getTestCaseStabilityTrend } = await import('../../shared/handlers/test-cases');
    const trend = await getTestCaseStabilityTrend(db as any, 1, { days: 30, granularity: 'day' });
    expect(trend.bucketDays).toBe(1);
    expect(trend.buckets).toHaveLength(30);
    const ran = trend.buckets.filter((b) => b.totalRuns > 0);
    expect(ran.map((b) => [b.totalRuns, b.passRate, b.flakyRate, b.avgDuration])).toEqual([
      [1, 1, 0, 1000],
      [1, 1, 1, 3000],
    ]);
    expect(trend.buckets.find((b) => b.totalRuns === 0)!.passRate).toBeNull();
    await expect(getTestCaseStabilityTrend(db as any, 999)).rejects.toThrow('Test case not found');
  });
});

describe('the occurrence trend of a failure cluster', () => {
  test('buckets its failing executions and marks the fix and the first failure after it', async () => {
    const { getClusterOccurrenceTrend } = await import('../../shared/handlers/failure-clusters');
    const failing = await db
      .select({ id: schema.testRunsCases.id, runId: schema.testRunsCases.testRunId })
      .from(schema.testRunsCases);
    // The failed execution of test 3 (5 days ago) belongs to cluster 1, fixed 6 days ago.
    const { eq } = await import('drizzle-orm');
    const execution = failing.find((r) => r.id === 5)!;
    await db.update(schema.testRunsCases).set({ failureClusterId: 1 }).where(eq(schema.testRunsCases.id, execution.id));
    const trend = await getClusterOccurrenceTrend(db as any, 1, { days: 30 });
    expect(trend.buckets.reduce((n, b) => n + b.occurrences, 0)).toBe(1);
    expect(trend.buckets.reduce((n, b) => n + b.tests, 0)).toBe(1);
    expect(trend.fixLandedAt).not.toBeNull();
    expect(trend.regressedAt).not.toBeNull();
    expect(new Date(trend.regressedAt!).getTime()).toBeGreaterThan(new Date(trend.fixLandedAt!).getTime());
    await db
      .update(schema.testRunsCases)
      .set({ failureClusterId: null })
      .where(eq(schema.testRunsCases.id, execution.id));
    await expect(getClusterOccurrenceTrend(db as any, 999)).rejects.toThrow('Failure cluster not found');
  });
});
