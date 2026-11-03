import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A cluster's `cluster.new` claim on PostgreSQL: the startup pass releases the
 * claim the migration adding `announced_at` set on a cluster no run announced,
 * and the next run that ends and sends notifications claims it. Runs against
 * `PIWI_POSTGRES_TEST_URL`, in a database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_cluster_announce_${process.pid}`;
// The schema barrel picks the PostgreSQL schema at import time.
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.pathname = `/${databaseName}`;
  process.env.PIWI_DATABASE_URL = url.toString();
}

const MIGRATIONS = fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url));

describe.skipIf(!postgresUrl)('cluster.new claims on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { eq } = await import('drizzle-orm');
  const schema = await import('../../server/database/schema.pg');
  const { clustersToAnnounce, releaseUnannouncedClusterClaimsOnce } =
    await import('../../server/utils/notifications/run-notifications');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const runs = { editor: 0, ended: 0, running: 0, next: 0 };
  const clusters = { editor: 0, ended: 0, running: 0 };
  let testCaseId = 0;

  /** The test failing into cluster `failureClusterId` in run `testRunId`, in a browser project of the cluster's own. */
  async function addFailures(...pairs: Array<[testRunId: number, failureClusterId: number]>) {
    await db.insert(schema.testRunsCases).values(
      pairs.map(([testRunId, failureClusterId]) => ({
        testRunId,
        testCaseId,
        status: 'failed',
        browserName: `browser-${failureClusterId}`,
        failureClusterId,
      })),
    );
  }

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 4 });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const [project] = await db.insert(schema.projects).values({ name: 'cluster-announce' }).returning();
    const [testCase] = await db
      .insert(schema.testCases)
      .values({ projectId: project!.id, filePath: 'tests/pay.spec.ts', title: 'pays' })
      .returning();
    const ci = { status: 'failed', origin: 'ci', metadata: { ci: { provider: 'github' } } };
    const [editor, ended, running, next] = await db
      .insert(schema.testRuns)
      .values(
        [
          { status: 'failed', origin: 'editor', isFullRun: 0, metadata: { piwiOrigin: { kind: 'editor' } } },
          ci,
          { ...ci, status: 'running' },
          ci,
        ].map((run, i) => ({ projectId: project!.id, startTime: new Date(Date.UTC(2026, 9, 1, i)), ...run })),
      )
      .returning();
    Object.assign(runs, { editor: editor!.id, ended: ended!.id, running: running!.id, next: next!.id });
    const stored = await db
      .insert(schema.failureClusters)
      .values(
        [runs.editor, runs.ended, runs.running].map((firstSeenRunId, i) => ({
          projectId: project!.id,
          fingerprint: `fp-${i}`,
          signature: `Error: broken ${i}`,
          firstSeenRunId,
          lastSeenRunId: firstSeenRunId,
        })),
      )
      .returning();
    Object.assign(clusters, { editor: stored[0]!.id, ended: stored[1]!.id, running: stored[2]!.id });
    testCaseId = testCase!.id;
    await addFailures([runs.editor, clusters.editor], [runs.ended, clusters.ended], [runs.running, clusters.running]);
    await client.unsafe(readFileSync(`${MIGRATIONS}/0148_backfill_cluster_announced.sql`, 'utf8'));
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  test('the startup pass releases the claim the migration set on a cluster no run announced', async () => {
    expect(await releaseUnannouncedClusterClaimsOnce(db as never)).toBe(2);
    expect(await releaseUnannouncedClusterClaimsOnce(db as never)).toBeNull();

    await db.update(schema.testRuns).set({ status: 'failed' }).where(eq(schema.testRuns.id, runs.running));
    await addFailures([runs.next, clusters.editor], [runs.next, clusters.ended]);
    expect(await clustersToAnnounce(db as never, runs.running)).toEqual([clusters.running]);
    expect(await clustersToAnnounce(db as never, runs.next)).toEqual([clusters.editor]);
  });
});
