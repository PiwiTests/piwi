import { beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the handler.
delete process.env.PIWI_DATABASE_URL;
const { getProject, listProjects } = await import('../../shared/handlers/projects');

/**
 * The interrupted results a run list row and a project's latest run carry: the gap the run's counters leave, named.
 * Each result counts once, from its final attempt, as the counters count every outcome.
 */

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);

  await db.insert(schema.projects).values({ id: 1, name: 'Shop' });
  await db
    .insert(schema.testCases)
    .values([1, 2, 3].map((id) => ({ id, projectId: 1, filePath: 'a.spec.ts', title: `t${id}` })));
  await db.insert(schema.testRuns).values([
    // A Ctrl+C run: one test passed, one cut short in two Playwright projects, one never ran.
    {
      id: 1,
      projectId: 1,
      status: 'interrupted',
      startTime: at(1),
      isFullRun: 1,
      totalTests: 4,
      passedTests: 1,
      didNotRunTests: 1,
    },
    // Cut short on retries, and swept before its fourth test reported: t1's retry was cut short too, and t2's retry
    // passed after its first attempt was.
    { id: 2, projectId: 1, status: 'interrupted', startTime: at(2), isFullRun: 1, totalTests: 4, passedTests: 2 },
    // A run with no interrupted result.
    { id: 3, projectId: 1, status: 'passed', startTime: at(3), isFullRun: 1, totalTests: 2, passedTests: 2 },
    // Counters that leave no gap: an interrupted row never pushes the bar past its total.
    { id: 4, projectId: 1, status: 'passed', startTime: at(4), isFullRun: 1, totalTests: 1, passedTests: 1 },
  ]);
  const row = (testRunId: number, testCaseId: number, status: string, extra: Record<string, unknown> = {}) => ({
    testRunId,
    testCaseId,
    status,
    duration: 100,
    browserName: 'chromium',
    ...extra,
  });
  await db
    .insert(schema.testRunsCases)
    .values([
      row(1, 1, 'passed'),
      row(1, 2, 'interrupted'),
      row(1, 2, 'interrupted', { browserName: 'firefox' }),
      row(1, 3, 'didnotrun'),
      row(2, 1, 'interrupted', { retries: 0 }),
      row(2, 1, 'interrupted', { retries: 1 }),
      row(2, 2, 'interrupted', { retries: 0 }),
      row(2, 2, 'passed', { retries: 1 }),
      row(2, 3, 'passed'),
      row(3, 1, 'passed'),
      row(3, 2, 'passed'),
      row(4, 1, 'interrupted'),
    ]);
});

describe('interrupted results on run rows', () => {
  test("counts each run's final attempts cut short, once per test and Playwright project", async () => {
    const project = await getProject(db as never, 1);
    const byId = new Map(project.testRuns.map((r: { id: number; interruptedTests: number }) => [r.id, r]));
    expect(byId.get(1)).toMatchObject({ interruptedTests: 2 });
    expect(byId.get(2)).toMatchObject({ interruptedTests: 1 });
    expect(byId.get(3)).toMatchObject({ interruptedTests: 0 });
    expect(byId.get(4)).toMatchObject({ interruptedTests: 0 });
  });

  test("the row's outcomes and interrupted results add up to its total when every test reported", async () => {
    const project = await getProject(db as never, 1);
    for (const r of project.testRuns) {
      const parts = r.passedTests + r.failedTests + r.skippedTests + r.didNotRunTests + r.interruptedTests;
      if (r.id === 2) expect(parts, 'a test never reported').toBe(r.totalTests - 1);
      else expect(parts, `run ${r.id}`).toBe(r.totalTests);
    }
  });

  test("a project's latest run carries them", async () => {
    const [shop] = await listProjects(db as never);
    expect(shop.latestRun).toMatchObject({ id: 1, interruptedTests: 2 });
  });
});
