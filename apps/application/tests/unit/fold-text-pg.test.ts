import { afterAll, describe } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { foldedPredicates, VALUES, type Engine } from './folded-predicates';

const pg = new PgDialect();
const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
let closePostgres: (() => Promise<void>) | null = null;

async function postgresEngine(): Promise<Engine> {
  const { default: postgres } = await import('postgres');
  const client = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  const table = `piwi_fold_text_${process.pid}`;
  await client.unsafe(`DROP TABLE IF EXISTS ${table}; CREATE TABLE ${table} (value TEXT)`);
  for (const v of VALUES) await client.unsafe(`INSERT INTO ${table} (value) VALUES ($1)`, [v]);
  closePostgres = async () => {
    await client.unsafe(`DROP TABLE IF EXISTS ${table}`);
    await client.end();
  };
  return {
    name: 'PostgreSQL',
    postgres: true,
    async select(where) {
      const query = pg.sqlToQuery(sql`SELECT value FROM ${sql.identifier(table)} WHERE ${where}`);
      const rows = await client.unsafe(query.sql, query.params as never[]);
      return rows.map((row) => String(row.value)).sort();
    },
  };
}

afterAll(async () => {
  await closePostgres?.();
});

describe.skipIf(!postgresUrl)('PostgreSQL (PIWI_POSTGRES_TEST_URL)', () => {
  foldedPredicates('PostgreSQL', postgresEngine);
});
