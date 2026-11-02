import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/** Which events a finished run sends, from `emitRunNotifications`. */

const emitted = vi.hoisted(() => [] as Array<{ event: string; payload: Record<string, unknown> }>);
vi.mock('../../server/utils/notifications/emit', () => ({
  emitNotification: async (_db: unknown, event: string, payload: Record<string, unknown>) => {
    emitted.push({ event, payload });
  },
}));

delete process.env.PIWI_DATABASE_URL;

const { emitRunNotifications, clustersToAnnounce } = await import('../../server/utils/notifications/run-notifications');
const { eventSentences } = await import('../../shared/notifications/message-parts');

let db: TempDb;
let close: () => Promise<void>;

type RunValues = Partial<typeof schema.testRuns.$inferInsert>;

async function addRun(id: number, values: RunValues = {}): Promise<void> {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    branch: 'main',
    startTime: new Date(Date.UTC(2026, 9, 1, id)),
    totalTests: 1,
    passedTests: 1,
    origin: 'ci',
    metadata: { ci: { provider: 'github' } },
    ...values,
  });
}

const events = () => emitted.map((e) => e.event);
const announced = () => emitted.filter((e) => e.event === 'cluster.new');

const editorRun: RunValues = {
  status: 'failed',
  origin: 'editor',
  isFullRun: 0,
  metadata: { piwiOrigin: { kind: 'editor' } },
};

async function addCluster(
  id: number,
  firstSeenRunId: number,
  values: Partial<typeof schema.failureClusters.$inferInsert> = {},
) {
  await db.insert(schema.failureClusters).values({
    id,
    projectId: 1,
    fingerprint: `fp-${id}`,
    signature: `Error: broken ${id}`,
    firstSeenRunId,
    lastSeenRunId: firstSeenRunId,
    ...values,
  });
}

/** Test 1 failing into cluster `failureClusterId` in run `testRunId`, in a browser project of the cluster's own. */
async function addFailures(...pairs: Array<[testRunId: number, failureClusterId: number]>) {
  await db.insert(schema.testRunsCases).values(
    pairs.map(([testRunId, failureClusterId]) => ({
      testRunId,
      testCaseId: 1,
      status: 'failed',
      browserName: `browser-${failureClusterId}`,
      failureClusterId,
    })),
  );
}

beforeEach(async () => {
  emitted.length = 0;
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/pay.spec.ts', title: 'pays' });
});
afterEach(() => close());

