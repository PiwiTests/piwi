import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { TestProject } from 'vitest/node';

/**
 * Runs every SQLite migration once per run, on an in-memory database, and hands the test files the statements that
 * rebuild it (`migrateToLatest` in `temp-db.ts`). Watch mode migrates again before each rerun, for a new migration.
 */
export default async function setup(project: TestProject) {
  project.provide('migratedSchema', await migratedSchema());
  project.onTestsRerun(async () => project.provide('migratedSchema', await migratedSchema()));
}

async function migratedSchema(): Promise<string[]> {
  const client = createClient({ url: ':memory:' });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    return await readBack(client);
  } finally {
    client.close();
  }
}

/**
 * Each table followed by its rows (`__drizzle_migrations` included), then the views, indexes and triggers, so no
 * trigger fires on a copied row.
 */
async function readBack(client: Client): Promise<string[]> {
  const objects = await client.execute(
    `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, rowid`,
  );
  const statements: string[] = [];
  for (const object of objects.rows) {
    statements.push(String(object.sql));
    if (object.type === 'table') statements.push(...(await rowsOf(client, String(object.name))));
  }
  // Copying a row with its id into an AUTOINCREMENT table writes `sqlite_sequence`: its own rows replace those.
  const sequence = await client.execute(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'`);
  if (sequence.rows.length > 0)
    statements.push('DELETE FROM sqlite_sequence', ...(await rowsOf(client, 'sqlite_sequence')));
  return statements;
}

async function rowsOf(client: Client, table: string): Promise<string[]> {
  const columns = await client.execute({ sql: 'SELECT name FROM pragma_table_info(?)', args: [table] });
  const values = columns.rows.map((column) => `quote("${String(column.name)}")`).join(` || ',' || `);
  const rows = await client.execute(`SELECT ${values} AS row FROM "${table}"`);
  return rows.rows.map((row) => `INSERT INTO "${table}" VALUES (${String(row.row)})`);
}
