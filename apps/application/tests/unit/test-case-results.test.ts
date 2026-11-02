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
