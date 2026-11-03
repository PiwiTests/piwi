import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { PROJECT } from '../../shared/test-project-names';
import { migrateToLatest } from './temp-db';

/**
 * The runs the cluster page's state line counts as runs a failure skipped: only
 * those that could have shown it and did not.
 */

delete process.env.PIWI_DATABASE_URL;
const { getFailureCluster } = await import('../../shared/handlers/failure-clusters');

let db: ReturnType<typeof drizzle<typeof schema>>;
let runSeq = 0;

async function insertRun(
  opts: {
    branch?: string;
    origin?: string;
    isFullRun?: number;
    status?: string;
    incident?: boolean;
    runErrors?: Array<{ message: string }>;
    didNotRunTests?: number;
  } = {},
) {
  const id = ++runSeq;
  const origin = opts.origin ?? 'ci';
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: opts.status ?? 'passed',
    startTime: new Date(Date.UTC(2026, 9, 1) + id * 3_600_000),
    branch: opts.branch ?? 'main',
    isFullRun: opts.isFullRun ?? 1,
    runErrors: opts.runErrors ?? null,
    didNotRunTests: opts.didNotRunTests ?? 0,
    origin,
    metadata: {
      piwiOrigin: { kind: origin },
      ...(opts.incident ? { incident: { reason: 'The host was down', host: 'staging' } } : {}),
    },
  });
  return id;
}

/**
 * The tests of `clusterTests` (test 1 by default) failed into the cluster in its last run; each later run holds the
 * tests it names with its `status` (passed by default), a failure joining the cluster.
 */
async function seed(
  later: Array<{ tests: number[]; run: Parameters<typeof insertRun>[0]; status?: string }>,
  clusterTests: number[] = [1],
) {
  const failing = await insertRun({ status: 'failed' });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp-pay',
    signature: 'Error: the card was declined',
    firstSeenRunId: failing,
    lastSeenRunId: failing,
    occurrences: clusterTests.length,
  });
  await db
    .insert(schema.testRunsCases)
    .values(
      clusterTests.map((testCaseId) => ({ testRunId: failing, testCaseId, status: 'failed', failureClusterId: 1 })),
    );
  for (const { tests, run, status = 'passed' } of later) {
    const id = await insertRun(run);
    for (const testCaseId of tests) {
      await db
        .insert(schema.testRunsCases)
        .values({ testRunId: id, testCaseId, status, ...(status === 'failed' ? { failureClusterId: 1 } : {}) });
    }
  }
}

beforeEach(async () => {
  runSeq = 0;
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: PROJECT.CLUSTER_PAGE_LAYOUT, defaultBranch: 'main' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds an item' },
    { id: 3, projectId: 1, filePath: 'tests/search.spec.ts', title: 'finds an item' },
  ]);
});

describe("the state line's runs", () => {
  test('runs that could not have shown the failure are not runs it skipped', async () => {
    await seed([
      { tests: [1], run: { origin: 'probe' } },
      { tests: [1], run: { origin: 'bisect' } },
      { tests: [1], run: { origin: 'reproduce' } },
      { tests: [2], run: { isFullRun: 0 } },
      { tests: [1], run: { branch: 'feature/other' } },
      { tests: [1], run: { incident: true } },
      { tests: [1], run: { status: 'running' } },
      { tests: [], run: {} },
    ]);
    const { clusterState } = (await getFailureCluster(db, 1))!;
    expect(clusterState.kind).toBe('failing');
  });

  test('runs that ran its tests on its branch or the default branch are', async () => {
    await seed([
      { tests: [1], run: {} },
      { tests: [1, 2], run: { isFullRun: 0 } },
      { tests: [1], run: { origin: 'editor' } },
    ]);
    const { clusterState } = (await getFailureCluster(db, 1))!;
    expect(clusterState.kind).toBe('quiet');
    expect(clusterState.sentence).toMatch(/^Not seen for 3 runs/);
  });

  test('a run the cluster failed in is not one it skipped, though it leaves its last seen run alone', async () => {
    // A run from an editor joins its failure to the cluster without making it recur.
    await seed([
      { tests: [1], run: { origin: 'editor' }, status: 'failed' },
      { tests: [1], run: { origin: 'editor' }, status: 'failed' },
      { tests: [1], run: { origin: 'editor' }, status: 'failed' },
    ]);
    const { clusterState, failureGoesOn } = (await getFailureCluster(db, 1))!;
    expect(clusterState.kind).toBe('failing');
    expect(failureGoesOn).toBe(true);
  });

  test('a run that held its test only as skipped or not run is not one it skipped', async () => {
    await seed([
      { tests: [1], run: {}, status: 'skipped' },
      { tests: [1], run: { isFullRun: 0 }, status: 'skipped' },
      { tests: [1], run: {}, status: 'didnotrun' },
    ]);
    const { clusterState, failureGoesOn } = (await getFailureCluster(db, 1))!;
    expect(clusterState.kind).toBe('failing');
    expect(failureGoesOn).toBe(true);
  });

  test('a whole-suite run is one it skipped though a test of the cluster no longer exists', async () => {
    // Test 2 was renamed after the failure: no later run holds it.
    await seed(
      [
        { tests: [1], run: {} },
        { tests: [1], run: {} },
        { tests: [1], run: {} },
      ],
      [1, 2],
    );
    const { clusterState, failureGoesOn } = (await getFailureCluster(db, 1))!;
    expect(clusterState.kind).toBe('quiet');
    expect(clusterState.sentence).toMatch(/^Not seen for 3 runs/);
    expect(failureGoesOn).toBe(false);
  });

  test('a whole-suite run is one it skipped though it holds none of the tests of the cluster', async () => {
    // The cluster's only test was renamed: the later runs hold the other test alone.
    await seed([
      { tests: [2], run: {} },
      { tests: [2], run: {} },
      { tests: [2], run: {} },
    ]);
    const { clusterState } = (await getFailureCluster(db, 1))!;
    expect(clusterState.sentence).toMatch(/^Not seen for 3 runs/);
  });

  test('a whole-suite run stopped before its end is not one it skipped unless it ran the tests of the cluster', async () => {
    const maxFailuresStop = { message: '\u001b[31mTesting stopped early after 1 maximum allowed failures.\u001b[39m' };
    await seed([
      { tests: [2], run: { status: 'interrupted' } },
      { tests: [2], run: { status: 'cancelled' } },
      { tests: [2], run: { status: 'timedout' } },
      { tests: [2], run: { status: 'failed', runErrors: [maxFailuresStop] } },
      { tests: [1], run: {}, status: 'interrupted' },
    ]);
    // `maxFailures` stopped it before test 1, which it does not hold: it ran test 2 alone.
    const cut = await insertRun({ status: 'failed', didNotRunTests: 1 });
    await db.insert(schema.testRunsCases).values([
      { testRunId: cut, testCaseId: 2, status: 'failed' },
      { testRunId: cut, testCaseId: 3, status: 'didnotrun', didNotRunReason: 'max-failures' },
    ]);
    const { clusterState, failureGoesOn } = (await getFailureCluster(db, 1))!;
    expect(clusterState.kind).toBe('failing');
    expect(failureGoesOn).toBe(true);
  });

  test('a partial run is one it skipped only when it ran every test of the cluster', async () => {
    await seed([{ tests: [1], run: { isFullRun: 0 } }], [1, 2]);
    const { failureGoesOn } = (await getFailureCluster(db, 1))!;
    expect(failureGoesOn).toBe(true);
  });
});
