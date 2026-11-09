import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { migrateToLatest, openTempDb } from './temp-db';

/** What a test can observe of a database: its objects as SQLite stores them, its rows, and the foreign keys setting. */
async function observe(client: Client) {
  const objects = await client.execute('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
  const rows: Record<string, unknown[]> = {};
  for (const object of objects.rows.filter((row) => row.type === 'table')) {
    rows[String(object.name)] = (await client.execute(`SELECT * FROM "${object.name}"`)).rows.map((row) => ({
      ...row,
    }));
  }
  const foreignKeys = (await client.execute('PRAGMA foreign_keys')).rows[0]!.foreign_keys;
  return { objects: objects.rows.map((row) => ({ ...row })), rows, foreignKeys };
}

describe('migrateToLatest', () => {
  test("builds the database Drizzle's migrate builds, in memory and in a file", async () => {
    const migrated = createClient({ url: ':memory:' });
    await migrate(drizzle(migrated), {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    const expected = await observe(migrated);
    migrated.close();
    expect(expected.rows.__drizzle_migrations!.length).toBeGreaterThan(100);

    const replayed = createClient({ url: ':memory:' });
    await migrateToLatest(drizzle(replayed));
    expect(await observe(replayed)).toEqual(expected);
    replayed.close();

    const { db, close } = await openTempDb();
    try {
      expect(await observe(db.$client)).toEqual(expected);
    } finally {
      await close();
    }
  });
});
