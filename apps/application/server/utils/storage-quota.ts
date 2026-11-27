import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDB } from '#shared/handlers/db';
import {
  FILES_REFUSED_MESSAGE,
  RUNS_REFUSED_MESSAGE,
  nextStorageOver,
  nextStorageWarning,
  readStorageOver,
  storageQuotaStateOf,
  type StorageQuotaState,
  type StorageWarningLevel,
} from '#shared/storage-quota';
import { getDialect } from '../database';
import { files, storageTotals, testRuns, traceBlobs, traceResources } from '../database/schema';
import { administratorEmails } from './administrators';
import { apiError } from './api-error';
import { deleteAppSetting, getAppSetting, setAppSetting } from './app-settings';

/**
 * The stored bytes against `PIWI_STORAGE_QUOTA_BYTES`. The total is the `storage_totals` rows, which the database's
 * triggers keep as files, trace blobs and trace resources are written and deleted (counted as Settings → Storage
 * counts them), and as runs' results arrive and runs are deleted (`test_runs.results_bytes`), and
 * `reconcileStorageTotal` recounts each night. `watchStorageQuota` tells the administrators, by email, each time the
 * usage crosses 80% or 95% of the quota.
 */

/** The `app_settings` key of the level the administrators were last told of. */
const TOLD_KEY = 'storage_quota_warning';

/** The `app_settings` key of when the instance went over its quota, and the bytes it stored then (`StorageOver`). */
const OVER_KEY = 'storage_quota_over';

let warnedUnusable = false;

/** The quota in bytes, or null while it is unset or not a whole number of at least 1 MiB (said once in the log). */
export function storageQuotaBytes(): number | null {
  const raw = process.env.PIWI_STORAGE_QUOTA_BYTES?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value >= 1024 * 1024) return value;
  if (!warnedUnusable) {
    warnedUnusable = true;
    console.warn('[storage] PIWI_STORAGE_QUOTA_BYTES is not a whole number of bytes, 1 MiB at least: no quota is set.');
  }
  return null;
}

/** The bytes Settings → Storage counts, and the runs' results, as the triggers keep them. */
export async function storageUsedBytes(db: DrizzleDB): Promise<number> {
  const [row] = await db.select({ bytes: sql<number>`coalesce(sum(${storageTotals.bytes}), 0)` }).from(storageTotals);
  return Number(row?.bytes ?? 0);
}

/** The bytes counted from the tables themselves: the same rule as the triggers, Settings → Storage's and the results. */
const COUNTED_BYTES = sql`(SELECT coalesce(sum(CASE WHEN ${files.blobId} IS NULL THEN coalesce(${files.size}, 0) ELSE 0 END), 0) FROM ${files})
  + (SELECT coalesce(sum(coalesce(${traceBlobs.storedSize}, ${traceBlobs.size})), 0) FROM ${traceBlobs})
  + (SELECT coalesce(sum(${traceResources.size}), 0) FROM ${traceResources})
  + (SELECT coalesce(sum(${testRuns.resultsBytes}), 0) FROM ${testRuns})`;

/**
 * Recounts the total from the tables: slot 0 takes the count and every other slot 0, so what the triggers missed (a
 * row written while they did not exist, a restore) is put right, and a missing slot is made again. On PostgreSQL the
 * table is locked first, which waits for the writes in flight to end and holds the next ones until the count is
 * written, so none of them is lost. Answers the total.
 */
export async function reconcileStorageTotal(db: DrizzleDB): Promise<number> {
  const postgres = getDialect() === 'postgres';
  // The rows the triggers write to: one on SQLite, 16 on PostgreSQL, where a session writes to `pid % 16`.
  const slots = postgres ? 16 : 1;
  await db
    .insert(storageTotals)
    .values(Array.from({ length: slots }, (_, slot) => ({ slot, bytes: 0 })))
    .onConflictDoNothing();
  await db.transaction(async (tx) => {
    if (postgres) {
      // The client is typed as SQLite's; on PostgreSQL its transaction runs raw SQL with `execute`.
      await (tx as unknown as { execute(query: SQL): Promise<unknown> }).execute(
        sql`LOCK TABLE ${storageTotals} IN EXCLUSIVE MODE`,
      );
    }
    // A statement of its own, after the lock: it counts what the writes it waited for committed.
    await tx
      .update(storageTotals)
      .set({ bytes: sql`CASE WHEN ${storageTotals.slot} = 0 THEN (${COUNTED_BYTES}) ELSE 0 END` });
  });
  return storageUsedBytes(db);
}

