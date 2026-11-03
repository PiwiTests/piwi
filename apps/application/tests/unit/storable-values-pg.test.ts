import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * A test whose file, describe path and title fill an index entry, stored and found on PostgreSQL: whole while they
 * take at most `MAX_TEST_IDENTITY_BYTES` together, shortened past it. Runs against `PIWI_POSTGRES_TEST_URL`, in a
 * database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_storable_values_${process.pid}`;
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

/** `length` printable ASCII characters in no repeating pattern, which no compression of an index entry shortens. */
function incompressible(length: number, seed: number): string {
  let state = seed;
  let text = '';
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    text += String.fromCharCode(33 + (state % 94));
  }
  return text;
}

describe.skipIf(!postgresUrl)("a test's identity on PostgreSQL", async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const schema = await import('../../server/database/schema.pg');
  const { persistRunCases } = await import('../../server/utils/persist-run-cases');
  const { runningTestHistory } = await import('../../shared/handlers/stuck-tests');
  const { MAX_TEST_IDENTITY_BYTES } = await import('../../server/utils/storable-values');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let projectId: number;
  let runId: number;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 4 });
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url)),
    });
    const [project] = await db.insert(schema.projects).values({ name: 'storable-values' }).returning();
    projectId = project!.id;
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId, status: 'passed', startTime: new Date(), totalTests: 2, isFullRun: 1 })
      .returning();
    runId = run!.id;
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  test.each([
    ['whole at the most an index entry takes', MAX_TEST_IDENTITY_BYTES, 1],
    ['shortened past it', MAX_TEST_IDENTITY_BYTES + 400, 2],
  ])('is stored %s, and found by its names', async (_shape, together, seed) => {
    const test = {
      filePath: incompressible(900, seed),
      suitePath: [incompressible(900, seed + 10)],
      title: incompressible(together - 1800, seed + 20),
    };

    const [stored] = await persistRunCases(db as never, projectId, runId, [
      {
        ...test,
        status: 'passed',
        duration: 1200,
        line: 1,
        column: 1,
        retries: 0,
        browser: { projectName: 'chromium' },
      },
    ]);
    expect(stored).toBeDefined();

    const history = await runningTestHistory(db as never, { projectId, ...test, browserName: 'chromium' });
    expect(history.passingDurations).toEqual([1200]);
  });
});
