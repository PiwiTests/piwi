import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules load.
delete process.env.PIWI_DATABASE_URL;
const { getProjectFlakyTests } = await import('../../shared/handlers/projects');

const HOUR_MS = 60 * 60 * 1000;

// Each test's final status in five runs, oldest first, on the `chromium` project. `retried` is a pass on a retry.
const OUTCOMES: Record<number, string[]> = {
  // Never passed: the runs between its failures did not run it (a serial block after an earlier failure).
  1: ['failed', 'didnotrun', 'failed', 'didnotrun', 'failed'],
  // Two flips across its three results; a skipped and an interrupted run in between.
  2: ['passed', 'skipped', 'failed', 'interrupted', 'passed'],
  // A retry pass and a failure, then skipped runs: fewer than the three results a score needs.
  3: ['retried', 'failed', 'skipped', 'skipped', 'skipped'],
  // A timed-out run is a failed result.
  4: ['passed', 'timedout', 'passed', 'skipped', 'timedout'],
  // Two Playwright projects: a run counts as failed when either failed, whatever the other did.
  5: ['skipped', 'passed', 'skipped', 'passed', 'skipped'],
};

// Test 5's results on a second Playwright project, `firefox`.
const FIREFOX_OUTCOMES: Record<number, string[]> = {
  5: ['failed', 'skipped', 'timedOut', 'skipped', 'failed'],
};

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
  await db.insert(schema.testCases).values(
    Object.keys(OUTCOMES).map((id) => ({
      id: Number(id),
      projectId: 1,
      filePath: 'checkout.spec.ts',
      title: `test ${id}`,
    })),
  );

  for (let index = 0; index < 5; index++) {
    const [run] = await db
      .insert(schema.testRuns)
      .values({
        projectId: 1,
        status: 'failed',
        startTime: new Date(Date.now() - (5 - index) * HOUR_MS),
        duration: 60_000,
        totalTests: Object.keys(OUTCOMES).length,
      })
      .returning({ id: schema.testRuns.id });
    for (const [project, outcomes] of [
      ['chromium', OUTCOMES],
      ['firefox', FIREFOX_OUTCOMES],
    ] as const) {
      for (const [id, statuses] of Object.entries(outcomes)) {
        const status = statuses[index]!;
        await db.insert(schema.testRunsCases).values({
          testRunId: run!.id,
          testCaseId: Number(id),
          status: status === 'retried' ? 'passed' : status,
          retries: status === 'retried' ? 1 : 0,
          passedAfterFailure: status === 'retried',
          duration: 2_000,
          browserName: project,
          browser: { projectName: project },
        });
      }
    }
  }
});

describe('getProjectFlakyTests counts only the runs a test passed or failed in', () => {
  test('a test that never passed is not flaky, whatever ran between its failures', async () => {
    const flaky = await getProjectFlakyTests(db as any, 1, 20);
    expect(flaky.find((t) => t.testCaseId === 1)).toBeUndefined();
  });

  test('a skipped or interrupted run neither flips nor counts toward the score', async () => {
    const flaky = await getProjectFlakyTests(db as any, 1, 20);
    const test2 = flaky.find((t) => t.testCaseId === 2);
    expect(test2).toMatchObject({ totalRuns: 3, failedRuns: 1, alternations: 2, failureRate: 0.33, score: 40 });
  });

  test('a test with fewer than three passed or failed results is not scored, even with a retry pass', async () => {
    const flaky = await getProjectFlakyTests(db as any, 1, 20);
    expect(flaky.find((t) => t.testCaseId === 3)).toBeUndefined();
  });

  test('a timed-out run counts as a failed result', async () => {
    const flaky = await getProjectFlakyTests(db as any, 1, 20);
    const test4 = flaky.find((t) => t.testCaseId === 4);
    expect(test4).toMatchObject({ totalRuns: 4, failedRuns: 2, alternations: 3, score: 40 });
  });

  test('a run counts as failed when any of its Playwright projects failed', async () => {
    const flaky = await getProjectFlakyTests(db as any, 1, 20);
    const test5 = flaky.find((t) => t.testCaseId === 5);
    expect(test5).toMatchObject({ totalRuns: 5, failedRuns: 3, alternations: 4, score: 40 });
  });
});
