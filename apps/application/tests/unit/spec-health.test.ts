import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { withStoredVerdicts } from './stored-verdicts';

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
    .values(
      withStoredVerdicts({ testRunId, testCaseId: 1, status, retries, duration: 1_000, browserName: 'chromium' }),
    );
}

describe('getProjectSpecHealth', () => {
  test('testCount counts the runs of a spec directory, a retried one once, not its attempts nor its distinct tests', async () => {
    const first = await addRun();
    await addExecution(first, 0, 'failed');
    await addExecution(first, 1, 'passed');
    await addExecution(await addRun(), 0, 'passed');

    const { specs } = await getProjectSpecHealth(db as any, 1, 30);

    // The first run passed on its retry: one flaky run, not a failure.
    expect(specs).toEqual([
      {
        prefix: 'tests/cart',
        passRate: 1,
        flakyRate: 0.5,
        failureCount: 0,
        testCount: 2,
        avgDuration: 1_000,
      },
    ]);
  });

  test('divides the flaky runs by the runs that passed or failed, and has no flaky rate without one', async () => {
    const first = await addRun();
    await addExecution(first, 0, 'failed');
    await addExecution(first, 1, 'passed');
    await addExecution(await addRun(), 0, 'failed');
    await addExecution(await addRun(), 0, 'skipped');
    await db
      .insert(schema.testCases)
      .values({ id: 2, projectId: 1, filePath: 'tests/admin/off.spec.ts', title: 'off' });
    await db
      .insert(schema.testRunsCases)
      .values(withStoredVerdicts({ testRunId: first, testCaseId: 2, status: 'skipped' }));

    const { specs } = await getProjectSpecHealth(db as any, 1, 30);

    expect(specs.map((s) => [s.prefix, s.passRate, s.flakyRate, s.testCount])).toEqual([
      ['tests/admin', null, null, 1],
      ['tests/cart', 0.5, 0.5, 3],
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
