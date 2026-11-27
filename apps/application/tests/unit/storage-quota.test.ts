/**
 * The storage quota: the running total the database's triggers keep (counted as Settings → Storage counts, so the two
 * always agree, plus the results each run's reporter sent), its nightly recount, the levels administrators are warned
 * at, and the watch that tells them once per level crossed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import {
  nextStorageOver,
  nextStorageWarning,
  readStorageOver,
  storageQuotaStateOf,
  storageWarningLevel,
} from '#shared/storage-quota';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const { reconcileStorageTotal, storageQuotaBytes, storageQuotaState, storageUsedBytes, watchStorageQuota } =
  await import('../../server/utils/storage-quota');
const { getStorageAnalysis } = await import('#shared/handlers/admin-storage');
const { renderStorageWarningEmail } = await import('../../server/utils/email');

describe('the warning levels', () => {
  test('are 80% and 95% of the quota, the quota and, once over it, the ceiling', () => {
    expect(storageWarningLevel(799, 1000)).toBe(0);
    expect(storageWarningLevel(800, 1000)).toBe(80);
    expect(storageWarningLevel(949, 1000)).toBe(80);
    expect(storageWarningLevel(950, 1000)).toBe(95);
    expect(storageWarningLevel(999, 1000)).toBe(95);
    expect(storageWarningLevel(1000, 1000)).toBe(100);
    expect(storageWarningLevel(1500, 1000)).toBe(100);
    expect(storageWarningLevel(1119, 1000, 1120)).toBe(100);
    expect(storageWarningLevel(1120, 1000, 1120)).toBe('ceiling');
  });

  test('warn once as files stop being kept and once as new runs are refused, then re-arm as the usage falls', () => {
    let told: ReturnType<typeof storageWarningLevel> = 95;
    const read = (used: number, ceiling: number | null) => {
      const next = nextStorageWarning(told, used, 1000, ceiling);
      told = next.told;
      return next.announce;
    };
    expect([read(1010, 1110), told, read(1050, 1110)]).toEqual([true, 100, false]);
    expect([read(1110, 1110), told, read(1200, 1110)]).toEqual([true, 'ceiling', false]);
    // Within 5 points of the ceiling, nothing new; further down, the quota's level holds until 95%.
    expect([read(1070, 1110), told]).toEqual([false, 'ceiling']);
    expect([read(1040, 1110), told]).toEqual([false, 100]);
    expect([read(960, null), told]).toEqual([false, 100]);
    expect([read(940, null), told, read(1000, 1100)]).toEqual([false, 95, true]);
  });

  test('re-arm one level at a time, so a dip just below the quota past its ceiling warns of nothing again', () => {
    let told: ReturnType<typeof storageWarningLevel> = 'ceiling';
    const read = (used: number, ceiling: number | null) => {
      const next = nextStorageWarning(told, used, 1000, ceiling);
      told = next.told;
      return next.announce;
    };
    // Below the quota there is no ceiling: 99% is within 5 points of the quota, whose level holds.
    expect([read(990, null), told, read(1000, 1100)]).toEqual([false, 100, false]);
    // 94% is 6 points below the quota and 1 below 95%: the quota warns again, 95% does not.
    expect([read(940, null), told, read(960, null), read(1000, 1100)]).toEqual([false, 95, false, true]);
    expect([read(1000, 1100), read(1100, 1100), told]).toEqual([false, true, 'ceiling']);
    // From the ceiling straight to 70%: every level re-arms.
    expect([read(700, null), told]).toEqual([false, 0]);
  });

  test('warn once per level crossed, and again only after the usage fell 5 points below it', () => {
    let told: ReturnType<typeof storageWarningLevel> = 0;
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

describe('the warning email', () => {
  const state = (usedBytes: number, ceilingBytes: number | null) => ({
    quotaBytes: 1024 ** 3,
    usedBytes,
    over: ceilingBytes === null ? null : { since: '2026-11-27T10:00:00.000Z', ceilingBytes },
    filesRefused: ceilingBytes !== null,
    runsRefused: ceilingBytes !== null && usedBytes >= ceilingBytes,
  });

  test('says what the quota refuses from the level it reached on', () => {
    const atNinetyFive = renderStorageWarningEmail(state(0.96 * 1024 ** 3, null), 95).text;
    expect(atNinetyFive).toMatch(/^Storage is at 95% of its quota\n/);
    expect(atNinetyFive).not.toContain('refused');

    const atQuota = renderStorageWarningEmail(state(1024 ** 3, 1.1 * 1024 ** 3), 100).text;
    expect(atQuota).toMatch(/^Storage reached its quota: files are not kept\n/);
    expect(atQuota).toContain('no longer keeps their files');
    expect(atQuota).toContain('Once the stored bytes reach 1.10 GB, new runs are refused too.');

    const pastCeiling = renderStorageWarningEmail(state(1.2 * 1024 ** 3, 1.1 * 1024 ** 3), 'ceiling');
    expect(pastCeiling.text).toMatch(/^Storage is past its quota: new runs are refused\n/);
    expect(pastCeiling.text).toContain('New runs are refused until space is freed.');
    expect(pastCeiling.html).toContain('/settings/storage');
  });
});

describe('what the quota refuses', () => {
  const at = new Date('2026-11-27T10:00:00Z');

  test('files from the quota on, new runs from the ceiling: the bytes on going over plus 10% of the quota', () => {
    expect(storageQuotaStateOf(1000, 999, null)).toEqual({
      quotaBytes: 1000,
      usedBytes: 999,
      over: null,
      filesRefused: false,
      runsRefused: false,
    });
    const over = nextStorageOver(null, 1030, 1000, at)!;
    expect(over).toEqual({ since: at.toISOString(), usedBytes: 1030, quotaBytes: 1000 });
    expect(storageQuotaStateOf(1000, 1030, over)).toMatchObject({
      over: { since: at.toISOString(), ceilingBytes: 1130 },
      filesRefused: true,
      runsRefused: false,
    });
    expect(storageQuotaStateOf(1000, 1129, over).runsRefused).toBe(false);
    expect(storageQuotaStateOf(1000, 1130, over).runsRefused).toBe(true);
  });

  test('keeps the bytes of the first going over until the usage falls below the quota, then starts again', () => {
    const first = nextStorageOver(null, 1000, 1000, at);
    expect(nextStorageOver(first, 1100, 1000, new Date())).toBe(first);
    expect(nextStorageOver(first, 999, 1000, new Date())).toBeNull();
    expect(nextStorageOver(null, 1050, 1000, at)).toEqual({
      since: at.toISOString(),
      usedBytes: 1050,
      quotaBytes: 1000,
    });
    // Over another quota: a new record from the bytes stored now.
    expect(nextStorageOver(first, 1100, 1050, at)).toEqual({
      since: at.toISOString(),
      usedBytes: 1100,
      quotaBytes: 1050,
    });
  });

  test('reads only a well-formed going-over record', () => {
    const since = at.toISOString();
    expect(readStorageOver({ since, usedBytes: 5, quotaBytes: 4 })).toEqual({ since, usedBytes: 5, quotaBytes: 4 });
    for (const value of [
      null,
      'x',
      [],
      { since: 'never', usedBytes: 5, quotaBytes: 4 },
      { since, usedBytes: -1, quotaBytes: 4 },
      { since, usedBytes: 5 },
      { since, usedBytes: 5, quotaBytes: 0 },
    ]) {
      expect(readStorageOver(value)).toBeNull();
    }
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

  const setTotal = (bytes: number) => db.update(schema.storageTotals).set({ bytes });
  const overSetting = async () =>
    (await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'storage_quota_over')))[0];
  const over = async () => (await overSetting())?.value;

  test('has a trigger for each write of every table it counts, after the latest migration', async () => {
    const triggers = await db.all<{ name: string; table: string }>(
      sql`SELECT name, tbl_name AS "table" FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'storage_totals_%' ORDER BY name`,
    );
    expect(triggers).toEqual(
      ['files', 'test_runs', 'trace_blobs', 'trace_resources'].flatMap((table) =>
        ['delete', 'insert', 'update'].map((write) => ({ name: `storage_totals_${table}_${write}`, table })),
      ),
    );
  });

  test('keeps when it went over its quota, from the first check that finds it there to the first below', async () => {
    const first = new Date('2026-11-27T10:00:00Z');

    expect(await storageQuotaState(db, null)).toBeNull();
    await setTotal(9000);
    expect(await storageQuotaState(db, 10_000, first)).toMatchObject({ over: null, filesRefused: false });
    expect(await over()).toBeUndefined();

    await setTotal(10_500);
    expect(await storageQuotaState(db, 10_000, first)).toMatchObject({
      usedBytes: 10_500,
      over: { since: first.toISOString(), ceilingBytes: 11_500 },
      filesRefused: true,
      runsRefused: false,
    });
    await setTotal(11_600);
    expect(await storageQuotaState(db, 10_000, new Date())).toMatchObject({
      over: { since: first.toISOString(), ceilingBytes: 11_500 },
      runsRefused: true,
    });
    expect(await over()).toEqual({ since: first.toISOString(), usedBytes: 10_500, quotaBytes: 10_000 });

    await setTotal(9900);
    expect(await storageQuotaState(db, 10_000)).toMatchObject({ over: null, filesRefused: false, runsRefused: false });
    expect(await over()).toBeUndefined();
    // Over again: the ceiling counts from the bytes stored now.
    await setTotal(11_000);
    expect((await storageQuotaState(db, 10_000))?.over?.ceilingBytes).toBe(12_000);
  });

  test('starts its record of going over again once the quota changes, its ceiling always above the quota', async () => {
    const first = new Date('2026-11-27T10:00:00Z');
    const later = new Date('2026-11-28T10:00:00Z');
    await setTotal(10_500);
    expect((await storageQuotaState(db, 10_000, first))?.over?.ceilingBytes).toBe(11_500);

    // Raised while over: the record starts again from the bytes stored now, and new runs are taken.
    await setTotal(20_000);
    expect(await storageQuotaState(db, 20_000, later)).toMatchObject({
      over: { since: later.toISOString(), ceilingBytes: 22_000 },
      filesRefused: true,
      runsRefused: false,
    });
    expect(await over()).toEqual({ since: later.toISOString(), usedBytes: 20_000, quotaBytes: 20_000 });

    // Raised above the usage: nothing is refused, and the record goes.
    expect(await storageQuotaState(db, 30_000)).toMatchObject({ over: null, filesRefused: false });
    expect(await over()).toBeUndefined();
  });

  test('writes its record of going over only when it changes, never on a read that finds the same', async () => {
    await setTotal(9000);
    await storageQuotaState(db, 10_000);
    expect(await overSetting()).toBeUndefined();

    await setTotal(10_500);
    await storageQuotaState(db, 10_000);
    const stale = new Date('2026-01-01T00:00:00Z');
    await db
      .update(schema.appSettings)
      .set({ updatedAt: stale })
      .where(eq(schema.appSettings.key, 'storage_quota_over'));
    await setTotal(11_000);
    for (let read = 0; read < 3; read++) await storageQuotaState(db, 10_000);
    expect(await overSetting()).toMatchObject({ updatedAt: stale, value: { usedBytes: 10_500, quotaBytes: 10_000 } });
  });

  test('clears its record of going over from the watch once no quota is set', async () => {
    await setTotal(10_500);
    await storageQuotaState(db, 10_000);
    expect(await over()).toBeDefined();
    const tell = vi.fn(async () => true);
    expect(await watchStorageQuota(db, tell, null)).toBeNull();
    expect(await over()).toBeUndefined();
    expect(await watchStorageQuota(db, tell, null)).toBeNull();
    expect(tell).not.toHaveBeenCalled();
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
    const told: Array<[string, number, string | number]> = [];
    const tell = vi.fn(async (to: string, state: { usedBytes: number }, level: string | number) => {
      told.push([to, state.usedBytes, level]);
      return true;
    });
    const quota = 10_000;

    expect(await watchStorageQuota(db, tell, null)).toBeNull();
    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/a.png', size: 7000 });
    expect(await watchStorageQuota(db, tell, quota)).toMatchObject({ usedBytes: 7000, told: 0, announced: false });
    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/b.png', size: 1500 });
    expect(await watchStorageQuota(db, tell, quota)).toMatchObject({ told: 80, announced: true });
    expect(await watchStorageQuota(db, tell, quota)).toMatchObject({ told: 80, announced: false });
    expect(told).toEqual([['owner@example.com', 8500, 80]]);

    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/c.png', size: 1200 });
    expect(await watchStorageQuota(db, tell, quota)).toMatchObject({ told: 95, announced: true });
    expect(told.at(-1)).toEqual(['owner@example.com', 9700, 95]);
  });

  test('tells them once files stop being kept and once new runs are refused, keeping when it went over', async () => {
    await db
      .insert(schema.users)
      .values({ username: 'owner', password: 'hash', role: 'administrator', email: 'o@x.io' });
    const levels: Array<string | number> = [];
    const tell = vi.fn(async (_to: string, _state: unknown, level: string | number) => {
      levels.push(level);
      return true;
    });
    const watch = () => watchStorageQuota(db, tell, 10_000);

    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/a.png', size: 10_200 });
    expect(await watch()).toMatchObject({
      told: 100,
      announced: true,
      state: { filesRefused: true, runsRefused: false, over: { ceilingBytes: 11_200 } },
    });
    expect(await watch()).toMatchObject({ told: 100, announced: false });
    // Results still come in, up to the ceiling: the bytes when it went over, plus 10% of the quota.
    await db.insert(schema.testRuns).values({ projectId, status: 'passed', startTime: new Date(), resultsBytes: 1000 });
    expect(await watch()).toMatchObject({ told: 'ceiling', announced: true, state: { runsRefused: true } });
    expect(levels).toEqual([100, 'ceiling']);

    // Space freed below the quota: the record of going over goes, and the next crossings warn again.
    await db.delete(schema.testRuns);
    await db.delete(schema.files);
    expect(await watch()).toMatchObject({ told: 0, state: { over: null, filesRefused: false } });
    expect(await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'storage_quota_over'))).toEqual(
      [],
    );
    await db.insert(schema.files).values({ type: 'screenshot', path: 'project-1/b.png', size: 10_500 });
    expect(await watch()).toMatchObject({ told: 100, announced: true, state: { over: { ceilingBytes: 11_500 } } });
    expect(levels).toEqual([100, 'ceiling', 100]);
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