describe('emitRunNotifications', () => {
  test('sends run.failed for a run stopped by the global timeout, though no test failed', async () => {
    await addRun(1, { status: 'timedout', passedTests: 1, failedTests: 0 });
    await emitRunNotifications(db as never, 1);
    expect(events()).toEqual(expect.arrayContaining(['run.finished', 'run.failed', 'run.failed.default_branch']));
  });

  test('measures a run against complete runs only, never a Flake Lab or a partial run', async () => {
    // Two short Flake Lab runs and a partial run come right before the CI run.
    await addRun(1, { duration: 50_000 });
    await addRun(2, { duration: 50_000 });
    await addRun(3, { duration: 300, origin: 'flake-lab', metadata: {} });
    await addRun(4, { duration: 300, origin: 'flake-lab', metadata: {} });
    await addRun(5, { duration: 1_000, isFullRun: 0 });
    await addRun(6, { duration: 61_000 });

    await emitRunNotifications(db as never, 6);

    const perf = emitted.find((e) => e.event === 'perf.regression');
    expect(perf?.payload).toMatchObject({ baselineDurationMs: 50_000, regressionPct: 22 });
  });

  test('announces a cluster from the first run that sends notifications, once', async () => {
    // Cluster 7 first appeared in an editor run, cluster 8 in an imported run: neither announced it.
    await addRun(1, { status: 'failed', origin: 'editor', isFullRun: 0, metadata: { piwiOrigin: { kind: 'editor' } } });
    await addRun(2, { status: 'failed', origin: 'import', metadata: { import: { source: 'blob' } } });
    await addRun(3, { status: 'failed' });
    await addRun(4, { status: 'failed' });
    await db.insert(schema.failureClusters).values([
      { id: 7, projectId: 1, fingerprint: 'a', signature: 'TimeoutError', firstSeenRunId: 1, lastSeenRunId: 4 },
      { id: 8, projectId: 1, fingerprint: 'b', signature: 'Error', firstSeenRunId: 2, lastSeenRunId: 4 },
    ]);
    const failure = (testRunId: number, failureClusterId: number) => ({
      testRunId,
      testCaseId: 1,
      status: 'failed',
      browserName: failureClusterId === 7 ? 'chromium' : 'firefox',
      failureClusterId,
    });
    await db
      .insert(schema.testRunsCases)
      .values([failure(1, 7), failure(2, 8), failure(3, 7), failure(3, 8), failure(4, 7), failure(4, 8)]);

    await emitRunNotifications(db as never, 3);
    const firstSeen = announced().map((e) => [e.payload.clusterId, e.payload.firstSeenRunId]);
    expect(firstSeen.sort()).toEqual([
      [7, 1],
      [8, 2],
    ]);

    emitted.length = 0;
    await emitRunNotifications(db as never, 4);
    expect(events()).not.toContain('cluster.new');
  });

  test('announces only an open cluster no one snoozed, whose first run is still stored', async () => {
    await addRun(1, editorRun);
    await addRun(2, { status: 'failed' });
    await addCluster(7, 1, { status: 'ignored' });
    await addCluster(8, 1, { snoozedUntil: new Date(Date.now() + 86_400_000), snoozeMode: 'until' });
    await addCluster(9, 1, { status: 'resolved' });
    // Its first run, and every run that announced it, were deleted.
    await addCluster(10, 99);
    await addCluster(11, 1);
    await addFailures([1, 7], [1, 8], [1, 9], [1, 11], [2, 7], [2, 8], [2, 9], [2, 10], [2, 11]);

    await emitRunNotifications(db as never, 2);
    expect(announced().map((e) => e.payload.clusterId)).toEqual([11]);
  });

  test('a run that did not run to its end announces no cluster, and has announced none', async () => {
    await addRun(1, { status: 'cancelled' });
    await addRun(2, { status: 'interrupted' });
    await addRun(3, { status: 'running' });
    await addRun(4, { status: 'failed' });
    await addCluster(7, 1);
    await addFailures([1, 7], [2, 7], [3, 7], [4, 7]);

    await emitRunNotifications(db as never, 2);
    expect(announced()).toEqual([]);
    await emitRunNotifications(db as never, 4);
    expect(announced().map((e) => [e.payload.clusterId, e.payload.firstSeenRunId])).toEqual([[7, 1]]);
  });

  test('says which run a cluster first appeared in when that run did not announce it', async () => {
    await addRun(1, editorRun);
    await addRun(2, { status: 'failed' });
    await addCluster(7, 1);
    await addCluster(8, 2);
    await addFailures([1, 7], [2, 7], [2, 8]);

    await emitRunNotifications(db as never, 2);
    const sentence = (clusterId: number) =>
      eventSentences('cluster.new', announced().find((e) => e.payload.clusterId === clusterId)!.payload as never)[0];
    expect(sentence(7)).toBe(
      'A test of run #2 failed with an error first seen in run #1, which sent no notification of it.',
    );
    expect(sentence(8)).toBe('A test of run #2 failed with an error no earlier run produced.');
  });

  test('a cluster a person resolved is not announced by the run its verdicts reopen it in', async () => {
    await addRun(1, editorRun);
    await addRun(2, { status: 'failed' });
    await addCluster(7, 1, { status: 'resolved' });
    await addFailures([1, 7], [2, 7]);

    // The finalize step reads the clusters before fix verification reopens this one, which announces it as regressed.
    const announce = await clustersToAnnounce(db as never, 2);
    await db.update(schema.failureClusters).set({ status: 'open' });
    await emitRunNotifications(db as never, 2, { announce });
    expect(announced()).toEqual([]);
  });

  test('sends no run.failed for a passing run', async () => {
    await addRun(1);
    await emitRunNotifications(db as never, 1);
    expect(events()).toEqual(['run.finished']);
  });
});
