import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type Client } from '@libsql/client/sqlite3';
import { sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';

const dataDir = mkdtempSync(join(tmpdir(), 'piwi-sqlite-reclaim-'));
const dbPath = join(dataDir, 'piwi.db');
delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_DATABASE_PATH = dbPath;
const { getDatabase } = await import('../../server/database');
const { reclaimSpace } = await import('../../server/utils/retention');

let db: Awaited<ReturnType<typeof getDatabase>>;
// Another process's connection to the same file, with a short busy timeout so
// a lock left behind fails the test quickly.
let other: Client;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  db = await getDatabase();
  other = createClient({ url: pathToFileURL(dbPath).href, timeout: 200 });
});

afterAll(() => {
  other.close();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

async function freePages() {
  const row = await db.get<{ freelist_count: number }>(sql`PRAGMA freelist_count`);
  return row!.freelist_count;
}

describe('reclaimSpace on SQLite', () => {
  test('frees every page and leaves no write lock behind', async () => {
    await db.run(sql`CREATE TABLE reclaim_probe (v TEXT)`);
    await db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
      INSERT INTO reclaim_probe (v) SELECT hex(randomblob(1000)) FROM n`);
    await db.run(sql`DELETE FROM reclaim_probe`);
    expect(await freePages()).toBeGreaterThan(1);

    expect(await reclaimSpace(db)).toEqual({ attempted: true, note: 'incremental vacuum completed' });
    expect(await freePages()).toBe(0);

    // Another connection writes without waiting for a lock, and sees what the
    // server writes next, so that write was committed.
    await other.execute("INSERT INTO reclaim_probe (v) VALUES ('other')");
    await db.insert(schema.projects).values({ name: 'after-reclaim' });
    const seen = await other.execute("SELECT count(*) AS n FROM projects WHERE name = 'after-reclaim'");
    expect(Number(seen.rows[0]!.n)).toBe(1);
  });
});
