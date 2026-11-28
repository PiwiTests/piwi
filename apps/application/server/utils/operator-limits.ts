import type { DrizzleDB } from '#shared/handlers/db';
import {
  READ_ONLY_MESSAGE,
  heldOperatorLimits,
  holdOperatorLimits,
  instanceLimitsOf,
  processEnv,
  readOnlySetting,
  readStoredOperatorLimits,
  type InstanceLimits,
  type StoredOperatorLimits,
} from '#shared/operator-limits';
import { sql, type SQL } from 'drizzle-orm';
import { getDatabase, getDialect } from '../database';
import { appSettings } from '../database/schema';
import { apiError } from './api-error';
import { getAppSetting, setAppSetting } from './app-settings';

/**
 * The limits the operator sets through `/api/operator/limits`, kept in `app_settings` under one key and held in memory
 * (`holdOperatorLimits`), where every reader of a limit finds them with no query of its own. The held value is read
 * again from the database once it is `OPERATOR_LIMITS_TTL_MS` old, on the next request or task that asks, so a second
 * process follows a change within that time; a write holds the new value at once.
 */

/** The `app_settings` key the operator's limits are kept under. */
const LIMITS_KEY = 'operator_limits';

/** How long the held limits are taken as current before they are read again. */
export const OPERATOR_LIMITS_TTL_MS = 10_000;

let readAt = 0;
let reading: Promise<StoredOperatorLimits> | null = null;
/** Counts this process's writes: a read that started before one does not hold what it read. */
let writes = 0;
let warnedUnreadable = false;

/**
 * The operator's limits: the held ones while they are fresh, else read from the database and held. `fresh` reads
 * them whatever their age. A read that fails keeps the held ones, said once in the log, and is tried again once the
 * TTL passes.
 */
export async function loadOperatorLimits(
  options: { db?: DrizzleDB; fresh?: boolean } = {},
): Promise<StoredOperatorLimits> {
  if (!options.fresh && readAt > 0 && Date.now() - readAt < OPERATOR_LIMITS_TTL_MS) return heldOperatorLimits();
  reading ??= (async () => {
    const writesBefore = writes;
    try {
      const db = options.db ?? (await getDatabase());
      const stored = readStoredOperatorLimits(await getAppSetting<unknown>(db, LIMITS_KEY));
      if (writes === writesBefore) holdOperatorLimits(stored);
    } catch (error) {
      if (!warnedUnreadable) {
        warnedUnreadable = true;
        console.error('[operator] The operator limits could not be read: the held ones apply.', error);
      }
    } finally {
      readAt = Date.now();
      reading = null;
    }
    return heldOperatorLimits();
  })();
  return reading;
}

/** Holds limits this process just stored, ahead of any read that started before. */
function holdWritten(limits: StoredOperatorLimits): void {
  writes++;
  holdOperatorLimits(limits);
  readAt = Date.now();
}

/** Stores the operator's limits and holds them at once. */
export async function writeOperatorLimits(db: DrizzleDB, limits: StoredOperatorLimits): Promise<void> {
  await setAppSetting(db, LIMITS_KEY, limits);
  holdWritten(limits);
}

/**
 * Reads the stored limits, applies `change` and stores the result in one transaction, then holds it. On PostgreSQL the
 * row is locked before it is read, so changes made at once apply one after the other and each keeps the fields the
 * others set; on SQLite the transaction holds the write lock from its start. Answers the limits stored.
 */
export async function updateOperatorLimits(
  db: DrizzleDB,
  change: (stored: StoredOperatorLimits) => StoredOperatorLimits,
): Promise<StoredOperatorLimits> {
  const next = await db.transaction(async (tx) => {
    const client = tx as unknown as DrizzleDB;
    if (getDialect() === 'postgres') {
      await client
        .insert(appSettings)
        .values({ key: LIMITS_KEY, value: {}, updatedAt: new Date() })
        .onConflictDoNothing();
      // The client is typed as SQLite's; on PostgreSQL its transaction runs raw SQL with `execute`.
      await (tx as unknown as { execute(query: SQL): Promise<unknown> }).execute(
        sql`SELECT ${appSettings.key} FROM ${appSettings} WHERE ${appSettings.key} = ${LIMITS_KEY} FOR UPDATE`,
      );
    }
    const limits = change(readStoredOperatorLimits(await getAppSetting<unknown>(client, LIMITS_KEY)));
    await setAppSetting(client, LIMITS_KEY, limits);
    return limits;
  });
  holdWritten(next);
  return next;
}

/** Every limit as it applies now, from the held operator's limits and the environment. */
export function instanceLimits(now = new Date()): InstanceLimits {
  return instanceLimitsOf(heldOperatorLimits(), processEnv(), now);
}

/** Whether the instance is read-only, by the held operator's limits. */
export function isReadOnly(): boolean {
  return readOnlySetting(heldOperatorLimits()).value;
}

/** Whether the instance is read-only, by the limits read from the database now: what a scheduled task asks. */
export async function readOnlyNow(db?: DrizzleDB): Promise<boolean> {
  await loadOperatorLimits({ db, fresh: true });
  return isReadOnly();
}

/** The 409 of a write while the instance is read-only. */
export function readOnlyError() {
  return apiError({ statusCode: 409, errorCode: 'READ_ONLY', message: READ_ONLY_MESSAGE });
}

/** Refuses a request (409 `READ_ONLY`) while the instance is read-only. */
export function refuseWhileReadOnly(): void {
  if (isReadOnly()) throw readOnlyError();
}

/** Forgets the held limits and when they were read: the next reader reads them again. For the tests. */
export function resetOperatorLimits(): void {
  holdOperatorLimits({});
  readAt = 0;
  reading = null;
}
