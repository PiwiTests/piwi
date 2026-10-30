import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { getRecentTestRuns } = await import('../../shared/handlers/test-runs');

let db: ReturnType<typeof drizzle<typeof schema>>;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const QUIET = 2;

/**
 * A busy project with forty completed runs in the last two days, and a quiet
 * one with a run in progress and two completed runs from last week.
 */
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'busy' },
    { id: QUIET, name: 'quiet' },
  ]);
  for (let i = 1; i <= 40; i++) {
    await db.insert(schema.testRuns).values({ projectId: 1, status: 'passed', startTime: new Date(NOW - i * HOUR) });
  }
  await db.insert(schema.testRuns).values([
    { id: 100, projectId: QUIET, status: 'running', startTime: new Date(NOW - 10 * 60 * 1000) },
    { id: 101, projectId: QUIET, status: 'passed', startTime: new Date(NOW - 7 * 24 * HOUR) },
    { id: 102, projectId: QUIET, status: 'failed', startTime: new Date(NOW - 8 * 24 * HOUR) },
  ]);
});

describe('getRecentTestRuns', () => {
  test("a user assigned to a quiet project sees that project's recent runs", async () => {
    const runs = await getRecentTestRuns(db as never, new Set([QUIET]));
    expect(runs.map((r) => r.id)).toEqual([100, 101, 102]);
  });

  test('an unrestricted user sees the active runs and the 30 most recent completed ones', async () => {
    const runs = await getRecentTestRuns(db as never, 'all');
    expect(runs).toHaveLength(31);
    expect(runs[0]!.id).toBe(100);
    expect(runs.every((r) => r.id === 100 || r.projectId === 1)).toBe(true);
  });

  test('a user with no project sees none', async () => {
    expect(await getRecentTestRuns(db as never, new Set())).toEqual([]);
  });
});
