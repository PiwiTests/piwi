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

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'checkout.spec.ts', title: 'pays' });

  // Oldest first: passed, timed out, passed, then timed out and passed on retry.
  const attemptsPerRun: Array<Array<{ status: string; duration: number }>> = [
    [{ status: 'passed', duration: 2_000 }],
    [{ status: 'timedout', duration: 30_000 }],
    [{ status: 'passed', duration: 2_000 }],
    [
      { status: 'timedout', duration: 30_000 },
      { status: 'passed', duration: 2_000 },
    ],
  ];
  for (const [index, attempts] of attemptsPerRun.entries()) {
    const final = attempts[attempts.length - 1]!;
    const [run] = await db
      .insert(schema.testRuns)
      .values({
        projectId: 1,
        status: final.status === 'passed' ? 'passed' : 'failed',
        startTime: new Date(Date.now() - (attemptsPerRun.length - index) * HOUR_MS),
        duration: 60_000,
        totalTests: 1,
      })
      .returning({ id: schema.testRuns.id });
    for (const [retries, attempt] of attempts.entries()) {
      await db.insert(schema.testRunsCases).values({
        testRunId: run!.id,
        testCaseId: 1,
        status: attempt.status,
        retries,
        duration: attempt.duration,
        browserName: 'chromium',
        browser: { projectName: 'chromium' },
      });
    }
  }
});

describe('getProjectFlakyTests with stored timedout statuses', () => {
  test('counts a timed-out final as a failed run', async () => {
    const [flaky] = await getProjectFlakyTests(db as any, 1, 20);
    expect(flaky).toBeDefined();
    expect(flaky!.failedRuns).toBe(1);
    expect(flaky!.alternations).toBe(2);
  });

  test('averages the durations of timed-out attempts into the wasted time', async () => {
    const [flaky] = await getProjectFlakyTests(db as any, 1, 20);
    expect(flaky!.avgFailedDurationMs).toBe(30_000);
  });
});
