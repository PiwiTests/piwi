import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { PROJECT } from '../../shared/test-project-names';
import { migrateToLatest } from './temp-db';

/**
 * The runs the cluster page's state line counts as runs a failure skipped: only
 * those that could have shown it, by the rule fix verification follows.
 */

delete process.env.PIWI_DATABASE_URL;
const { getFailureCluster } = await import('../../shared/handlers/failure-clusters');

let db: ReturnType<typeof drizzle<typeof schema>>;
let runSeq = 0;

async function insertRun(
  opts: { branch?: string; origin?: string; isFullRun?: number; status?: string; incident?: boolean } = {},
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
    origin,
    metadata: {
      piwiOrigin: { kind: origin },
      ...(opts.incident ? { incident: { reason: 'The host was down', host: 'staging' } } : {}),
    },
  });
  return id;
}

/** Test 1 failed into the cluster in its last run; each later run ran the tests it names, and passed. */
async function seed(later: Array<{ tests: number[]; run: Parameters<typeof insertRun>[0] }>) {
  const failing = await insertRun({ status: 'failed' });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp-pay',
    signature: 'Error: the card was declined',
    firstSeenRunId: failing,
    lastSeenRunId: failing,
    occurrences: 1,
  });
  await db
    .insert(schema.testRunsCases)
    .values({ testRunId: failing, testCaseId: 1, status: 'failed', failureClusterId: 1 });
  for (const { tests, run } of later) {
    const id = await insertRun(run);
    for (const testCaseId of tests) {
      await db.insert(schema.testRunsCases).values({ testRunId: id, testCaseId, status: 'passed' });
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
});
