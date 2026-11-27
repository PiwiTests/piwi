/**
 * The storage quota: the running total the database's triggers keep (counted as Settings → Storage counts, so the two
 * always agree, plus the results each run's reporter sent), its nightly recount, the levels administrators are warned
 * at, and the watch that tells them once per level crossed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { nextStorageWarning, storageWarningLevel } from '#shared/storage-quota';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const { reconcileStorageTotal, storageQuotaBytes, storageUsedBytes, watchStorageQuota } =
  await import('../../server/utils/storage-quota');
const { getStorageAnalysis } = await import('#shared/handlers/admin-storage');

describe('the warning levels', () => {
  test('are 80% and 95% of the quota', () => {
    expect(storageWarningLevel(799, 1000)).toBe(0);
    expect(storageWarningLevel(800, 1000)).toBe(80);
    expect(storageWarningLevel(949, 1000)).toBe(80);
    expect(storageWarningLevel(950, 1000)).toBe(95);
    expect(storageWarningLevel(1500, 1000)).toBe(95);
  });

  test('warn once per level crossed, and again only after the usage fell 5 points below it', () => {
    let told: 0 | 80 | 95 = 0;
    const read = (used: number) => {
      const next = nextStorageWarning(told, used, 1000);
      told = next.told;
      return next.announce;
    };
    expect([read(700), read(810), read(820), read(960), read(970)]).toEqual([false, true, false, true, false]);
    // Back to 92%: still within 5 points of 95, nothing new.
    expect([read(920), told]).toEqual([false, 95]);
    // At 85%, the 95% warning can come again; the 80% one still holds.
    expect([read(850), told, read(955)]).toEqual([false, 80, true]);
    // Below 75%, every level can come again.
    expect([read(740), told, read(800)]).toEqual([false, 0, true]);
  });
});

describe('the quota setting', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test('is a whole number of bytes, 1 MiB at least, or no quota', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('PIWI_STORAGE_QUOTA_BYTES', '53687091200');
    expect(storageQuotaBytes()).toBe(53687091200);
    for (const raw of ['', '50GB', '1.5', '1000', '-5']) {
      vi.stubEnv('PIWI_STORAGE_QUOTA_BYTES', raw);
      expect(storageQuotaBytes(), raw).toBeNull();
    }
  });
});

describe('the running total', () => {
  let db: TempDb;
  let close: () => Promise<void>;
  let projectId: number;

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    const [project] = await db.insert(schema.projects).values({ name: 'storage-quota' }).returning();
    projectId = project!.id;
  });
  afterEach(async () => {
    await close();
  });

  /** What Settings → Storage counts, plus the runs' results. */
  const analysisTotal = async () => {
    const [results] = await db
      .select({ bytes: sql<number>`coalesce(sum(${schema.testRuns.resultsBytes}), 0)` })
      .from(schema.testRuns);
    return (await getStorageAnalysis(db)).totalBytes + Number(results!.bytes);
  };

  test('follows every write and delete of files, trace blobs and trace resources, as Settings → Storage counts them', async () => {
    expect(await storageUsedBytes(db)).toBe(0);

    const [blob] = await db
      .insert(schema.traceBlobs)
      .values({ projectId, hash: 'a'.repeat(64), path: 'project-1/blobs/a.zip', size: 5000, storedSize: 1200 })
      .returning();
    await db
      .insert(schema.traceBlobs)
      .values({ projectId, hash: 'b'.repeat(64), path: 'project-1/blobs/b.zip', size: 300 });
    await db.insert(schema.traceResources).values([
      { projectId, name: 'r1', path: 'project-1/trace-resources/r1', size: 40 },
      { projectId, name: 'r2', path: 'project-1/trace-resources/r2', size: 60 },
    ]);
    const inserted = await db
      .insert(schema.files)
      .values([
        { type: 'screenshot', path: 'project-1/a.png', size: 1000 },
        { type: 'video', path: 'project-1/b.webm', size: null },
        { type: 'trace', path: 'project-1/t.zip', size: 5000, blobId: blob!.id },
      ])
      .returning();
    // 1200 + 300 + 40 + 60 + 1000: a file of a trace blob counts nothing of its own.
    expect(await storageUsedBytes(db)).toBe(2600);
    expect(await storageUsedBytes(db)).toBe(await analysisTotal());

    await db.update(schema.files).set({ size: 2500 }).where(eq(schema.files.id, inserted[0]!.id));
    await db.update(schema.files).set({ size: 700 }).where(eq(schema.files.id, inserted[1]!.id));
    await db.update(schema.traceBlobs).set({ storedSize: 1000 }).where(eq(schema.traceBlobs.id, blob!.id));
    expect(await storageUsedBytes(db)).toBe(4600);
    expect(await storageUsedBytes(db)).toBe(await analysisTotal());

    await db.delete(schema.files);
    await db.delete(schema.traceResources);
    await db.delete(schema.traceBlobs);
    expect(await storageUsedBytes(db)).toBe(0);
  });

  test('follows the results each run counts, as they arrive and as runs are deleted', async () => {
    const run = (resultsBytes?: number) => ({
      projectId,
      status: 'running',
      startTime: new Date(),
      ...(resultsBytes === undefined ? {} : { resultsBytes }),
    });
    const [streamed] = await db.insert(schema.testRuns).values(run()).returning();
    await db.insert(schema.testRuns).values([run(4000), run(600)]);
    expect(await storageUsedBytes(db)).toBe(4600);

    // An events batch adds its size; an update of anything else changes nothing.
    await db
      .update(schema.testRuns)
      .set({ resultsBytes: sql`${schema.testRuns.resultsBytes} + 250` })
      .where(eq(schema.testRuns.id, streamed!.id));
    await db.update(schema.testRuns).set({ passedTests: 3 });
    expect(await storageUsedBytes(db)).toBe(4850);
    expect(await storageUsedBytes(db)).toBe(await analysisTotal());

    await db.delete(schema.testRuns).where(eq(schema.testRuns.id, streamed!.id));
    expect(await storageUsedBytes(db)).toBe(4600);
    await db.delete(schema.testRuns);
    expect(await storageUsedBytes(db)).toBe(0);
  });

  test('is recounted from the tables each night', async () => {
    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/a.png', size: 1000 });
    await db.insert(schema.testRuns).values({ projectId, status: 'passed', startTime: new Date(), resultsBytes: 300 });
    await db.update(schema.storageTotals).set({ bytes: 12345 });
    expect(await storageUsedBytes(db)).toBe(12345);
    expect(await reconcileStorageTotal(db)).toBe(1300);
    expect(await storageUsedBytes(db)).toBe(await analysisTotal());
  });

  test('tells the administrators who can sign in once per level crossed', async () => {
    await db.insert(schema.users).values([
      { username: 'owner', password: 'hash', role: 'administrator', email: 'owner@example.com' },
      { username: 'invited', password: '', role: 'administrator', email: 'invited@example.com' },
      { username: 'member', password: 'hash', role: 'member', email: 'member@example.com' },
    ]);
    const tell = vi.fn(async (_to: string, _used: number, _quota: number, _level: number) => true);
    const quota = 10_000;

    expect(await watchStorageQuota(db, tell, null)).toBeNull();
    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/a.png', size: 7000 });
    expect(await watchStorageQuota(db, tell, quota)).toMatchObject({ usedBytes: 7000, told: 0, announced: false });
    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/b.png', size: 1500 });
    expect(await watchStorageQuota(db, tell, quota)).toMatchObject({ told: 80, announced: true });
    expect(await watchStorageQuota(db, tell, quota)).toMatchObject({ told: 80, announced: false });
    expect(tell.mock.calls).toEqual([['owner@example.com', 8500, quota, 80]]);

    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/c.png', size: 1200 });
    expect(await watchStorageQuota(db, tell, quota)).toMatchObject({ told: 95, announced: true });
    expect(tell).toHaveBeenLastCalledWith('owner@example.com', 9700, quota, 95);
  });

  test('records a level only once a message went out, and tries again until one does', async () => {
    await db
      .insert(schema.users)
      .values({ username: 'owner', password: 'hash', role: 'administrator', email: 'o@x.io' });
    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/a.png', size: 9000 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unsent = vi.fn(async () => false);
    expect(await watchStorageQuota(db, unsent, 10_000)).toMatchObject({ told: 0, announced: false });
    const failing = vi.fn(async () => Promise.reject(new Error('SMTP down')));
    expect(await watchStorageQuota(db, failing, 10_000)).toMatchObject({ told: 0, announced: false });
    const sent = vi.fn(async () => true);
    expect(await watchStorageQuota(db, sent, 10_000)).toMatchObject({ told: 80, announced: true });
    expect(sent).toHaveBeenCalledOnce();
  });

  test('keeps its triggers through a second run of their migrations', async () => {
    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/a.png', size: 1000 });
    await db.insert(schema.testRuns).values({ projectId, status: 'passed', startTime: new Date(), resultsBytes: 70 });
    for (const name of ['0198_storage_total_triggers.sql', '0200_storage_total_results.sql']) {
      const migration = readFileSync(
        fileURLToPath(new URL(`../../server/database/migrations/${name}`, import.meta.url)),
        'utf8',
      );
      for (const statement of migration.split('--> statement-breakpoint')) await db.run(sql.raw(statement));
    }
    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/b.png', size: 500 });
    await db.insert(schema.testRuns).values({ projectId, status: 'passed', startTime: new Date(), resultsBytes: 30 });
    expect(await storageUsedBytes(db)).toBe(1600);
  });
});
