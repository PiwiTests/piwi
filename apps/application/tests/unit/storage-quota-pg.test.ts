import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The storage quota's running total on PostgreSQL: the statement triggers add each statement's rows at once, and a
 * run's update of its results row by row, spread over the sessions' slots, and the total always agrees with what
 * Settings → Storage counts plus the runs' results, also when sessions write at the same time and when a statement
 * deletes many rows. Runs against `PIWI_POSTGRES_TEST_URL`, in a database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_storage_quota_${process.pid}`;
// The schema barrel picks the PostgreSQL schema at import time.
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.pathname = `/${databaseName}`;
  process.env.PIWI_DATABASE_URL = url.toString();
}

describe.skipIf(!postgresUrl)('the storage total on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { eq, ne, sql } = await import('drizzle-orm');
  const schema = await import('../../server/database/schema.pg');
  const { reconcileStorageTotal, storageUsedBytes } = await import('../../server/utils/storage-quota');
  const { getStorageAnalysis } = await import('#shared/handlers/admin-storage');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let projectId: number;

  const used = () => storageUsedBytes(db as never);
  const counted = async () => {
    const [results] = await db
      .select({ bytes: sql<number>`coalesce(sum(${schema.testRuns.resultsBytes}), 0)` })
      .from(schema.testRuns);
    return (await getStorageAnalysis(db as never)).totalBytes + Number(results!.bytes);
  };

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 4 });
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url)),
    });
    const [project] = await db.insert(schema.projects).values({ name: 'storage-quota' }).returning();
    projectId = project!.id;
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  test('has one slot per session spread, starting at nothing', async () => {
    expect(await db.select().from(schema.storageTotals)).toHaveLength(16);
    expect(await used()).toBe(0);
  });

  test('has a trigger for each write of every table it counts, after the latest migration', async () => {
    const triggers = await client<{ name: string; table: string; level: string; columns: string[] }[]>`
      SELECT t.tgname AS name, t.tgrelid::regclass::text AS table,
        CASE WHEN t.tgtype & 1 = 1 THEN 'row' ELSE 'statement' END AS level,
        array(SELECT a.attname FROM unnest(t.tgattr) AS k JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k)::text[] AS columns
      FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'storage_totals_%' ORDER BY t.tgname`;
    const statementTriggers = (table: string) =>
      ['delete', 'insert', 'update'].map((write) => ({
        name: `storage_totals_${table}_${write}`,
        table,
        level: 'statement',
        columns: [],
      }));
    expect(triggers).toEqual([
      ...statementTriggers('files'),
      { name: 'storage_totals_test_runs_delete', table: 'test_runs', level: 'statement', columns: [] },
      { name: 'storage_totals_test_runs_insert', table: 'test_runs', level: 'statement', columns: [] },
      // Only an update of a run's results runs it, row by row.
      { name: 'storage_totals_test_runs_update', table: 'test_runs', level: 'row', columns: ['results_bytes'] },
      ...statementTriggers('trace_blobs'),
      ...statementTriggers('trace_resources'),
    ]);
  });

  test('follows inserts, updates and deletes of the three tables, many rows to a statement', async () => {
    const [blob] = await db
      .insert(schema.traceBlobs)
      .values({ projectId, hash: 'a'.repeat(64), path: 'project-1/blobs/a.zip', size: 5000, storedSize: 1200 })
      .returning();
    await db.insert(schema.traceResources).values([
      { projectId, name: 'r1', path: 'project-1/trace-resources/r1', size: 40 },
      { projectId, name: 'r2', path: 'project-1/trace-resources/r2', size: 60 },
    ]);
    await db.insert(schema.files).values([
      ...Array.from({ length: 500 }, (_, index) => ({
        type: 'screenshot',
        path: `project-1/${index}.png`,
        size: 10,
      })),
      { type: 'trace', path: 'project-1/t.zip', size: 5000, blobId: blob!.id },
    ]);
    expect(await used()).toBe(1200 + 100 + 5000);
    expect(await used()).toBe(await counted());

    await db.update(schema.files).set({ size: 20 }).where(eq(schema.files.type, 'screenshot'));
    await db.update(schema.traceBlobs).set({ storedSize: null }).where(eq(schema.traceBlobs.id, blob!.id));
    expect(await used()).toBe(5000 + 100 + 10000);
    expect(await used()).toBe(await counted());

    await db.delete(schema.files).where(eq(schema.files.type, 'screenshot'));
    expect(await used()).toBe(5000 + 100);
    expect(await used()).toBe(await counted());
  });

  test("follows the runs' results, many runs to a statement, and leaves other run updates alone", async () => {
    const before = await used();
    const runs = await db
      .insert(schema.testRuns)
      .values(
        Array.from({ length: 20 }, (_, index) => ({
          projectId,
          status: 'running',
          startTime: new Date(),
          resultsBytes: index * 10,
        })),
      )
      .returning({ id: schema.testRuns.id });
    expect(await used()).toBe(before + 1900);

    await db
      .update(schema.testRuns)
      .set({ resultsBytes: sql`${schema.testRuns.resultsBytes} + 5` })
      .where(eq(schema.testRuns.id, runs[0]!.id));
    await db.update(schema.testRuns).set({ passedTests: 2 });
    expect(await used()).toBe(before + 1905);
    await db.update(schema.testRuns).set({ resultsBytes: sql`${schema.testRuns.resultsBytes} + 1` });
    await db.update(schema.testRuns).set({ resultsBytes: sql`${schema.testRuns.resultsBytes}` });
    expect(await used()).toBe(before + 1925);
    expect(await used()).toBe(await counted());

    await db.delete(schema.testRuns);
    expect(await used()).toBe(before);
    expect(await used()).toBe(await counted());
  });

  test('agrees with the tables when sessions write at the same time', async () => {
    await Promise.all(
      Array.from({ length: 4 }, (_, session) =>
        db.transaction(async (tx) => {
          for (let index = 0; index < 25; index++) {
            await tx
              .insert(schema.files)
              .values({ type: 'video', path: `project-1/${session}-${index}.webm`, size: 7 });
          }
        }),
      ),
    );
    expect(await used()).toBe(await counted());
  });

  test('keeps a write in flight while it is recounted', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const insertedOnce = new Promise<void>((resolve) => (inserted = resolve));
    const writer = db.transaction(async (tx) => {
      await tx.insert(schema.files).values({ type: 'video', path: 'project-1/in-flight.webm', size: 1000 });
      inserted();
      await held;
    });
    await insertedOnce;
    const recount = reconcileStorageTotal(db as never);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await writer;
    await recount;
    expect(await used()).toBe(await counted());
  });

  test('keeps its triggers through a second run of their migrations, and makes missing slots again', async () => {
    for (const name of [
      '0200_storage_total_triggers.sql',
      '0202_storage_total_results.sql',
      '0203_storage_total_results_rows.sql',
    ]) {
      const migration = readFileSync(
        fileURLToPath(new URL(`../../server/database/migrations-pg/${name}`, import.meta.url)),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint')) await client.unsafe(statement);
    }
    await db.delete(schema.storageTotals).where(ne(schema.storageTotals.slot, 0));
    await reconcileStorageTotal(db as never);
    expect(await db.select().from(schema.storageTotals)).toHaveLength(16);
    await db.insert(schema.files).values({ type: 'video', path: 'project-1/after.webm', size: 3 });
    await db.insert(schema.testRuns).values({ projectId, status: 'passed', startTime: new Date(), resultsBytes: 9 });
    expect(await used()).toBe(await counted());
  });

  test('is recounted from the tables', async () => {
    await db.update(schema.storageTotals).set({ bytes: 99 });
    expect(await reconcileStorageTotal(db as never)).toBe(await counted());
    expect((await db.select().from(schema.storageTotals)).filter((slot) => slot.bytes !== 0)).toHaveLength(1);
  });
});
