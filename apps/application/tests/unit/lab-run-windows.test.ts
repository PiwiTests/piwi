import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { getTestCaseHistory } = await import('../../shared/handlers/test-cases');
const { getProjectFlakyTests } = await import('../../shared/handlers/projects');
const { runOrigin } = await import('../../shared/run-eligibility');

let db: ReturnType<typeof drizzle<typeof schema>>;
/** Ids of the runs that are not lab runs. */
const realRunIds: number[] = [];
const MINUTE = 60_000;
const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MINUTE);

/** Record one run of project 1 with one execution per attempt of test case 1. */
async function seedRun(
  minutesAgo: number,
  status: string,
  metadata: object | null,
  attempts: string[] = [status === 'running' ? 'passed' : status],
) {
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId: 1, status, startTime: at(minutesAgo), metadata, origin: runOrigin(metadata) })
    .returning({ id: schema.testRuns.id });
  for (const [retries, attempt] of attempts.entries()) {
    await db.insert(schema.testRunsCases).values({
      testRunId: run!.id,
      testCaseId: 1,
      status: attempt,
      retries,
      duration: 1000,
      browserName: 'chromium',
      browser: { projectName: 'chromium' },
      createdAt: at(minutesAgo),
    });
  }
  if (!metadata) realRunIds.push(run!.id);
}

/**
 * Four real runs of a flaky test — passed, failed, passed, then failed and
 * passed on retry — followed by sixty probe runs, ten flake-lab runs and a
 * run still in progress, all newer.
 */
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'adds to cart' });

  await seedRun(1000, 'passed', null);
  await seedRun(990, 'failed', null);
  await seedRun(980, 'passed', null);
  await seedRun(970, 'passed', null, ['failed', 'passed']);
  for (let i = 0; i < 60; i++) await seedRun(900 - i, 'failed', { piwiProbe: true });
  for (let i = 0; i < 10; i++) {
    await seedRun(800 - i, 'passed', { piwiFlakeLab: { experimentId: 'exp-1', armId: 'slow-cart' } });
  }
  await seedRun(1, 'running', null);
});

describe('lab runs newer than every real run', () => {
  test("leave the test's history its real executions", async () => {
    const history = await getTestCaseHistory(db as never, 1);
    expect(history).toHaveLength(6);
    expect([...new Set(history.map((h) => h.runId))].sort((a, b) => a - b)).toEqual(realRunIds);
  });

  test('leave the flaky leaderboard its window of real, finished runs', async () => {
    const [flaky] = await getProjectFlakyTests(db as any, 1, 20);
    expect(flaky).toMatchObject({ testCaseId: 1, failedRuns: 1 });
  });
});
