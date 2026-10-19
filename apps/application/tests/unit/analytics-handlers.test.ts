import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel (server/database/schema.ts) picks the PostgreSQL schema at
// import time when PIWI_DATABASE_URL is set, so clear it before the handler
// modules (which import the barrel) are loaded.
delete process.env.PIWI_DATABASE_URL;
const { runAnalyticsWidget, isAnalyticsWidgetId } = await import('../../shared/handlers/analytics');
const { getAnalyticsPortfolio } = await import('../../shared/handlers/analytics/portfolio');
const { getAnalyticsPassRateHeatmap } = await import('../../shared/handlers/analytics/pass-rate-heatmap');
const { getAnalyticsCiTimeTrend } = await import('../../shared/handlers/analytics/ci-time-trend');
const { getAnalyticsWastedTime } = await import('../../shared/handlers/analytics/wasted-time');
const { getAnalyticsClusterLandscape } = await import('../../shared/handlers/analytics/cluster-landscape');
const { getAnalyticsRegressionVelocity } = await import('../../shared/handlers/analytics/regression-velocity');
const { getAnalyticsBrowserMatrix } = await import('../../shared/handlers/analytics/browser-matrix');
const { getAnalyticsSlowEndpoints } = await import('../../shared/handlers/analytics/slow-endpoints');
const { evaluateInsightRules } = await import('../../shared/analytics/insight-rules');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { ALL_TIME_DAYS } = await import('../../shared/analytics/period');
const { ANALYTICS_WIDGETS, ANALYTICS_BANDS } = await import('../../shared/analytics/registry');
const { backfillDailyRollups } = await import('../../shared/handlers/analytics/rollups');
const { getAnalyticsStats } = await import('../../shared/handlers/analytics/stats');
const { getAnalyticsMetric } = await import('../../shared/handlers/analytics/metric');
const { getAnalyticsVerdict } = await import('../../shared/handlers/analytics/verdict');
const { getAnalyticsRisks } = await import('../../shared/handlers/analytics/risks');
const { getAnalyticsProgress } = await import('../../shared/handlers/analytics/progress');
const { WidgetOptionsError, WIDGET_METRIC_IDS } = await import('../../shared/analytics/registry');
const { EVALUATED_METRIC_IDS } = await import('../../shared/handlers/analytics/metric-values');
const { sentencesFor } = await import('../../shared/reports/sentences');
const { makeFormatter } = await import('../../shared/reports/format');

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

let db: ReturnType<typeof drizzle<typeof schema>>;

interface RunSeed {
  projectId: number;
  status?: string;
  daysAgo: number;
  duration?: number;
  totalTests?: number;
  passedTests?: number;
  failedTests?: number;
  flakyTests?: number;
  isFullRun?: number;
  environment?: string;
}

async function seedRun(seed: RunSeed): Promise<number> {
  const inserted = await db
    .insert(schema.testRuns)
    .values({
      projectId: seed.projectId,
      status: seed.status ?? 'passed',
      startTime: daysAgo(seed.daysAgo),
      duration: seed.duration ?? 60_000,
      totalTests: seed.totalTests ?? 10,
      passedTests: seed.passedTests ?? 10,
      failedTests: seed.failedTests ?? 0,
      flakyTests: seed.flakyTests ?? 0,
      isFullRun: seed.isFullRun ?? 1,
      environment: seed.environment,
    })
    .returning({ id: schema.testRuns.id });
  return inserted[0]!.id;
}

