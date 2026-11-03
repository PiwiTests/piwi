import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { STORED_ATTEMPTS, expectedFinalFlags, finalAttemptBackfillSql } from './final-attempt-fixture';

/**
 * Each execution's `final_attempt` on PostgreSQL: set by the migration on the
 * executions stored before it, and kept right by ingest when a later attempt
 * arrives, or an attempt after a later one. Runs against
 * `PIWI_POSTGRES_TEST_URL`, in a database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_final_attempt_${process.pid}`;
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

const MIGRATIONS = fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url));

describe.skipIf(!postgresUrl)('final attempts on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { asc, eq } = await import('drizzle-orm');
  const schema = await import('../../server/database/schema.pg');
  const { persistRunCases } = await import('../../server/utils/persist-run-cases');
  const { mapWireCaseToRunCase } = await import('../../server/utils/map-wire-case');
  const { getTestCase } = await import('#shared/handlers/test-cases');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let projectId: number;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 4 });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const [project] = await db.insert(schema.projects).values({ name: 'final-attempts' }).returning();
    projectId = project!.id;
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  /** One attempt of a test as the reporter sends it, with its attempt history up to it. */
  const attempt = (title: string, statuses: string[]) =>
    mapWireCaseToRunCase({
      title,
      location: `tests/checkout.spec.ts:${title.length}:5`,
      status: statuses.at(-1)!,
      duration: 100,
      retries: statuses.length - 1,
      repeatEachIndex: 0,
      attempts: statuses.map((status, retry) => ({ retry, status, duration: 100, startedAt: null })),
      browser: { projectName: 'chromium' },
    } as never);

  test('ingest settles an attempt once its retry arrives, and an attempt that arrives after its retry', async () => {
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId, status: 'running', startTime: new Date() })
      .returning();
    const store = (tc: ReturnType<typeof attempt>) => persistRunCases(db as never, projectId, run!.id, [tc]);
    await store(attempt('pays', ['failed']));
    await store(attempt('pays', ['failed', 'passed']));
    await store(attempt('refunds', ['failed', 'passed']));
    await store(attempt('refunds', ['failed']));

    const rows = await db
      .select({
        title: schema.testCases.title,
        retries: schema.testRunsCases.retries,
        finalAttempt: schema.testRunsCases.finalAttempt,
      })
      .from(schema.testRunsCases)
      .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testRunsCases.testCaseId))
      .where(eq(schema.testRunsCases.testRunId, run!.id))
      .orderBy(asc(schema.testCases.title), asc(schema.testRunsCases.retries));
    expect(rows).toEqual([
      { title: 'pays', retries: 0, finalAttempt: false },
      { title: 'pays', retries: 1, finalAttempt: true },
      { title: 'refunds', retries: 0, finalAttempt: false },
      { title: 'refunds', retries: 1, finalAttempt: true },
    ]);
    const [pays] = await db.select().from(schema.testCases).where(eq(schema.testCases.title, 'pays'));
    expect(await getTestCase(db as never, pays!.id)).toMatchObject({ totalRuns: 1, flakyRuns: 1 });
  });

  test('the migration marks the executions stored before it as finalAttempts reads them', async () => {
    const session = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
    try {
      // A temporary table of the same name is the one the migration's UPDATE reaches in this session.
      await session`CREATE TEMP TABLE test_runs_cases (
          id integer PRIMARY KEY, test_run_id integer NOT NULL, test_case_id integer NOT NULL,
          repeat_each_index integer NOT NULL DEFAULT 0, retries integer DEFAULT 0, browser_name text,
          final_attempt boolean NOT NULL DEFAULT true)`;
      for (const [i, row] of STORED_ATTEMPTS.entries()) {
        await session`INSERT INTO test_runs_cases (id, test_run_id, test_case_id, repeat_each_index, retries, browser_name)
          VALUES (${i + 1}, ${row.testRunId}, ${row.testCaseId}, ${row.repeatEachIndex}, ${row.retries}, ${row.browserName})`;
      }
      await session.unsafe(finalAttemptBackfillSql(MIGRATIONS));
      const rows = await session<
        Array<{ final_attempt: boolean }>
      >`SELECT final_attempt FROM test_runs_cases ORDER BY id`;
      expect(rows.map((row) => row.final_attempt)).toEqual(expectedFinalFlags());
    } finally {
      await session.end();
    }
  });
});
