import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { PROJECT } from '../../shared/test-project-names';
import { DEFAULT_EXPORT_MAX_CASES, MAX_EXPORT_MAX_CASES } from '../../shared/export/limits';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { getFailureCluster, CLUSTER_DETAIL_TESTS_LIMIT } = await import('../../shared/handlers/failure-clusters');
const { collectClusterBundle } = await import('../../shared/export/collect');

const AFFECTED = 60;
const PROJECT_ID = 1;
const CLUSTER_ID = 1;

let db: ReturnType<typeof drizzle<typeof schema>>;

/**
 * A cluster spanning `AFFECTED` tests. The first `CLUSTER_DETAIL_TESTS_LIMIT`
 * fail in both runs and the rest in one, so the most-affected tests come first
 * and the tail is the part a capped list would drop.
 */
async function seedCluster(): Promise<number[]> {
  await db.insert(schema.projects).values({ id: PROJECT_ID, name: PROJECT.EXPORT_OFFLINE });
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: PROJECT_ID, status: 'failed', startTime: new Date(1_000) },
    { id: 2, projectId: PROJECT_ID, status: 'failed', startTime: new Date(2_000) },
  ]);
  await db.insert(schema.failureClusters).values({
    id: CLUSTER_ID,
    projectId: PROJECT_ID,
    fingerprint: 'fp-wide',
    signature: 'expect(locator).toBeVisible() failed',
    firstSeenRunId: 1,
    lastSeenRunId: 2,
    occurrences: AFFECTED + CLUSTER_DETAIL_TESTS_LIMIT,
  });

  const ids = Array.from({ length: AFFECTED }, (_, i) => i + 1);
  await db.insert(schema.testCases).values(
    ids.map((id) => ({
      id,
      projectId: PROJECT_ID,
      filePath: `tests/spec-${id}.spec.ts`,
      title: `test ${id}`,
    })),
  );
  const executions = ids.flatMap((id) => {
    const runs = id <= CLUSTER_DETAIL_TESTS_LIMIT ? [1, 2] : [2];
    return runs.map((testRunId) => ({
      testRunId,
      testCaseId: id,
      status: 'failed',
      failureClusterId: CLUSTER_ID,
    }));
  });
  await db.insert(schema.testRunsCases).values(executions);
  return ids;
}

async function quarantine(testCaseIds: number[]): Promise<void> {
  await db
    .insert(schema.quarantinedTests)
    .values(testCaseIds.map((testCaseId) => ({ projectId: PROJECT_ID, testCaseId })));
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
});

describe('getFailureCluster affected tests', () => {
  test('lists a bounded page by default and reports the full count', async () => {
    await seedCluster();

    const cluster = (await getFailureCluster(db, CLUSTER_ID))!;

    expect(cluster.affectedTests).toBe(AFFECTED);
    expect(cluster.affectedTestCases).toHaveLength(CLUSTER_DETAIL_TESTS_LIMIT);
    expect(cluster.affectedTestCases.every((t) => t.runCount === 2)).toBe(true);
  });

  test('lists every affected test when the limit is null', async () => {
    await seedCluster();

    const cluster = (await getFailureCluster(db, CLUSTER_ID, { affectedTestsLimit: null }))!;

    expect(cluster.affectedTestCases).toHaveLength(AFFECTED);
    expect(cluster.affectedTestCases.slice(CLUSTER_DETAIL_TESTS_LIMIT).every((t) => t.runCount === 1)).toBe(true);
  });

  test('honors an explicit limit', async () => {
    await seedCluster();

    const cluster = (await getFailureCluster(db, CLUSTER_ID, { affectedTestsLimit: 5 }))!;

    expect(cluster.affectedTestCases).toHaveLength(5);
    expect(cluster.affectedTests).toBe(AFFECTED);
  });

  test('marks every test quarantined once all of them are, even beyond the listed page', async () => {
    const ids = await seedCluster();
    await quarantine(ids);

    const cluster = (await getFailureCluster(db, CLUSTER_ID))!;

    expect(cluster.affectedTestCases).toHaveLength(CLUSTER_DETAIL_TESTS_LIMIT);
    expect(cluster.clusterState.kind).toBe('quarantined');
    expect(cluster.clusterState.sentence).toContain(`All ${AFFECTED} tests are quarantined`);
  });

  test('counts only the tests that are quarantined and not released', async () => {
    const ids = await seedCluster();
    await quarantine(ids);
    await db.update(schema.quarantinedTests).set({ releasedAt: new Date(3_000) });
    await quarantine([ids[AFFECTED - 1]!]);

    const cluster = (await getFailureCluster(db, CLUSTER_ID))!;

    expect(cluster.clusterState.kind).not.toBe('quarantined');
  });
});

describe('collectClusterBundle member coverage', () => {
  test('expands the requested number of cases and lists every other affected test by name', async () => {
    await seedCluster();

    const bundle = (await collectClusterBundle(db, CLUSTER_ID, { maxCases: DEFAULT_EXPORT_MAX_CASES }))!;

    expect(bundle.cases).toHaveLength(DEFAULT_EXPORT_MAX_CASES);
    expect(bundle.truncatedCases).toHaveLength(AFFECTED - DEFAULT_EXPORT_MAX_CASES);
    const covered = new Set([
      ...bundle.cases.map((c) => c.testCaseId),
      ...bundle.truncatedCases.map((t) => t.testCaseId),
    ]);
    expect(covered.size).toBe(AFFECTED);
  });

  test('a case cap above the dashboard page size expands more than that page', async () => {
    await seedCluster();

    const bundle = (await collectClusterBundle(db, CLUSTER_ID, { maxCases: MAX_EXPORT_MAX_CASES }))!;

    expect(bundle.cases).toHaveLength(AFFECTED);
    expect(bundle.cases.length).toBeGreaterThan(CLUSTER_DETAIL_TESTS_LIMIT);
    expect(bundle.truncatedCases).toEqual([]);
  });

  test('names the tests beyond the dashboard page size', async () => {
    await seedCluster();

    const bundle = (await collectClusterBundle(db, CLUSTER_ID, { maxCases: 1 }))!;

    expect(bundle.cases).toHaveLength(1);
    expect(bundle.truncatedCases).toHaveLength(AFFECTED - 1);
    expect(bundle.truncatedCases.map((t) => t.title)).toContain(`test ${AFFECTED}`);
    expect((bundle.cluster as { affectedTests: number }).affectedTests).toBe(AFFECTED);
  });
});