const DEFAULT_SCOPE = parseAnalyticsScope({ days: '30' });

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });

  await db.insert(schema.projects).values([
    { id: 1, name: 'checkout' },
    { id: 2, name: 'search', label: 'Search suite' },
    { id: 3, name: 'idle-project' },
  ]);

  // Project 1: previous period healthy (100%), current period degraded and
  // ending on a 3-run failing streak.
  await seedRun({ projectId: 1, daysAgo: 45, passedTests: 10 });
  await seedRun({ projectId: 1, daysAgo: 40, passedTests: 10 });
  await seedRun({ projectId: 1, daysAgo: 10, passedTests: 8, failedTests: 2, status: 'failed' });
  const failingRunId = await seedRun({ projectId: 1, daysAgo: 5, passedTests: 7, failedTests: 3, status: 'failed' });
  await seedRun({ projectId: 1, daysAgo: 2, passedTests: 7, failedTests: 3, status: 'failed' });

  // Project 2: healthy in the current period, staging environment, one flaky run.
  await seedRun({ projectId: 2, daysAgo: 8, environment: 'staging', flakyTests: 2 });
  await seedRun({ projectId: 2, daysAgo: 3, environment: 'staging' });
  // Partial run — must be excluded when fullRunsOnly (the default).
  await seedRun({ projectId: 2, daysAgo: 1, isFullRun: 0, passedTests: 1, totalTests: 1 });
  // Non-terminal run — never counted.
  await seedRun({ projectId: 2, daysAgo: 1, status: 'running' });

  // Wasted time + regression signals + browser split on project 1's latest failing run.
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'checkout.spec.ts', title: 'pays' });
  const insertedCases = await db
    .insert(schema.testRunsCases)
    .values([
      {
        testRunId: failingRunId,
        testCaseId: 1,
        status: 'failed',
        duration: 120_000,
        wastedTimeMs: 60_000,
        browserName: 'chromium',
        isNewRegression: 1,
      },
      {
        testRunId: failingRunId,
        testCaseId: 1,
        status: 'passed',
        duration: 30_000,
        retries: 1,
        wastedTimeMs: 0,
        browserName: 'webkit',
        isNewFlaky: 1,
      },
    ])
    .returning({ id: schema.testRunsCases.id });

  // Network requests captured on those executions — one slow shared endpoint.
  await db.insert(schema.networkRequests).values([
    {
      testRunsCaseId: insertedCases[0]!.id,
      testRunId: failingRunId,
      method: 'GET',
      normalizedUrl: '/api/cart',
      status: 200,
      duration: 1500,
    },
    {
      testRunsCaseId: insertedCases[0]!.id,
      testRunId: failingRunId,
      method: 'GET',
      normalizedUrl: '/api/cart',
      status: 500,
      duration: 2500,
    },
    {
      testRunsCaseId: insertedCases[1]!.id,
      testRunId: failingRunId,
      method: 'GET',
      normalizedUrl: '/api/cart',
      status: 200,
      duration: 1800,
    },
  ]);

  // Clusters: one old open on project 1, one fresh open + one resolved on project 2.
  await db.insert(schema.failureClusters).values([
    {
      projectId: 1,
      fingerprint: 'fp-1',
      signature: 'TimeoutError: locator.click',
      errorType: 'timeout',
      firstSeenRunId: 1,
      lastSeenRunId: failingRunId,
      status: 'open',
      occurrences: 25,
      createdAt: daysAgo(40),
      updatedAt: daysAgo(2),
    },
    {
      projectId: 2,
      fingerprint: 'fp-2',
      signature: 'expect(received).toBe',
      errorType: 'assertion',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      status: 'open',
      occurrences: 3,
      createdAt: daysAgo(3),
      updatedAt: daysAgo(3),
    },
    {
      projectId: 2,
      fingerprint: 'fp-3',
      signature: 'net::ERR_CONNECTION_REFUSED',
      errorType: 'navigation',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
      status: 'resolved',
      occurrences: 5,
      createdAt: daysAgo(20),
      updatedAt: daysAgo(4),
    },
  ]);

  // The scalar widgets read the daily rollups: compute them from the seeded runs.
  await backfillDailyRollups(db as any);
});

describe('analytics registry', () => {
  test('recognizes registered widget ids and rejects unknown ones', () => {
    for (const widget of ANALYTICS_WIDGETS) {
      expect(isAnalyticsWidgetId(widget.id)).toBe(true);
    }
    expect(isAnalyticsWidgetId('nope')).toBe(false);
    expect(isAnalyticsWidgetId(undefined)).toBe(false);
  });

  test('runAnalyticsWidget dispatches every registered widget', async () => {
    for (const widget of ANALYTICS_WIDGETS) {
      const result = await runAnalyticsWidget(db, widget.id, DEFAULT_SCOPE, 'all');
      expect(result).toBeDefined();
    }
  });

  test('every widget sits in a declared band, and every band has widgets', () => {
    const bandIds = new Set(ANALYTICS_BANDS.map((b) => b.id));
    for (const widget of ANALYTICS_WIDGETS) {
      expect(bandIds.has(widget.band)).toBe(true);
    }
    // An empty band would render a heading over nothing.
    for (const band of ANALYTICS_BANDS) {
      expect(ANALYTICS_WIDGETS.some((w) => w.band === band.id)).toBe(true);
    }
  });
});

