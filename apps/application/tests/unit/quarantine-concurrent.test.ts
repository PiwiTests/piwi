import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { quarantineClusterTests } = await import('../../shared/handlers/failure-clusters');
const { addQuarantine } = await import('../../shared/handlers/quarantine');

let db: ReturnType<typeof drizzle<typeof schema>>;

/** Two clusters of one run that share the test "pays": "refunds" is in the first only, "ships" in the second only. */
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'checkout.spec.ts', title: 'refunds' },
    { id: 3, projectId: 1, filePath: 'checkout.spec.ts', title: 'ships' },
  ]);
  await db.insert(schema.failureClusters).values([
    {
      id: 1,
      projectId: 1,
      fingerprint: 'a',
      signature: 'Timeout 5000ms exceeded',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
    },
    { id: 2, projectId: 1, fingerprint: 'b', signature: 'expected 200, got 500', firstSeenRunId: 1, lastSeenRunId: 1 },
  ]);
  const failure = (testCaseId: number, failureClusterId: number, browserName: string) => ({
    testRunId: 1,
    testCaseId,
    browserName,
    status: 'failed',
    failureClusterId,
  });
  await db
    .insert(schema.testRunsCases)
    .values([failure(1, 1, 'chromium'), failure(2, 1, 'chromium'), failure(1, 2, 'firefox'), failure(3, 2, 'firefox')]);
});

const activeQuarantines = async () =>
  (await db.select().from(schema.quarantinedTests))
    .filter((row) => row.releasedAt === null)
    .map((row) => row.testCaseId);

describe('quarantining at the same time', () => {
  test('two clusters that share a test quarantine every test of both', async () => {
    const results = await Promise.all([quarantineClusterTests(db as never, 1), quarantineClusterTests(db as never, 2)]);

    expect(results.map((r) => r?.success)).toEqual([true, true]);
    expect(results.reduce((sum, r) => sum + (r?.quarantined ?? 0), 0)).toBe(3);
    expect((await activeQuarantines()).sort()).toEqual([1, 2, 3]);
  });

  test('the same test twice creates one quarantine', async () => {
    const results = await Promise.all([addQuarantine(db as never, 1, 1), addQuarantine(db as never, 1, 1)]);

    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(await activeQuarantines()).toEqual([1]);
  });
});
