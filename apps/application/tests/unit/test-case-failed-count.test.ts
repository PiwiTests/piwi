import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { getTestCase } = await import('../../shared/handlers/test-cases');

let db: ReturnType<typeof drizzle<typeof schema>>;

/** Each execution of the test, one per run: the outcome its header counts. */
const STATUSES = ['passed', 'failed', 'timedout', 'timedOut', 'interrupted', 'skipped'];

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'adds to cart' });
  await db
    .insert(schema.testRuns)
    .values(
      STATUSES.map((_, i) => ({
        id: i + 1,
        projectId: 1,
        status: 'failed',
        startTime: new Date(Date.now() - i * 60_000),
      })),
    );
  await db
    .insert(schema.testRunsCases)
    .values(STATUSES.map((status, i) => ({ testRunId: i + 1, testCaseId: 1, status, duration: 1000 })));
});

describe('the test page header', () => {
  test('counts a timed-out or interrupted execution as failed', async () => {
    const testCase = await getTestCase(db as never, 1);
    expect(testCase).toMatchObject({ totalRuns: 6, passedRuns: 1, failedRuns: 4, timedOutRuns: 2, skippedRuns: 1 });
  });

  test('keeps its pass rate', async () => {
    const testCase = await getTestCase(db as never, 1);
    expect(testCase!.passRate).toBe(33);
  });
});