describe('analytics scope parsing', () => {
  test('applies defaults and reads the legacy keys', () => {
    expect(parseAnalyticsScope(undefined)).toEqual({
      period: { kind: 'rolling', days: 30 },
      comparison: { kind: 'previous' },
      granularity: 'auto',
      defaultBranchOnly: true,
      fullRunsOnly: true,
    });
    expect(parseAnalyticsScope({ days: '99999' }).period).toEqual({ kind: 'all' });
    expect(
      parseAnalyticsScope(
        new URLSearchParams('days=7&projects=1,2&environments=staging,prod&branches=main&fullRunsOnly=false'),
      ),
    ).toMatchObject({
      period: { kind: 'rolling', days: 7 },
      projectIds: [1, 2],
      environments: ['staging', 'prod'],
      branches: ['main'],
      defaultBranchOnly: false,
      fullRunsOnly: false,
    });
    // The legacy singular keys still parse, folded into the multi-value form.
    expect(parseAnalyticsScope({ environment: 'staging', branch: 'main' })).toMatchObject({
      environments: ['staging'],
      branches: ['main'],
    });
    expect(ALL_TIME_DAYS).toBe(3650);
  });
});

describe('getAnalyticsPortfolio', () => {
  test('computes pass rate, delta vs previous period, and failing streak', async () => {
    const rows = await getAnalyticsPortfolio(db, DEFAULT_SCOPE, 'all');
    const checkout = rows.find((r) => r.projectId === 1)!;

    // Current period: 22 passed / 30 total = 73.3%; previous period 100%.
    expect(checkout.runCount).toBe(3);
    expect(checkout.passRate).toBeCloseTo(73.3, 1);
    expect(checkout.passRateDelta).toBeCloseTo(-26.7, 1);
    expect(checkout.failingStreak).toBe(3);
    expect(checkout.openClusters).toBe(1);
    expect(checkout.latestRun?.status).toBe('failed');

    // Worst health sorts first; the idle project sorts last.
    expect(rows[0]!.projectId).toBe(1);
    expect(rows[rows.length - 1]!.projectId).toBe(3);
  });

  test('excludes partial and non-terminal runs by default', async () => {
    const rows = await getAnalyticsPortfolio(db, DEFAULT_SCOPE, 'all');
    const search = rows.find((r) => r.projectId === 2)!;
    expect(search.runCount).toBe(2);
    expect(search.passRate).toBe(100);
    expect(search.flakyTests).toBe(2);
  });

  test('includes partial runs when fullRunsOnly is off', async () => {
    const rows = await getAnalyticsPortfolio(db, parseAnalyticsScope({ days: '30', fullRunsOnly: 'false' }), 'all');
    const search = rows.find((r) => r.projectId === 2)!;
    expect(search.runCount).toBe(3);
  });

  test('respects the access scope and the requested project filter', async () => {
    const restricted = await getAnalyticsPortfolio(db, DEFAULT_SCOPE, new Set([2]));
    expect(restricted.map((r) => r.projectId)).toEqual([2]);

    // Requested projects outside the access scope are dropped.
    const scope = parseAnalyticsScope({ days: '30', projects: '1,2' });
    const intersected = await getAnalyticsPortfolio(db, scope, new Set([2]));
    expect(intersected.map((r) => r.projectId)).toEqual([2]);
  });

  test('filters by environment', async () => {
    const scope = parseAnalyticsScope({ days: '30', environment: 'staging' });
    const rows = await getAnalyticsPortfolio(db, scope, 'all');
    expect(rows.find((r) => r.projectId === 2)!.runCount).toBe(2);
    expect(rows.find((r) => r.projectId === 1)!.runCount).toBe(0);
  });
});

