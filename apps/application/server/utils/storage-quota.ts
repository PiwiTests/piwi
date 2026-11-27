import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDB } from '#shared/handlers/db';
import { nextStorageWarning, type StorageWarningLevel } from '#shared/storage-quota';
import { getDialect } from '../database';
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

/** The rows the triggers write to: one on SQLite, 16 on PostgreSQL, where a session writes to `pid % 16`. */
const SLOTS = getDialect() === 'postgres' ? 16 : 1;

/**
 * Recounts the total from the tables: slot 0 takes the count and every other slot 0, so what the triggers missed (a
 * row written while they did not exist, a restore) is put right, and a missing slot is made again. On PostgreSQL the
 * table is locked first, which waits for the writes in flight to end and holds the next ones until the count is
 * written, so none of them is lost. Answers the total.
 */
export async function reconcileStorageTotal(db: DrizzleDB): Promise<number> {
  await db
    .insert(storageTotals)
    .values(Array.from({ length: SLOTS }, (_, slot) => ({ slot, bytes: 0 })))
    .onConflictDoNothing();
  await db.transaction(async (tx) => {
    if (getDialect() === 'postgres') {
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
