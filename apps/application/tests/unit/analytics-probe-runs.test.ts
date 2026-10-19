import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules load.
delete process.env.PIWI_DATABASE_URL;
const { getAnalyticsPortfolio } = await import('../../shared/handlers/analytics/portfolio');
const { getAnalyticsWastedTime } = await import('../../shared/handlers/analytics/wasted-time');
const { getAnalyticsRegressionVelocity } = await import('../../shared/handlers/analytics/regression-velocity');
const { getAnalyticsBrowserMatrix } = await import('../../shared/handlers/analytics/browser-matrix');
const { getProjectsOverview, getProjectPerformance, getProjectSlowTests } =
  await import('../../shared/handlers/projects');
const { getRecentTestRuns } = await import('../../shared/handlers/test-runs');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { PROBE_RUN_METADATA_KEY } = await import('../../shared/handlers/probes');
const { runOrigin } = await import('../../shared/run-eligibility');
const { backfillDailyRollups } = await import('../../shared/handlers/analytics/rollups');

const DAY_MS = 24 * 60 * 60 * 1000;

let db: ReturnType<typeof drizzle<typeof schema>>;
let realRunId: number;
let probeRunId: number;

// Every filter off, so only the probe-run rule can keep the probe run out.
const OPEN_SCOPE = parseAnalyticsScope({ days: '30', fullRunsOnly: 'false' });

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'checkout.spec.ts', title: 'pays' });

  const [real] = await db
    .insert(schema.testRuns)
    .values({
      projectId: 1,
      status: 'passed',
      startTime: new Date(Date.now() - 2 * DAY_MS),
      duration: 60_000,
      totalTests: 1,
      passedTests: 1,
      isFullRun: 1,
    })
    .returning({ id: schema.testRuns.id });
  realRunId = real!.id;

  // A probe run fails on purpose. It is stamped a full run here so the
  // full-runs filter cannot hide it either.
  const probeMetadata = { [PROBE_RUN_METADATA_KEY]: true, scm: { branch: 'main' } };
  const [probe] = await db
    .insert(schema.testRuns)
    .values({
      projectId: 1,
      status: 'failed',
      startTime: new Date(Date.now() - DAY_MS),
      duration: 90_000,
      totalTests: 1,
      failedTests: 1,
      isFullRun: 1,
      metadata: probeMetadata,
      origin: runOrigin(probeMetadata),
    })
    .returning({ id: schema.testRuns.id });
  probeRunId = probe!.id;

  await db.insert(schema.testRunsCases).values([
    { testRunId: realRunId, testCaseId: 1, status: 'passed', duration: 1_000, browserName: 'chromium' },
    {
      testRunId: probeRunId,
      testCaseId: 1,
      status: 'failed',
      duration: 50_000,
      wastedTimeMs: 40_000,
      browserName: 'chromium',
      isNewRegression: 1,
    },
  ]);
  await backfillDailyRollups(db as any);
});

describe('probe runs are left out of analytics and project numbers', () => {
  test('the portfolio pass rate ignores the probe run', async () => {
    const [row] = await getAnalyticsPortfolio(db as any, OPEN_SCOPE);
    expect(row!.runCount).toBe(1);
    expect(row!.passRate).toBe(100);
    expect(row!.failingStreak).toBe(0);
  });

  test('execution-level widgets ignore the probe run', async () => {
    const wasted = await getAnalyticsWastedTime(db as any, OPEN_SCOPE);
    expect(wasted.totalWaitMinutes).toBe(0);
    expect(wasted.totalFailedExecMinutes).toBe(0);

    const velocity = await getAnalyticsRegressionVelocity(db as any, OPEN_SCOPE);
    expect(velocity.totalRegressions).toBe(0);

    const matrix = await getAnalyticsBrowserMatrix(db as any, OPEN_SCOPE);
    expect(matrix.rows[0]!.cells).toEqual([100]);
  });

  test('getProjectsOverview counts and lists only the real run', async () => {
    const [project] = await getProjectsOverview(db as any);
    expect(project!.totalFullRuns).toBe(1);
    expect(project!.latestFullRun!.id).toBe(realRunId);
    expect(project!.recentRuns.map((r: { id: number }) => r.id)).toEqual([realRunId]);
  });

  test('getProjectPerformance and getProjectSlowTests ignore the probe run', async () => {
    const performance = await getProjectPerformance(db as any, 1, 50, undefined, undefined, false);
    expect(performance.map((r) => r.id)).toEqual([realRunId]);

    const [slow] = await getProjectSlowTests(db as any, 1, 50);
    expect(slow!.runCount).toBe(1);
    expect(slow!.maxDuration).toBe(1_000);
  });

  test('getRecentTestRuns lists only the real run', async () => {
    const recent = await getRecentTestRuns(db as any);
    expect(recent.map((r) => r.id)).toEqual([realRunId]);
  });
});
