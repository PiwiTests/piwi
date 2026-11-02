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

const { emitRunNotifications } = await import('../../server/utils/notifications/run-notifications');

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
    const announced = emitted.filter((e) => e.event === 'cluster.new').map((e) => e.payload.clusterId);
    expect(announced.sort()).toEqual([7, 8]);

    emitted.length = 0;
    await emitRunNotifications(db as never, 4);
    expect(events()).not.toContain('cluster.new');
  });

  test('sends no run.failed for a passing run', async () => {
    await addRun(1);
    await emitRunNotifications(db as never, 1);
    expect(events()).toEqual(['run.finished']);
  });
});
