import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * The version `GET /api/projects/:id/branch-failures` derives its `ETag` from, read on PostgreSQL: the same data is
 * the same version, and a result, a cluster's title or a stored file is another. Runs against
 * `PIWI_POSTGRES_TEST_URL`, in a database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_branch_failures_${process.pid}`;
// The schema barrel picks the PostgreSQL schema at import time.
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.pathname = `/${databaseName}`;
  process.env.PIWI_DATABASE_URL = url.toString();
}

describe.skipIf(!postgresUrl)('the branch failures version on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { eq } = await import('drizzle-orm');
  const schema = await import('../../server/database/schema.pg');
  const { getBranchFailures, readBranchFailures } = await import('../../server/utils/branch-failures');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let projectId: number;
  let runId: number;
  let executionId: number;
  let clusterId: number;
  let testCaseId: number;

  const read = () =>
    readBranchFailures(db as never, projectId, { branch: 'main' }, (statusCode, message) =>
      Object.assign(new Error(message), { statusCode }),
    );
  const version = async () => JSON.stringify(await (await read()).version());

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 4 });
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url)),
    });
    const [project] = await db.insert(schema.projects).values({ name: 'branch-failures' }).returning();
    projectId = project!.id;
    const [test] = await db
      .insert(schema.testCases)
      .values({ projectId, filePath: 'tests/checkout.spec.ts', title: 'pays' })
      .returning();
    testCaseId = test!.id;
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId, status: 'failed', branch: 'main', startTime: new Date(), totalTests: 1 })
      .returning();
    runId = run!.id;
    const [cluster] = await db
      .insert(schema.failureClusters)
      .values({ projectId, fingerprint: 'fp', signature: 'expected 200', firstSeenRunId: runId, lastSeenRunId: runId })
      .returning();
    clusterId = cluster!.id;
    const [execution] = await db
      .insert(schema.testRunsCases)
      .values({
        testRunId: runId,
        testCaseId,
        status: 'failed',
        error: 'Error: expected 200',
        failureClusterId: clusterId,
      })
      .returning();
    executionId = execution!.id;
    await db
      .insert(schema.files)
      .values({ testRunId: runId, testRunsCaseId: executionId, type: 'trace', path: 't.zip' });
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  test('is the same for the same data, and its answer is the one computed alone', async () => {
    expect(await version()).toBe(await version());
    expect(await (await read()).answer()).toEqual(
      await getBranchFailures(db as never, projectId, 'main', { overlays: false }),
    );
  });

  test('changes with a result stored since, a cluster title and a stored file', async () => {
    const changes = [
      () =>
        db
          .insert(schema.testRunsCases)
          .values({ testRunId: runId, testCaseId, repeatEachIndex: 1, status: 'passed' })
          .then(() => {}),
      () =>
        db
          .update(schema.failureClusters)
          .set({ title: 'Checkout answers 500' })
          .where(eq(schema.failureClusters.id, clusterId))
          .then(() => {}),
      () =>
        db
          .insert(schema.files)
          .values({ testRunId: runId, testRunsCaseId: executionId, type: 'screenshot', path: 's.png' })
          .then(() => {}),
    ];
    let before = await version();
    for (const change of changes) {
      await change();
      const after = await version();
      expect(after).not.toBe(before);
      before = after;
    }
  });
});
