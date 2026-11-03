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
const MINUTE = 60_000;
const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MINUTE);

/**
 * Two tests over three runs. "pays" passes in run 1 and passes on its retry in runs 2 and 3; "refunds" passes on its
 * retry in run 1 only. Execution ids never equal a test case id, so a lookup that compares the two finds nothing.
 */
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db
    .insert(schema.testRuns)
    .values([1, 2, 3].map((id) => ({ id, projectId: 1, status: 'passed', startTime: at(60 - id * 10) })));
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'checkout.spec.ts', title: 'refunds' },
  ]);
  const execution = (id: number, testRunId: number, testCaseId: number, status: string, retries: number) => ({
    id,
    testRunId,
    testCaseId,
    status,
    retries,
    duration: 1000,
    createdAt: at(60 - testRunId * 10 - retries),
  });
  await db
    .insert(schema.testRunsCases)
    .values([
      execution(101, 1, 1, 'passed', 0),
      execution(102, 1, 2, 'failed', 0),
      execution(103, 1, 2, 'passed', 1),
      execution(104, 2, 1, 'failed', 0),
      execution(105, 2, 1, 'passed', 1),
      execution(106, 3, 1, 'failed', 0),
      execution(107, 3, 1, 'passed', 1),
    ]);
});

describe('the test page header', () => {
  test("counts the test's own recent passes on retry", async () => {
    expect(await getTestCase(db as never, 1)).toMatchObject({ flakyRuns: 2, recentFlakyRuns: 2 });
    expect(await getTestCase(db as never, 2)).toMatchObject({ flakyRuns: 1, recentFlakyRuns: 1 });
  });
});
