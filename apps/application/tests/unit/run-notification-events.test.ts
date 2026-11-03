import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { configureSqliteConnections } from '../../server/database/sqlite-connections';
import { openTempDb, type TempDb } from './temp-db';

/** Which events a finished run sends, from `emitRunNotifications`, and the deliveries they queue. */

const emitted = vi.hoisted(() => [] as Array<{ event: string; payload: Record<string, unknown> }>);
vi.mock('../../server/utils/notifications/emit', async () => {
  const { matchAndEnqueue } = await vi.importActual<typeof import('../../server/utils/notifications/match')>(
    '../../server/utils/notifications/match',
  );
  return {
    emitNotification: async (db: never, event: never, payload: Record<string, unknown>) => {
      emitted.push({ event, payload });
      await matchAndEnqueue(db, event, payload as never);
    },
  };
});

delete process.env.PIWI_DATABASE_URL;

const { emitRunNotifications, clustersToAnnounce, releaseUnannouncedClusterClaimsOnce } =
  await import('../../server/utils/notifications/run-notifications');
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
const announcedBy = () => announced().map((e) => [e.payload.clusterId, e.payload.runId]);

/** A browser channel subscribed to `cluster.new` for every project: the outbox records each announcement. */
async function subscribeToNewClusters() {
  const [channel] = await db.insert(schema.notificationChannels).values({ name: 'Team', type: 'browser' }).returning();
  await db.insert(schema.subscriptions).values({ channelId: channel!.id, events: ['cluster.new'] });
}

/** The SQL of the SQLite migration whose file name ends with `name`. */
function migrationSql(name: string): string {
  const folder = fileURLToPath(new URL('../../server/database/migrations', import.meta.url));
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const entry = journal.entries.find((e) => e.tag.endsWith(name));
  if (!entry) throw new Error(`no migration named ${name}`);
  return readFileSync(`${folder}/${entry.tag}.sql`, 'utf8');
}

