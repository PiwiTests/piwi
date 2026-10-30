import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { recurrenceFlakinessSection, retryBehaviorSection } = await import('../../server/utils/ai-context');

let db: ReturnType<typeof drizzle<typeof schema>>;
let runSeq = 0;

async function seedRun(): Promise<number> {
  const id = ++runSeq;
  await db.insert(schema.testRuns).values({ id, projectId: 1, status: 'passed', startTime: new Date(id * 1000) });
  return id;
}

/** One execution of the test; a failure in the cluster carries its id, a pass carries none, as at ingest. */
async function seedExec(runId: number, testCaseId: number, status: 'failed' | 'passed', retries = 0): Promise<void> {
  await db.insert(schema.testRunsCases).values({
    testRunId: runId,
    testCaseId,
    status,
    retries,
    failureClusterId: status === 'failed' ? 1 : null,
  });
}

async function loadCluster() {
  const [cluster] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, 1));
  return cluster!;
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'recurrence-project' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds an item' },
    { id: 2, projectId: 1, filePath: 'tests/login.spec.ts', title: 'logs in' },
  ]);
  runSeq = 0;
});

describe('recurrence and retry sections of a flaky cluster', () => {
  test('a test that fails in some runs and passes on retry in others reads as intermittent', async () => {
    const failRun = await seedRun();
    const retryRun1 = await seedRun();
    const retryRun2 = await seedRun();
    await db.insert(schema.failureClusters).values({
      id: 1,
      projectId: 1,
      fingerprint: 'fp',
      signature: 'Timeout waiting for cart',
      firstSeenRunId: failRun,
      lastSeenRunId: retryRun2,
    });
    await seedExec(failRun, 1, 'failed', 1);
    await seedExec(retryRun1, 1, 'passed', 1);
    await seedExec(retryRun2, 1, 'passed', 1);
    // Another test's retry pass is not this cluster's.
    await seedExec(retryRun2, 2, 'passed', 1);
    await seedExec(retryRun1, 2, 'passed');

    const cluster = await loadCluster();
    const recurrence = await recurrenceFlakinessSection(db as never, cluster);
    expect(recurrence).toContain('- Affected runs: 3, total occurrences: 3');
    expect(recurrence).toContain('- Retry-passes: 2 of 3 runs');
    expect(recurrence).toContain('- Pattern: intermittent');

    expect(await retryBehaviorSection(db as never, cluster)).toContain('passed on retry in the last seen run');
  });

  test('a test that fails in every run with no retry pass reads as persistent', async () => {
    const run1 = await seedRun();
    const run2 = await seedRun();
    await db.insert(schema.failureClusters).values({
      id: 1,
      projectId: 1,
      fingerprint: 'fp',
      signature: 'Login button renamed',
      firstSeenRunId: run1,
      lastSeenRunId: run2,
    });
    await seedExec(run1, 1, 'failed');
    await seedExec(run2, 1, 'failed');
    await seedExec(run2, 2, 'passed', 1);

    const cluster = await loadCluster();
    expect(await recurrenceFlakinessSection(db as never, cluster)).toContain('- Pattern: persistent');
    expect(await retryBehaviorSection(db as never, cluster)).toBeNull();
  });
});
