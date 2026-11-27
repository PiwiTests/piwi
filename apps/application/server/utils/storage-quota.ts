import { sql } from 'drizzle-orm';
import type { DrizzleDB } from '#shared/handlers/db';
import { nextStorageWarning, type StorageWarningLevel } from '#shared/storage-quota';
import { files, storageTotals, traceBlobs, traceResources } from '../database/schema';
import { administratorEmails } from './administrators';
import { getAppSetting, setAppSetting } from './app-settings';

/**
 * The stored bytes against `PIWI_STORAGE_QUOTA_BYTES`. The total is the `storage_totals` rows, which the database's
 * triggers keep as files, trace blobs and trace resources are written and deleted (counted as Settings → Storage
 * counts them), and `reconcileStorageTotal` recounts each night. `watchStorageQuota` tells the administrators, by
 * email, each time the usage crosses 80% or 95% of the quota.
 */

/** The `app_settings` key of the level the administrators were last told of. */
const TOLD_KEY = 'storage_quota_warning';

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

/** The bytes Settings → Storage counts, as the triggers keep them. */
export async function storageUsedBytes(db: DrizzleDB): Promise<number> {
  const [row] = await db.select({ bytes: sql<number>`coalesce(sum(${storageTotals.bytes}), 0)` }).from(storageTotals);
  return Number(row?.bytes ?? 0);
}

/** The bytes counted from the tables themselves: the same rule as the triggers and Settings → Storage. */
const COUNTED_BYTES = sql`(SELECT coalesce(sum(CASE WHEN ${files.blobId} IS NULL THEN coalesce(${files.size}, 0) ELSE 0 END), 0) FROM ${files})
  + (SELECT coalesce(sum(coalesce(${traceBlobs.storedSize}, ${traceBlobs.size})), 0) FROM ${traceBlobs})
  + (SELECT coalesce(sum(${traceResources.size}), 0) FROM ${traceResources})`;

/**
 * Recounts the total from the tables, in one statement: slot 0 takes the count and every other slot 0, so what the
 * triggers missed (a row written while the triggers did not exist, a restore) is put right. Answers the total.
 */
export async function reconcileStorageTotal(db: DrizzleDB): Promise<number> {
  await db.insert(storageTotals).values({ slot: 0, bytes: 0 }).onConflictDoNothing();
  await db
    .update(storageTotals)
    .set({ bytes: sql`CASE WHEN ${storageTotals.slot} = 0 THEN (${COUNTED_BYTES}) ELSE 0 END` });
  return storageUsedBytes(db);
}

/**
 * Compares the total with the quota and, when it crosses a level the administrators were not told of, tells each by
 * `tell`; a message that fails is logged, and the level counts as told. Answers what it found, or null without a quota.
 */
export async function watchStorageQuota(
  db: DrizzleDB,
  tell: (to: string, usedBytes: number, quotaBytes: number, level: StorageWarningLevel) => Promise<void>,
  quotaBytes: number | null = storageQuotaBytes(),
): Promise<{ usedBytes: number; told: StorageWarningLevel; announced: boolean } | null> {
  if (!quotaBytes) return null;
  const usedBytes = await storageUsedBytes(db);
  const before = (await getAppSetting<{ told: StorageWarningLevel }>(db, TOLD_KEY))?.told ?? 0;
  const { told, announce } = nextStorageWarning(before, usedBytes, quotaBytes);
  if (told !== before) await setAppSetting(db, TOLD_KEY, { told });
  if (announce) {
    const results = await Promise.allSettled(
      (await administratorEmails(db)).map((to) => tell(to, usedBytes, quotaBytes, told)),
    );
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed) console.error(`[storage] ${failed} administrator(s) could not be told the storage is at ${told}%`);
  }
  return { usedBytes, told, announced: announce };
}
