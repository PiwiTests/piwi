import { beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_CI_MINUTE_COST;
const { runAnalyticsWidget } = await import('../../shared/handlers/analytics');
const { backfillDailyRollups } = await import('../../shared/handlers/analytics/rollups');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { metricBreakdowns } = await import('../../shared/analytics/registry');

const DAY_MS = 24 * 60 * 60 * 1000;
let db: ReturnType<typeof drizzle<typeof schema>>;
const BROWSERS = ['chromium', 'firefox', 'webkit', 'mobile-chrome', 'mobile-safari', 'edge', 'tablet'];

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'checkout' },
    { id: 2, name: 'search' },
  ]);
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/cart/add.spec.ts', title: 'add', owner: 'payments', tags: ['smoke'] },
    { id: 2, projectId: 1, filePath: 'tests/cart/remove.spec.ts', title: 'remove', owner: 'payments', tags: [] },
    { id: 3, projectId: 2, filePath: 'tests/find.spec.ts', title: 'find', owner: null, tags: ['smoke', 'slow'] },
  ]);
  const now = Date.now();
  const runs = [
    { projectId: 1, environment: 'staging', passed: 8 },
    { projectId: 1, environment: 'production', passed: 10 },
    { projectId: 2, environment: 'staging', passed: 5 },
  ];
  for (const [i, r] of runs.entries()) {
    const [run] = await db
      .insert(schema.testRuns)
      .values({
        projectId: r.projectId,
        status: r.passed === 10 ? 'passed' : 'failed',
        startTime: new Date(now - (i + 1) * DAY_MS),
        duration: 60_000,
        totalTests: 10,
        passedTests: r.passed,
        failedTests: 10 - r.passed,
        environment: r.environment,
        isFullRun: 1,
      })
      .returning();
    // One execution per browser: the first two fail and waste a minute each.
    await db.insert(schema.testRunsCases).values(
      BROWSERS.map((browserName, b) => ({
        testRunId: run!.id,
        testCaseId: r.projectId === 1 ? 1 + (b % 2) : 3,
        status: b < 2 ? 'failed' : 'passed',
        duration: 60_000,
        wastedTimeMs: 0,
        browserName,
      })),
    );
  }
  await backfillDailyRollups(db as any);
});

const scope = () => parseAnalyticsScope({ period: 'last-30d' });

async function metric(options: Record<string, unknown>, query: Record<string, string> = { period: 'last-30d' }) {
  return (await runAnalyticsWidget(db as any, 'metric', parseAnalyticsScope(query), 'all', options)) as any;
}

describe('the metric widget breakdowns', () => {
  test('a metric lists the breakdowns its source can cut', () => {
    expect(metricBreakdowns('test-pass-rate')).toContain('browser');
    expect(metricBreakdowns('run-success-rate')).not.toContain('browser');
    expect(metricBreakdowns('open-failure-causes')).toEqual(
      expect.arrayContaining(['project', 'error-type', 'assignee']),
    );
  });

  test('by project from the rollups, each group reading what the widget reads for that project alone', async () => {
    const data = await metric({ metric: 'test-pass-rate', display: 'bar', breakdown: 'project' });
    expect(data.breakdown.label).toBe('Project');
    const byLabel = Object.fromEntries(data.breakdown.groups.map((g: any) => [g.label, g.value.value]));
    expect(byLabel).toEqual({ search: 50, checkout: 90 });
    const alone = await metric({ metric: 'test-pass-rate', display: 'stat' }, { period: 'last-30d', projects: '1' });
    expect(alone.value.value).toBe(90);
  });

  test('by environment, worst first', async () => {
    const data = await metric({ metric: 'run-success-rate', display: 'table', breakdown: 'environment' });
    expect(data.breakdown.groups.map((g: any) => [g.label, g.value.value])).toEqual([
      ['staging', 0],
      ['production', 100],
    ]);
  });

  test('by browser from the executions, the rest grouped as Other', async () => {
    const data = await metric({ metric: 'wasted-ci-minutes', display: 'bar', breakdown: 'browser', top: 5 });
    const groups = data.breakdown.groups;
    expect(groups).toHaveLength(6);
    expect(groups.slice(0, 2).map((g: any) => g.value.value)).toEqual([3, 3]);
    expect(groups.at(-1)).toMatchObject({ other: true, label: 'Other (2)' });
    const total = groups.reduce((sum: number, g: any) => sum + (g.value.value ?? 0), 0);
    expect(total).toBe(6);
  });

  test('by owner, tests without one grouped as No owner', async () => {
    const data = await metric({ metric: 'test-pass-rate', display: 'table', breakdown: 'owner' });
    expect(data.breakdown.groups.map((g: any) => g.label).sort()).toEqual(['No owner', 'payments']);
  });

  test('a line per group carries each group’s series', async () => {
    const data = await metric({ metric: 'test-pass-rate', display: 'line', breakdown: 'project' });
    expect(data.display).toBe('line');
    for (const g of data.breakdown.groups) expect(g.points.length).toBeGreaterThan(0);
  });

  test('without a breakdown the displays over time keep the series; stat keeps one number', async () => {
    expect((await metric({ display: 'bar' })).points.length).toBeGreaterThan(0);
    expect((await metric({ display: 'heatmap' })).display).toBe('heatmap');
    const stat = await metric({ display: 'stat', breakdown: 'project' });
    expect(stat).toMatchObject({ display: 'stat', breakdown: null });
    expect(scope().period).toEqual({ kind: 'rolling', days: 30 });
  });

  test('a metric with no series falls back to stat, or to bars per group', async () => {
    expect((await metric({ metric: 'flaky-tests', display: 'line' })).display).toBe('stat');
    expect((await metric({ metric: 'flaky-tests', display: 'line', breakdown: 'project' })).display).toBe('bar');
  });
});
