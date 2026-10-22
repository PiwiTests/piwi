import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * A `--repeat-each` run stored and read on PostgreSQL: each repetition is its
 * own execution, and the queries that read a test's latest run fail it when one
 * of its repetitions failed. Runs against `PIWI_POSTGRES_TEST_URL`, in a
 * database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_repeat_each_${process.pid}`;
// The schema barrel picks the PostgreSQL schema at import time.
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.pathname = `/${databaseName}`;
  process.env.PIWI_DATABASE_URL = url.toString();
}

// The feature graph is written after the ingest returns; it plays no part here.
vi.mock('../../server/utils/graph-ingest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/utils/graph-ingest')>()),
  ingestRunGraph: async () => {},
  ingestRequestGraph: async () => {},
  upsertGraphSpecs: async () => {},
  ingestPageInventoryGraph: async () => {},
}));

describe.skipIf(!postgresUrl)('a --repeat-each run on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { asc, eq } = await import('drizzle-orm');
  const schema = await import('../../server/database/schema.pg');
  const { persistRunCases } = await import('../../server/utils/persist-run-cases');
  const { mapWireCaseToRunCase } = await import('../../server/utils/map-wire-case');
  const { computeRunCountsFromRows } = await import('../../server/utils/run-counts');
  const { getProjectTestCases } = await import('#shared/handlers/projects');
  const { loadSelectionCatalog } = await import('#shared/handlers/selections');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let projectId: number;
  let runId: number;

  const result = (repeatEachIndex: number, status: string) => ({
    title: 'pays',
    location: 'tests/checkout.spec.ts:9:5',
    status,
    duration: 100,
    retries: 0,
    repeatEachIndex,
    error: status === 'failed' ? 'Error: expect(received).toBe(expected)' : null,
    browser: { projectName: 'chromium' },
  });

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 4 });
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url)),
    });
    const [project] = await db.insert(schema.projects).values({ name: 'repeat-each' }).returning();
    projectId = project!.id;
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId, status: 'failed', startTime: new Date(), totalTests: 3, isFullRun: 1 })
      .returning();
    runId = run!.id;
    // The failed repetition is stored first, the passing ones after it.
    const cases = [result(1, 'failed'), result(0, 'passed'), result(2, 'passed')].map(mapWireCaseToRunCase);
    await persistRunCases(db as never, projectId, runId, cases);
    // A batch sent again stores nothing.
    await persistRunCases(db as never, projectId, runId, cases);
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  test('stores each repetition once and counts each', async () => {
    const rows = await db
      .select({ repeatEachIndex: schema.testRunsCases.repeatEachIndex, status: schema.testRunsCases.status })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testRunId, runId))
      .orderBy(asc(schema.testRunsCases.repeatEachIndex));
    expect(rows).toEqual([
      { repeatEachIndex: 0, status: 'passed' },
      { repeatEachIndex: 1, status: 'failed' },
      { repeatEachIndex: 2, status: 'passed' },
    ]);
    expect(await computeRunCountsFromRows(db as never, runId)).toMatchObject({
      totalTests: 3,
      passedTests: 2,
      failedTests: 1,
    });
  });

  test("reads the test as failed in its latest run, in the catalog's status, filter and sort", async () => {
    expect((await getProjectTestCases(db as never, projectId)).items.map((t: any) => t.status)).toEqual(['failed']);
    const failed = await getProjectTestCases(db as never, projectId, { statuses: ['failed'], sort: 'status' });
    expect(failed.items.map((t: any) => t.title)).toEqual(['pays']);
    expect((await loadSelectionCatalog(db as never, projectId)).map((t) => t.lastStatus)).toEqual(['failed']);
  });
});
