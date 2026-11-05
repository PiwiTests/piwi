import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { seedFailRanksFixture } from './fail-ranks-fixture';

/**
 * The recency rank of each test's newest failure within its latest results on
 * PostgreSQL: the same fixture and rule as `selection-fail-ranks.test.ts`.
 * Runs against `PIWI_POSTGRES_TEST_URL`, in a database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_fail_ranks_${process.pid}`;
// The schema barrel picks the PostgreSQL schema at import time.
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.pathname = `/${databaseName}`;
  process.env.PIWI_DATABASE_URL = url.toString();
}

describe.skipIf(!postgresUrl)('firstFailRank on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const schema = await import('../../server/database/schema.pg');
  const { loadSelectionCatalog } = await import('#shared/handlers/selections');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 4 });
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url)),
    });
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  test('ranks the newest failure among the latest results of eligible runs', async () => {
    const fixture = await seedFailRanksFixture(db, schema);

    const catalog = await loadSelectionCatalog(db as never, fixture.projectId, {
      withFailRanks: true,
      withAggregates: false,
    });
    const ranks = new Map(catalog.filter((row) => row.firstFailRank != null).map((row) => [row.id, row.firstFailRank]));

    expect(catalog.map((row) => row.id).sort((a, b) => a - b)).toEqual(fixture.testCaseIds);
    expect(ranks).toEqual(fixture.expected);
  });
});
