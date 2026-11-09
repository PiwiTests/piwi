/**
 * The pass rate of `pass-rate.ts` in a query, on SQLite and PostgreSQL alike:
 * passed results over the results that passed or failed, a timed-out result
 * counting as failed, and NULL with neither. The counts read one row per result.
 */
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { FAILED_STATUS_KEYS } from './test-counts';

/** The failed statuses as SQL literals: `failed` and both spellings of timed out. */
const FAILED_STATUSES = sql.raw(FAILED_STATUS_KEYS.map((status) => `'${status}'`).join(', '));

/** Whether a result's status is a failure, timed out included. */
export function failedStatusSql(status: SQLWrapper): SQL<boolean> {
  return sql<boolean>`${status} IN (${FAILED_STATUSES})`;
}

/** How many of the rows passed. */
export function passedCountSql(status: SQLWrapper): SQL<number> {
  return sql<number>`SUM(CASE WHEN ${status} = 'passed' THEN 1 ELSE 0 END)`;
}

/** How many of the rows failed or timed out. */
export function failedCountSql(status: SQLWrapper): SQL<number> {
  return sql<number>`SUM(CASE WHEN ${failedStatusSql(status)} THEN 1 ELSE 0 END)`;
}

/** The pass rate of two counts as a share from 0 to 1, NULL when both are 0. */
export function passRateSql(passed: SQLWrapper, failed: SQLWrapper): SQL<number | null> {
  return sql<number | null>`CASE WHEN (${passed} + ${failed}) > 0 THEN (${passed} * 1.0) / (${passed} + ${failed}) END`;
}