describe('getAnalyticsPassRateHeatmap', () => {
  test('buckets pass rates over the full selected window and drops run-less projects', async () => {
    const heatmap = await getAnalyticsPassRateHeatmap(db, DEFAULT_SCOPE, 'all');
    expect(heatmap.bucketDays).toBe(1);
    // Bounded periods render the whole window, so the axis always spans the full
    // 30 days the user selected — even though the oldest seeded run is 10 days old.
    expect(heatmap.buckets.length).toBe(30);
    expect(heatmap.rows.map((r) => r.projectId).sort()).toEqual([1, 2]);

    const checkout = heatmap.rows.find((r) => r.projectId === 1)!;
    const values = checkout.cells.filter((c) => c !== null);
    expect(values).toHaveLength(3);
    expect(values).toContain(70); // 7/10 on the latest failing runs
  });

  test('widens buckets for long periods', async () => {
    const heatmap = await getAnalyticsPassRateHeatmap(db, parseAnalyticsScope({ days: '365' }), 'all');
    expect(heatmap.bucketDays).toBeGreaterThan(1);
    expect(heatmap.buckets.length).toBeLessThanOrEqual(32);
  });

  test('trims leading empty buckets only for the unbounded All time window', async () => {
    const heatmap = await getAnalyticsPassRateHeatmap(db, parseAnalyticsScope({ days: String(ALL_TIME_DAYS) }), 'all');
    // All seeded runs are recent, so the years of leading blank buckets are
    // dropped and the first rendered column already carries data.
    expect(heatmap.rows.some((r) => r.cells[0] !== null)).toBe(true);
  });
});

describe('getAnalyticsCiTimeTrend', () => {
  test('sums minutes for the period and compares with the previous one', async () => {
    const trend = await getAnalyticsCiTimeTrend(db, DEFAULT_SCOPE, 'all');
    // 5 full terminal runs in the current period × 1 min each.
    expect(trend.runCount).toBe(5);
    expect(trend.totalMinutes).toBe(5);
    expect(trend.prevTotalMinutes).toBe(2);
    expect(trend.deltaPct).toBe(150);
    expect(trend.avgRunMinutes).toBe(1);
    expect(trend.points.reduce((sum, p) => sum + p.runCount, 0)).toBe(5);
  });
});

describe('getAnalyticsWastedTime', () => {
  test('aggregates wait time and failed-attempt time', async () => {
    const wasted = await getAnalyticsWastedTime(db, DEFAULT_SCOPE, 'all');
    expect(wasted.totalWaitMinutes).toBe(1); // 60s of wait steps
    expect(wasted.totalFailedExecMinutes).toBe(2); // one 120s failed attempt
    expect(wasted.byProject[0]!.projectId).toBe(1);
    expect(wasted.points.reduce((sum, p) => sum + p.waitMinutes, 0)).toBe(1);
  });

  test('returns an empty shape when the access scope has no projects', async () => {
    const wasted = await getAnalyticsWastedTime(db, DEFAULT_SCOPE, new Set<number>());
    expect(wasted.totalWaitMinutes).toBe(0);
    expect(wasted.byProject).toEqual([]);
  });
});

describe('getAnalyticsClusterLandscape', () => {
  test('counts open clusters, resolved-in-period, and error-type mix', async () => {
    const landscape = await getAnalyticsClusterLandscape(db, DEFAULT_SCOPE, 'all');
    expect(landscape.totalOpen).toBe(2);
    expect(landscape.resolvedInPeriod).toBe(1);
    expect(landscape.byErrorType).toEqual([
      { errorType: 'timeout', count: 1 },
      { errorType: 'assertion', count: 1 },
    ]);

    const top = landscape.clusters[0]!;
    expect(top.occurrences).toBe(25);
    expect(top.ageDays).toBeGreaterThanOrEqual(39);
    expect(top.projectName).toBe('checkout');
  });

  test('respects the access scope', async () => {
    const landscape = await getAnalyticsClusterLandscape(db, DEFAULT_SCOPE, new Set([2]));
    expect(landscape.totalOpen).toBe(1);
    expect(landscape.clusters[0]!.projectId).toBe(2);
  });
});

