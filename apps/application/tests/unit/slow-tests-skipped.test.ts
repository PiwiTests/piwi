import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { getProjectSlowTests } = await import('../../shared/handlers/projects');

let db: ReturnType<typeof drizzle<typeof schema>>;

/** The test's executions, oldest first: four 10-second passes, then runs that skipped it or never ran it (0 ms). */
const EXECUTIONS = [
  { status: 'passed', duration: 10_000 },
  { status: 'passed', duration: 10_000 },
  { status: 'passed', duration: 10_000 },
  { status: 'passed', duration: 10_000 },
  { status: 'skipped', duration: 0 },
  { status: 'didnotrun', duration: 0 },
  { status: 'skipped', duration: 0 },
];

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'adds to cart' });
  const now = Date.now();
  await db.insert(schema.testRuns).values(
    EXECUTIONS.map((_, i) => ({
      id: i + 1,
      projectId: 1,
      status: 'passed',
      startTime: new Date(now - (EXECUTIONS.length - i) * 60_000),
    })),
  );
  await db
    .insert(schema.testRunsCases)
    .values(EXECUTIONS.map((e, i) => ({ testRunId: i + 1, testCaseId: 1, status: e.status, duration: e.duration })));
});

describe('the slowest tests', () => {
  test('time only the executions that ran: a skip or a test that did not run is no faster run', async () => {
    const [slow] = await getProjectSlowTests(db as never, 1, 50);
    expect(slow).toMatchObject({
      avgDuration: 10_000,
      minDuration: 10_000,
      latestDuration: 10_000,
      runCount: 4,
      trend: 'stable',
    });
  });
});
