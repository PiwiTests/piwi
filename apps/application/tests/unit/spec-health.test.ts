import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules load.
delete process.env.PIWI_DATABASE_URL;
const { getProjectSpecHealth } = await import('../../shared/handlers/projects');
const { runOrigin } = await import('../../shared/run-eligibility');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/cart/pay.spec.ts', title: 'pays' });
});

async function addRun(): Promise<number> {
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId: 1, status: 'passed', startTime: new Date(), duration: 60_000, totalTests: 1 })
    .returning({ id: schema.testRuns.id });
  return run!.id;
}

async function addExecution(testRunId: number, retries: number, status: string): Promise<void> {
  await db
    .insert(schema.testRunsCases)
    .values({ testRunId, testCaseId: 1, status, retries, duration: 1_000, browserName: 'chromium' });
}

describe('getProjectSpecHealth', () => {
  test('testCount counts the executions of a spec directory, not its distinct tests', async () => {
    const first = await addRun();
    await addExecution(first, 0, 'failed');
    await addExecution(first, 1, 'passed');
    await addExecution(await addRun(), 0, 'passed');

    const { specs } = await getProjectSpecHealth(db as any, 1, 30);

    expect(specs).toEqual([
      {
        prefix: 'tests/cart',
        passRate: 0.67,
        flakyRate: 0.33,
        failureCount: 1,
        testCount: 3,
        avgDuration: 1_000,
      },
    ]);
  });

  test('counts the real runs behind a hundred newer lab runs', async () => {
    const real = await addRun();
    await addExecution(real, 0, 'passed');
    const probeMetadata = { piwiProbe: true };
    for (let i = 0; i < 100; i++) {
      const [lab] = await db
        .insert(schema.testRuns)
        .values({
          projectId: 1,
          status: 'failed',
          startTime: new Date(Date.now() + i + 1),
          metadata: probeMetadata,
          origin: runOrigin(probeMetadata),
        })
        .returning({ id: schema.testRuns.id });
      await addExecution(lab!.id, 0, 'failed');
    }

    const { specs } = await getProjectSpecHealth(db as any, 1, 30);

    expect(specs).toMatchObject([{ prefix: 'tests/cart', passRate: 1, failureCount: 0, testCount: 1 }]);
  });
});
