import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { PROJECT } from '../../shared/test-project-names';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { getFailureCluster } = await import('../../shared/handlers/failure-clusters');

const PROJECT_ID = 1;
const CLUSTER_ID = 1;

const countError = (received: number) =>
  [
    'Error: expect(locator).toHaveCount(expected) failed',
    '',
    "Locator:  getByRole('row')",
    'Expected: 26',
    `Received: ${received}`,
    'Timeout:  5000ms',
  ].join('\n');

let db: ReturnType<typeof drizzle<typeof schema>>;

/** A cluster first seen in run 1 and last seen in run 2, one test failing in each. */
async function seedCluster({
  firstError,
  latestError,
  sampleError,
}: {
  firstError: string | null;
  latestError: string | null;
  sampleError: string | null;
}) {
  await db.insert(schema.projects).values({ id: PROJECT_ID, name: PROJECT.CLUSTER_PAGE_LAYOUT });
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: PROJECT_ID, status: 'failed', startTime: new Date(1_000) },
    { id: 2, projectId: PROJECT_ID, status: 'failed', startTime: new Date(2_000) },
  ]);
  await db.insert(schema.failureClusters).values({
    id: CLUSTER_ID,
    projectId: PROJECT_ID,
    fingerprint: 'fp-rows',
    signature: 'Error: expect(locator).toHaveCount(expected) failed',
    errorType: 'assertion',
    sampleError,
    firstSeenRunId: 1,
    lastSeenRunId: 2,
    occurrences: 2,
  });
  await db.insert(schema.testCases).values({
    id: 1,
    projectId: PROJECT_ID,
    filePath: 'tests/orders.spec.ts',
    title: 'lists the orders',
  });
  await db.insert(schema.testRunsCases).values([
    { testRunId: 1, testCaseId: 1, status: 'failed', error: firstError, failureClusterId: CLUSTER_ID },
    { testRunId: 2, testCaseId: 1, status: 'failed', error: latestError, failureClusterId: CLUSTER_ID },
  ]);
}

const headlineText = (h: { parts: Array<{ text: string }> } | null) => h?.parts.map((p) => p.text).join('') ?? '';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
});

describe("getFailureCluster's latest headline", () => {
  test("reads the latest occurrence's own error", async () => {
    await seedCluster({ firstError: countError(30), latestError: countError(51), sampleError: countError(30) });

    const { latestHeadline } = (await getFailureCluster(db, CLUSTER_ID))!;

    expect(latestHeadline?.source).toBe('latest');
    expect(latestHeadline?.runId).toBe(2);
    expect(headlineText(latestHeadline)).toContain('51');
    expect(headlineText(latestHeadline)).not.toContain('30');
  });

  test("falls back to the cluster's sample error when the latest occurrence has none", async () => {
    await seedCluster({ firstError: countError(30), latestError: null, sampleError: countError(30) });

    const { latestHeadline } = (await getFailureCluster(db, CLUSTER_ID))!;

    expect(latestHeadline?.source).toBe('first');
    expect(latestHeadline?.runId).toBe(1);
    expect(headlineText(latestHeadline)).toContain('30');
  });

  test('is null when no error is stored anywhere', async () => {
    await seedCluster({ firstError: null, latestError: null, sampleError: null });

    const { latestHeadline } = (await getFailureCluster(db, CLUSTER_ID))!;

    expect(latestHeadline).toBeNull();
  });
});