/** `client`, whose first read after an update fails as a locked database does, in a transaction too. */
function failingReadAfterClaim<T extends object>(client: T, state = { updated: false, failed: false }): T {
  return new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== 'function') return value;
      if (key === 'update') state.updated = true;
      if (key === 'select' && state.updated && !state.failed) {
        state.failed = true;
        return () => {
          throw new Error('SQLITE_BUSY: database is locked');
        };
      }
      if (key === 'transaction') {
        return (run: (tx: object) => Promise<unknown>, config?: unknown) =>
          value.call(target, (tx: object) => run(failingReadAfterClaim(tx, state)), config);
      }
      return value.bind(target);
    },
  });
}

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
  // Configured as the server configures its client: writes wait for an open transaction.
  await configureSqliteConnections(db.$client);
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
    await addRun(3, { status: 'failed' });
    await addCluster(7, 1);
    await addFailures([1, 7], [2, 7], [3, 7]);

    await emitRunNotifications(db as never, 2);
    expect(announced()).toEqual([]);
    await emitRunNotifications(db as never, 3);
    expect(announced().map((e) => [e.payload.clusterId, e.payload.firstSeenRunId])).toEqual([[7, 1]]);
  });

  test('a cluster is announced by the first run to end, though an earlier run it first appeared in is still running', async () => {
    // Run 1, where the cluster first appeared, is still running when run 2 ends; it then ends cancelled.
    await addRun(1, { status: 'running' });
    await addRun(2, { status: 'failed' });
    await addRun(3, { status: 'failed' });
    await addCluster(7, 1);
    await addFailures([1, 7], [2, 7], [3, 7]);

    await emitRunNotifications(db as never, 2);
    await db.update(schema.testRuns).set({ status: 'cancelled' }).where(eq(schema.testRuns.id, 1));
    await emitRunNotifications(db as never, 1);
    await emitRunNotifications(db as never, 3);
    expect(announcedBy()).toEqual([[7, 2]]);
  });

  test.each([
    ['no channel is subscribed', false],
    ['a channel is subscribed', true],
  ])(
    'a cluster two overlapping runs fail into is announced once, by the first to end, when %s',
    async (_, subscribed) => {
      if (subscribed) await subscribeToNewClusters();
      // Run 2 ends while run 1, where the cluster first appeared, is still running; a local run of the
      // whole suite still running is passed over too.
      await addRun(1, { status: 'running' });
      await addRun(2, { status: 'failed' });
      await addRun(3, { status: 'running', origin: 'local', metadata: {} });
      await addRun(4, { status: 'failed' });
      await addCluster(7, 1);
      await addCluster(8, 3);
      await addFailures([1, 7], [2, 7], [3, 8], [4, 8]);

      await emitRunNotifications(db as never, 2);
      await emitRunNotifications(db as never, 4);
      await db
        .update(schema.testRuns)
        .set({ status: 'failed' })
        .where(inArray(schema.testRuns.id, [1, 3]));
      await emitRunNotifications(db as never, 1);
      await emitRunNotifications(db as never, 3);
      expect(announcedBy()).toEqual([
        [7, 2],
        [8, 4],
      ]);
      const keys = await db
        .select({ key: schema.notificationDeliveries.dedupeKey })
        .from(schema.notificationDeliveries);
      expect(keys.map((row) => row.key).sort()).toEqual(subscribed ? ['cluster.new:c7:1', 'cluster.new:c8:1'] : []);
    },
  );

  test('two runs that end at once announce a cluster once', async () => {
    await addRun(1, { status: 'failed' });
    await addRun(2, { status: 'failed' });
    await addCluster(7, 1);
    await addFailures([1, 7], [2, 7]);

    const [first, second] = await Promise.all([clustersToAnnounce(db as never, 1), clustersToAnnounce(db as never, 2)]);
    expect([...first!, ...second!]).toEqual([7]);
  });

  test('a claim whose read fails is claimed again when the run sends its notifications', async () => {
    await addRun(1, editorRun);
    await addRun(2, { status: 'failed' });
    await addCluster(7, 1);
    await addFailures([1, 7], [2, 7]);

    await expect(clustersToAnnounce(failingReadAfterClaim(db) as never, 2)).rejects.toThrow('SQLITE_BUSY');
    await emitRunNotifications(db as never, 2);
    expect(announcedBy()).toEqual([[7, 2]]);
  });

  test('a run whose notifications would not announce a cluster claims none', async () => {
    await addRun(1, editorRun);
    await addRun(2, { status: 'failed', origin: 'local', isFullRun: 0, metadata: {} });
    await addRun(3, { status: 'failed' });
    await addCluster(7, 1);
    await addFailures([1, 7], [2, 7], [3, 7]);

    expect(await clustersToAnnounce(db as never, 1)).toEqual([]);
    expect(await clustersToAnnounce(db as never, 2)).toEqual([]);
    const [cluster] = await db
      .select({ announcedAt: schema.failureClusters.announcedAt })
      .from(schema.failureClusters)
      .where(eq(schema.failureClusters.id, 7));
    expect(cluster!.announcedAt).toBeNull();
    await emitRunNotifications(db as never, 3);
    expect(announcedBy()).toEqual([[7, 3]]);
  });

  test('a cluster stays announced once the run that announced it is deleted', async () => {
    await addRun(1, editorRun);
    await addRun(2, { status: 'failed' });
    await addRun(3, { status: 'failed' });
    await addCluster(7, 1);
    await addFailures([1, 7], [2, 7], [3, 7]);

    await emitRunNotifications(db as never, 2);
    await db.delete(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, 2));
    await db.delete(schema.testRuns).where(eq(schema.testRuns.id, 2));
    await emitRunNotifications(db as never, 3);
    expect(announcedBy()).toEqual([[7, 2]]);
  });

  test('the migration that adds the claim reads every stored cluster as announced', async () => {
    await addRun(1, editorRun);
    await addRun(2, { status: 'failed' });
    await addCluster(7, 1);
    await addFailures([1, 7], [2, 7]);

    const sqlFile = migrationSql('backfill_cluster_announced');
    for (const statement of sqlFile.split('--> statement-breakpoint')) await db.run(sql.raw(statement));
    await emitRunNotifications(db as never, 2);
    expect(announced()).toEqual([]);
  });

  test('the startup pass releases the claim the migration set on a cluster no run announced', async () => {
    // Cluster 7: an editor run and an import failed into it; 8: a CI run still running at the upgrade; 9: a
    // cancelled run; 10: a CI run that ran to its end; 11: claimed by a run since deleted.
    await addRun(1, editorRun);
    await addRun(2, { status: 'failed', origin: 'import', metadata: { import: { source: 'blob' } } });
    await addRun(3, { status: 'running' });
    await addRun(4, { status: 'cancelled' });
    await addRun(5, { status: 'failed' });
    await addCluster(7, 1);
    await addCluster(8, 3);
    await addCluster(9, 4);
    await addCluster(10, 5);
    await addCluster(11, 1, {
      createdAt: new Date('2026-10-01T00:00:00Z'),
      announcedAt: new Date('2026-10-02T00:00:00Z'),
    });
    await addFailures([1, 7], [2, 7], [3, 8], [4, 9], [5, 10]);
    const sqlFile = migrationSql('backfill_cluster_announced');
    for (const statement of sqlFile.split('--> statement-breakpoint')) await db.run(sql.raw(statement));

    expect(await releaseUnannouncedClusterClaimsOnce(db as never)).toBe(3);

    await db.update(schema.testRuns).set({ status: 'failed' }).where(eq(schema.testRuns.id, 3));
    await emitRunNotifications(db as never, 3);
    await addRun(6, { status: 'failed' });
    await addFailures([6, 7], [6, 9], [6, 10], [6, 11]);
    await emitRunNotifications(db as never, 6);
    expect(announcedBy().sort()).toEqual([
      [7, 6],
      [8, 3],
      [9, 6],
    ]);
  });

  test('the startup pass runs once', async () => {
    expect(await releaseUnannouncedClusterClaimsOnce(db as never)).toBe(0);
    await addRun(1, editorRun);
    await addCluster(7, 1);
    await addFailures([1, 7]);
    const sqlFile = migrationSql('backfill_cluster_announced');
    for (const statement of sqlFile.split('--> statement-breakpoint')) await db.run(sql.raw(statement));

    expect(await releaseUnannouncedClusterClaimsOnce(db as never)).toBeNull();
    const [cluster] = await db
      .select({ announcedAt: schema.failureClusters.announcedAt })
      .from(schema.failureClusters)
      .where(eq(schema.failureClusters.id, 7));
    expect(cluster!.announcedAt).not.toBeNull();
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
