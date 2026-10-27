import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';

const dataDir = mkdtempSync(join(tmpdir(), 'piwi-sqlite-connections-'));
delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_DATABASE_PATH = join(dataDir, 'piwi.db');
const { getDatabase } = await import('../../server/database');

let db: Awaited<ReturnType<typeof getDatabase>>;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  db = await getDatabase();
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Open a write transaction that inserts a project and stays open until `release` is called. */
async function holdTransaction(name: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let begun!: () => void;
  const inside = new Promise<void>((resolve) => (begun = resolve));
  const done = db.transaction(async (tx) => {
    await tx.insert(schema.projects).values({ name });
    begun();
    await released;
  });
  await inside;
  return { release, done };
}

/** Track a pending statement: `outcome` stays empty while it waits. */
function track(pending: Promise<unknown>) {
  const outcome: string[] = [];
  const settled = pending.then(
    () => outcome.push('done'),
    () => outcome.push('failed'),
  );
  return { outcome, settled };
}

async function projectNames() {
  const rows = await db.select({ name: schema.projects.name }).from(schema.projects);
  return rows.map((row) => row.name).sort();
}

describe('SQLite connections', () => {
  test('a write waits for an open transaction instead of failing with SQLITE_BUSY', async () => {
    const transaction = await holdTransaction('inside');
    const write = track(db.insert(schema.projects).values({ name: 'outside' }));
    await pause(50);
    expect(write.outcome).toEqual([]);

    transaction.release();
    await transaction.done;
    await write.settled;
    expect(write.outcome).toEqual(['done']);
    expect(await projectNames()).toEqual(['inside', 'outside']);
  });

  test('a second transaction waits for the first', async () => {
    const first = await holdTransaction('first');
    const second = track(db.transaction(async (tx) => tx.insert(schema.projects).values({ name: 'second' })));
    await pause(50);
    expect(second.outcome).toEqual([]);

    first.release();
    await first.done;
    await second.settled;
    expect(second.outcome).toEqual(['done']);
    expect(await projectNames()).toEqual(['first', 'inside', 'outside', 'second']);
  });

  test('a read runs beside an open transaction', async () => {
    const transaction = await holdTransaction('uncommitted');
    const read = track(db.select().from(schema.projects));
    await pause(50);
    expect(read.outcome).toEqual(['done']);

    transaction.release();
    await transaction.done;
  });

  test('the pragmas hold on both connections of the pool', async () => {
    // A select, so it runs beside an open transaction; `uncommitted` counts the
    // row that transaction inserted, which only its own connection sees.
    const settings = sql`SELECT
      (SELECT timeout FROM pragma_busy_timeout) AS busyTimeout,
      (SELECT synchronous FROM pragma_synchronous) AS synchronous,
      (SELECT foreign_keys FROM pragma_foreign_keys) AS foreignKeys,
      (SELECT journal_mode FROM pragma_journal_mode) AS journalMode,
      (SELECT count(*) FROM projects WHERE name = 'pooled') AS uncommitted`;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let inside!: (rows: unknown[]) => void;
    const transactionRows = new Promise<unknown[]>((resolve) => (inside = resolve));
    const done = db.transaction(async (tx) => {
      await tx.insert(schema.projects).values({ name: 'pooled' });
      inside(await tx.all(settings));
      await released;
    });
    const expected = { busyTimeout: 5000, synchronous: 1, foreignKeys: 1, journalMode: 'wal' };
    expect(await transactionRows).toEqual([{ ...expected, uncommitted: 1 }]);
    expect(await db.all(settings)).toEqual([{ ...expected, uncommitted: 0 }]);

    release();
    await done;
  });
});