describe('insight rules', () => {
  test('fires on the seeded data through the full pipeline', async () => {
    const insights = (await runAnalyticsWidget(db, 'insights', DEFAULT_SCOPE, 'all')) as Array<{
      ruleId: string;
      severity: string;
    }>;
    const ruleIds = insights.map((i) => i.ruleId);
    expect(ruleIds).toContain('failing-streak');
    expect(ruleIds).toContain('pass-rate-drop');
    expect(ruleIds).toContain('stale-cluster');
    // Critical findings sort before informational ones.
    const severities = insights.map((i) => i.severity);
    expect(severities.indexOf('critical')).toBe(0);
  });

  test('rules are pure and independently evaluable', () => {
    const insights = evaluateInsightRules({
      scope: DEFAULT_SCOPE,
      portfolio: [],
      ciTime: {
        points: [],
        bucketDays: 1,
        totalMinutes: 100,
        runCount: 10,
        prevTotalMinutes: 50,
        deltaPct: 100,
        avgRunMinutes: 10,
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
      timeoutHygiene: { rows: [], oversizedCount: 0, staleSlowCount: 0, totalEstimatedSavingMs: 0 },
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]!.ruleId).toBe('ci-time-growth');
    expect(insights[0]!.severity).toBe('warning');
  });

  test('regression-surge and slow-shared-endpoint rules fire on their inputs', () => {
    const insights = evaluateInsightRules({
      scope: DEFAULT_SCOPE,
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
        totalRegressions: 12,
        totalNewFlaky: 3,
        prevRegressions: 4,
        deltaPct: 200,
      },
      slowEndpoints: {
        endpoints: [
          {
            method: 'GET',
            route: '/api/cart',
            requests: 40,
            p50Ms: 900,
            p90Ms: 1800,
            maxMs: 2500,
            errorRate: 12.5,
            projectCount: 3,
          },
        ],
        totalRequests: 40,
      },
      timeoutHygiene: { rows: [], oversizedCount: 0, staleSlowCount: 0, totalEstimatedSavingMs: 0 },
    });
    const ruleIds = insights.map((i) => i.ruleId);
    expect(ruleIds).toContain('regression-surge');
    expect(ruleIds).toContain('slow-shared-endpoint');
  });
});

describe('getAnalyticsRegressionVelocity', () => {
  test('counts new regressions and newly-flaky executions', async () => {
    const velocity = await getAnalyticsRegressionVelocity(db, DEFAULT_SCOPE, 'all');
    expect(velocity.totalRegressions).toBe(1);
    expect(velocity.totalNewFlaky).toBe(1);
    expect(velocity.points.some((p) => p.regressions > 0)).toBe(true);
  });
});

describe('getAnalyticsBrowserMatrix', () => {
  test('builds a project × browser pass-rate grid', async () => {
    const matrix = await getAnalyticsBrowserMatrix(db, DEFAULT_SCOPE, 'all');
    expect(matrix.browsers).toEqual(['chromium', 'webkit']);
    const checkout = matrix.rows.find((r) => r.projectId === 1)!;
    const chromiumRate = checkout.cells[matrix.browsers.indexOf('chromium')];
    const webkitRate = checkout.cells[matrix.browsers.indexOf('webkit')];
    expect(chromiumRate).toBe(0); // the one chromium execution failed
    expect(webkitRate).toBe(100); // the one webkit execution passed
  });
});

describe('getAnalyticsSlowEndpoints', () => {
  test('aggregates network requests by route with percentiles and error rate', async () => {
    const slow = await getAnalyticsSlowEndpoints(db, DEFAULT_SCOPE, 'all');
    expect(slow.totalRequests).toBe(3);
    const cart = slow.endpoints.find((e) => e.route === '/api/cart')!;
    expect(cart.method).toBe('GET');
    expect(cart.requests).toBe(3);
    expect(cart.maxMs).toBe(2500);
    expect(cart.errorRate).toBeCloseTo(33.3, 1); // 1 of 3 was a 500
    expect(cart.projectCount).toBe(1);
  });

  test('respects the access scope', async () => {
    const slow = await getAnalyticsSlowEndpoints(db, DEFAULT_SCOPE, new Set([2]));
    expect(slow.totalRequests).toBe(0);
    expect(slow.endpoints).toEqual([]);
  });
});

