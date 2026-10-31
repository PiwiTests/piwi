import { and, eq } from 'drizzle-orm';
import { appSettings } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';

export async function getAppSetting<T>(db: DrizzleDB, key: string): Promise<T | null> {
  const rows = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key));
  if (!rows[0]) return null;
  return rows[0].value as T;
}

export async function setAppSetting(db: DrizzleDB, key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

export async function deleteAppSetting(db: DrizzleDB, key: string): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, key));
}

/** A claim older than this belongs to a process that stopped before finishing; another may take it over. */
const STALE_CLAIM_MS = 60 * 60 * 1000;

/**
 * Claim a once-per-instance job for this process: the first to write the setting
 * runs it, and a process finding a fresh claim or a finished job skips it. A claim
 * left by a process that stopped is taken over once it is stale.
 */
async function claimOnce(db: DrizzleDB, key: string): Promise<boolean> {
  const claim = { state: 'running', at: new Date().toISOString() };
  const inserted = await db
    .insert(appSettings)
    .values({ key, value: claim, updatedAt: new Date() })
    .onConflictDoNothing()
    .returning({ key: appSettings.key });
  if (inserted.length > 0) return true;
  const [row] = await db
    .select({ value: appSettings.value, updatedAt: appSettings.updatedAt })
    .from(appSettings)
    .where(eq(appSettings.key, key));
  const value = row?.value as { state?: unknown } | string | null | undefined;
  if (typeof value !== 'object' || value?.state !== 'running') return false;
  if (Date.now() - new Date(row!.updatedAt).getTime() < STALE_CLAIM_MS) return false;
  // Take the stale claim over; the write is conditional, so of two processes doing so at once one alone wins.
  await db
    .update(appSettings)
    .set({ value: claim, updatedAt: new Date() })
    .where(and(eq(appSettings.key, key), eq(appSettings.updatedAt, row!.updatedAt)));
  const [after] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key));
  return (after?.value as { at?: unknown } | null)?.at === claim.at;
}

/**
 * Run a job once per instance, claimed and recorded under the setting `key`: null
 * when another process has it or it is done. A failure releases the claim, so the
 * next start tries again.
 */
export async function runOnce<T>(db: DrizzleDB, key: string, job: () => Promise<T>): Promise<T | null> {
  if (!(await claimOnce(db, key))) return null;
  let result: T;
  try {
    result = await job();
  } catch (err) {
    await deleteAppSetting(db, key).catch(() => {});
    throw err;
  }
  await setAppSetting(db, key, { state: 'done', at: new Date().toISOString() });
  return result;
}
