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
import { getDatabase } from '../database';
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

/** Stores the operator's limits and holds them at once. */
export async function writeOperatorLimits(db: DrizzleDB, limits: StoredOperatorLimits): Promise<void> {
  await setAppSetting(db, LIMITS_KEY, limits);
  writes++;
  holdOperatorLimits(limits);
  readAt = Date.now();
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