/**
 * Compares the total with the quota and, when it crosses a level the administrators were not told of, tells each by
 * `tell`, which answers whether the message went out. The level counts as told once one did: until then, without SMTP
 * or with every message refused, each later watch tries again. Answers what it found, or null without a quota.
 */
export async function watchStorageQuota(
  db: DrizzleDB,
  tell: (to: string, usedBytes: number, quotaBytes: number, level: StorageWarningLevel) => Promise<boolean>,
  quotaBytes: number | null = storageQuotaBytes(),
): Promise<{ usedBytes: number; told: StorageWarningLevel; announced: boolean } | null> {
  if (!quotaBytes) return null;
  const usedBytes = await storageUsedBytes(db);
  const before = (await getAppSetting<{ told: StorageWarningLevel }>(db, TOLD_KEY))?.told ?? 0;
  const next = nextStorageWarning(before, usedBytes, quotaBytes);
  let announced = false;
  if (next.announce) {
    const results = await Promise.allSettled(
      (await administratorEmails(db)).map((to) => tell(to, usedBytes, quotaBytes, next.told)),
    );
    announced = results.some((result) => result.status === 'fulfilled' && result.value);
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed) console.error(`[storage] ${failed} administrator(s) could not be told the storage is at ${next.told}%`);
  }
  const told = next.announce && !announced ? before : next.told;
  if (told !== before) await setAppSetting(db, TOLD_KEY, { told });
  return { usedBytes, told, announced };
}

/**
 * The quota against the stored bytes, and what it refuses, keeping `storage_quota_over` current: set by the first
 * check that finds the bytes at the quota, cleared by the first that finds them below. Null without a quota, which
 * reads nothing.
 */
export async function storageQuotaState(
  db: DrizzleDB,
  quotaBytes: number | null = storageQuotaBytes(),
  now = new Date(),
): Promise<StorageQuotaState | null> {
  if (!quotaBytes) return null;
  const usedBytes = await storageUsedBytes(db);
  const stored = readStorageOver(await getAppSetting(db, OVER_KEY));
  const over = nextStorageOver(stored, usedBytes, quotaBytes, now);
  if (over && over !== stored) await setAppSetting(db, OVER_KEY, over);
  else if (!over && stored) await deleteAppSetting(db, OVER_KEY);
  return storageQuotaStateOf(quotaBytes, usedBytes, over);
}

/** The 409 of a request whose files the quota refuses: it stores nothing of them. */
export function filesRefusedError() {
  return apiError({ statusCode: 409, errorCode: 'STORAGE_QUOTA_FILES_REFUSED', message: FILES_REFUSED_MESSAGE });
}

/** The 409 of a request that would create a run past the ceiling. */
export function runsRefusedError() {
  return apiError({ statusCode: 409, errorCode: 'STORAGE_QUOTA_EXCEEDED', message: RUNS_REFUSED_MESSAGE });
}

/** Refuses a request that brings files (409 `STORAGE_QUOTA_FILES_REFUSED`) while the quota is reached. */
export async function refuseFilesAtQuota(db: DrizzleDB): Promise<void> {
  if ((await storageQuotaState(db))?.filesRefused) throw filesRefusedError();
}

/** Refuses a request that creates a run (409 `STORAGE_QUOTA_EXCEEDED`) past the ceiling. */
export async function refuseRunsPastCeiling(db: DrizzleDB): Promise<void> {
  if ((await storageQuotaState(db))?.runsRefused) throw runsRefusedError();
}

/**
 * Refuses an import, which creates a run with its files: past the ceiling as a run (`STORAGE_QUOTA_EXCEEDED`), at
 * the quota for its files (`STORAGE_QUOTA_FILES_REFUSED`).
 */
export async function refuseImportAtQuota(db: DrizzleDB): Promise<void> {
  const state = await storageQuotaState(db);
  if (state?.runsRefused) throw runsRefusedError();
  if (state?.filesRefused) throw filesRefusedError();
}