describe('branch policy and test filters', () => {
  let fdb: ReturnType<typeof drizzle<typeof schema>>;

  async function run(projectId: number, day: number, extra: Partial<typeof schema.testRuns.$inferInsert> = {}) {
    const [row] = await fdb
      .insert(schema.testRuns)
      .values({
        projectId,
        status: 'passed',
        startTime: daysAgo(day),
        duration: 60_000,
        totalTests: 2,
        passedTests: 2,
        isFullRun: 1,
        ...extra,
      })
      .returning({ id: schema.testRuns.id });
    return row!.id;
  }

  beforeAll(async () => {
    fdb = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(fdb, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    await fdb.insert(schema.projects).values([
      { id: 1, name: 'shop', defaultBranch: 'main' },
      { id: 2, name: 'admin' },
    ]);
    await fdb.insert(schema.testCases).values([
      { id: 10, projectId: 1, filePath: 'pay.spec.ts', title: 'pays', tags: ['smoke'] },
      { id: 11, projectId: 1, filePath: 'cart.spec.ts', title: 'adds to cart', tags: [] },
      { id: 20, projectId: 2, filePath: 'login.spec.ts', title: 'logs in', tags: ['smoke'] },
    ]);
    await fdb.insert(schema.testSelections).values({
      projectId: 1,
      key: 'checkout',
      name: 'Checkout',
      definition: { include: [{ files: ['pay.spec.ts'] }] },
    });

    // Project 1: one run on main, one with no branch, one on a feature branch.
    const onMain = await run(1, 3, { branch: 'main' });
    await run(1, 2);
    const onFeature = await run(1, 1, { branch: 'feature/x', status: 'failed', passedTests: 0, failedTests: 2 });
    await fdb.insert(schema.testRunsCases).values([
      { testRunId: onMain, testCaseId: 10, status: 'passed', duration: 1_000, browserName: 'chromium' },
      { testRunId: onMain, testCaseId: 11, status: 'passed', duration: 1_000, browserName: 'webkit' },
      { testRunId: onFeature, testCaseId: 10, status: 'failed', duration: 2_000, browserName: 'chromium' },
      { testRunId: onFeature, testCaseId: 11, status: 'failed', duration: 2_000, browserName: 'webkit' },
    ]);
    // Project 2 reports no branch: its runs count under the default-branch policy.
    const adminRun = await run(2, 2);
    await fdb
      .insert(schema.testRunsCases)
      .values([{ testRunId: adminRun, testCaseId: 20, status: 'passed', duration: 500, browserName: 'chromium' }]);
    await backfillDailyRollups(fdb as any);
  });

  const portfolioOf = async (query: Record<string, string>, projectId: number) =>
    (await getAnalyticsPortfolio(fdb, parseAnalyticsScope({ days: '30', ...query }))).find(
      (r) => r.projectId === projectId,
    )!;

  test('the default branch policy counts the default branch, and unknown-branch runs only where no branch is known', async () => {
    expect((await portfolioOf({}, 1)).runCount).toBe(1);
    expect((await portfolioOf({}, 1)).passRate).toBe(100);
    expect((await portfolioOf({}, 2)).runCount).toBe(1);
  });

  test('All branches counts everything, and a branch picked by hand counts only it', async () => {
    expect((await portfolioOf({ allBranches: 'true' }, 1)).runCount).toBe(3);
    const feature = await portfolioOf({ branches: 'feature/x' }, 1);
    expect(feature.runCount).toBe(1);
    expect(feature.passRate).toBe(0);
  });

  test('a test tag counts from the matching executions', async () => {
    const all = await portfolioOf({ allBranches: 'true', tags: 'smoke' }, 1);
    // Only `pays` is tagged smoke: passed on main, failed on the feature branch.
    expect(all.runCount).toBe(2);
    expect(all.passRate).toBe(50);
  });

  test('a selection key resolves per project, and a project without it is left out and named', async () => {
    const scope = parseAnalyticsScope({ days: '30', allBranches: 'true', sel: 'checkout' });
    const rows = await getAnalyticsPortfolio(fdb, scope);
    expect(rows.map((r) => r.projectId)).toEqual([1]);
    expect(rows[0]!.passRate).toBe(50);
    const { getAnalyticsContext } = await import('../../shared/handlers/analytics/common');
    const ctx = await getAnalyticsContext(fdb as any, scope);
    expect(ctx.notes.join(' ')).toMatch(/admin has no selection "checkout"/);
  });

  test('a browser filter narrows the executions', async () => {
    const webkit = await portfolioOf({ allBranches: 'true', browsers: 'webkit' }, 1);
    expect(webkit.passRate).toBe(50);
    const matrix = await getAnalyticsBrowserMatrix(fdb, parseAnalyticsScope({ days: '30', browsers: 'webkit' }));
    expect(matrix.browsers).toEqual(['webkit']);
  });

  test('widgets that read the rollups agree with the stored runs', async () => {
    const trend = await getAnalyticsCiTimeTrend(fdb, parseAnalyticsScope({ days: '30', allBranches: 'true' }));
    expect(trend.runCount).toBe(4);
    expect(trend.totalMinutes).toBe(4);
  });
});

describe('metric widgets', () => {
  test('every metric a widget can show has an evaluator', () => {
    for (const id of WIDGET_METRIC_IDS) expect(EVALUATED_METRIC_IDS, id).toContain(id);
  });

  test('stats: values over the period with their change against the previous one', async () => {
    const stats = await getAnalyticsStats(db, DEFAULT_SCOPE, 'all', {
      metrics: ['test-pass-rate', 'run-success-rate', 'flaky-tests', 'open-failure-causes', 'wasted-ci-minutes'],
    });
    const tile = (id: string) => stats.tiles.find((t) => t.metric === id)!;
    // 22/30 on checkout + 20/20 on search = 42/50; the previous period was 20/20.
    expect(tile('test-pass-rate')).toMatchObject({ value: 84, previous: 100, delta: -16, trend: 'worse' });
    expect(tile('run-success-rate')).toMatchObject({ value: 40, previous: 100, trend: 'worse' });
    expect(tile('flaky-tests').value).toBe(1);
    expect(tile('open-failure-causes').value).toBe(2);
    // No cost of a CI minute is configured, so the wasted minutes carry no cost.
    expect(tile('wasted-ci-minutes').companion).toBeNull();
    expect(stats.comparisonLabel).toBe('The previous period');
  });

  test('metric: a line with the comparison aligned bucket for bucket, or a single value', async () => {
    const line = await getAnalyticsMetric(db, DEFAULT_SCOPE, 'all', { metric: 'test-pass-rate', display: 'line' });
    expect(line.display).toBe('line');
    expect(line.points.length).toBeGreaterThan(0);
    expect(line.previousPoints).toHaveLength(line.points.length);
    expect(line.points.some((p) => p.value !== null)).toBe(true);
    const stat = await getAnalyticsMetric(db, DEFAULT_SCOPE, 'all', { metric: 'open-failure-causes', display: 'line' });
    expect(stat.display).toBe('stat');
    expect(stat.value.value).toBe(2);
  });

  test('widget options are checked against the schema', async () => {
    await expect(runAnalyticsWidget(db, 'metric', DEFAULT_SCOPE, 'all', { metric: 'nope' })).rejects.toBeInstanceOf(
      WidgetOptionsError,
    );
  });

  test('verdict: a sharp drop reads as bad, in English and in French', async () => {
    const verdict = await getAnalyticsVerdict(db, DEFAULT_SCOPE, 'all');
    expect(verdict.tone).toBe('bad');
    expect(verdict.facts).toMatchObject({ runs: 5, passRate: 84, passRateDelta: -16, open: 2 });
    const en = sentencesFor('en').verdict(verdict.facts, makeFormatter('en'));
    expect(en).toContain('fell 16 points to 84%');
    expect(en).toContain('2 failure causes are still open.');
    const fr = sentencesFor('fr').verdict(verdict.facts, makeFormatter('fr'));
    expect(fr).toContain('a perdu 16 points');
  });

  test('risks: the pass-rate drop, the failing streak and the oldest open cause', async () => {
    const risks = await getAnalyticsRisks(db, DEFAULT_SCOPE, 'all');
    expect(risks.worsening.map((w) => w.metric)).toContain('test-pass-rate');
    expect(risks.failingProjects).toEqual([{ projectId: 1, name: 'checkout', streak: 3 }]);
    expect(risks.oldestOpen[0]).toMatchObject({ projectName: 'checkout', ageDays: 40 });
    expect(risks.openCount).toBe(2);
  });

  test('risks: a quarantine dated after now reads as today, never a negative age', async () => {
    const [row] = await db
      .insert(schema.quarantinedTests)
      .values({ projectId: 1, testCaseId: 1, createdAt: daysAgo(-7) })
      .returning({ id: schema.quarantinedTests.id });
    try {
      const risks = await getAnalyticsRisks(db, DEFAULT_SCOPE, 'all');
      expect(risks.quarantine).toEqual({ count: 1, oldestDays: 0 });
    } finally {
      await db.delete(schema.quarantinedTests).where(eq(schema.quarantinedTests.id, row!.id));
    }
  });

  test('progress: nothing fixed in the period says so', async () => {
    const progress = await getAnalyticsProgress(db, DEFAULT_SCOPE, 'all');
    expect(progress.fixed).toBe(0);
    expect(sentencesFor('en').progress(progress, makeFormatter('en'))[0]).toBe(
      'No failure cause was fixed in the period.',
    );
  });
});
