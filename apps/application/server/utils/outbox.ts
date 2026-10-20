/**
 * The retry arithmetic and the row claim shared by every outbox sweeper —
 * notifications, auto-heal and integrations. All three snapshot a payload at
 * enqueue, claim a row before attempting it, and on failure bump `attempts`,
 * record the error, and reschedule with progressive backoff until a bounded cap
 * turns the row terminally `failed`.
 *
 * The sweepers keep their own loops (they read different tables and act on
 * different providers); only the "who may attempt this row now" and the "when
 * does the next attempt run, and is this the last one" decisions live here so
 * the three agree.
 */
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { DrizzleDB } from '#shared/handlers/db';

/** Minutes to wait before each retry: the first retry waits 1 minute, the last one 4 hours. */
export const OUTBOX_BACKOFF_MINUTES = [1, 5, 15, 60, 240];

/** After this many attempts (the first one and a retry per backoff step) a failed row is terminal. */
export const OUTBOX_MAX_ATTEMPTS = OUTBOX_BACKOFF_MINUTES.length + 1;

/**
 * The status of a row an attempt has claimed. While a row holds it,
 * `scheduledFor` is the end of the claim's lease: a sweep takes the row over
 * once the lease has run out, so a row whose process died mid-attempt is retried.
 */
export const OUTBOX_PROCESSING = 'processing';

/** The statuses a sweep picks up once `scheduledFor` has passed. */
export const OUTBOX_SWEEPABLE_STATUSES = ['pending', OUTBOX_PROCESSING];

/** How long a claim holds its row — well beyond the longest single attempt. */
export const OUTBOX_LEASE_MS = 10 * 60_000;

/** The columns every outbox table shares. */
type OutboxTable = SQLiteTable & { id: SQLiteColumn; status: SQLiteColumn; scheduledFor: SQLiteColumn };

/**
 * Claim rows for one attempt with a single conditional UPDATE, so two sweeps (or
 * a sweep and a click) never both act on a row. A sweep claims the rows that are
 * due: `pending` ones, and `processing` ones whose lease has run out.
 * `anySchedule` claims a `pending` row whatever its schedule (the click path).
 * Returns the ids this caller now holds.
 */
export async function claimOutboxRows(
  db: Pick<DrizzleDB, 'update'>,
  table: OutboxTable,
  ids: number[],
  { anySchedule = false }: { anySchedule?: boolean } = {},
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const now = new Date();
  const claimable = anySchedule
    ? eq(table.status, 'pending')
    : and(inArray(table.status, OUTBOX_SWEEPABLE_STATUSES), lte(table.scheduledFor, now));
  // RETURNING reports the claimed rows the same way on libSQL and PostgreSQL.
  const claimed = await db
    .update(table)
    .set({ status: OUTBOX_PROCESSING, scheduledFor: new Date(now.getTime() + OUTBOX_LEASE_MS) })
    .where(and(inArray(table.id, ids), claimable))
    .returning({ id: table.id });
  return new Set(claimed.map((row) => row.id as number));
}

export interface NextAttempt {
  /** `failed` once the attempt cap is reached, else `pending` for another try. */
  status: 'pending' | 'failed';
  /** When the retry is due — the row's current value when terminal. */
  scheduledFor: Date | null;
}

/**
 * Decide a failed row's next state from its just-incremented attempt count.
 *
 * `attempts` is the count *after* this failure. When a provider hands back an
 * explicit wait (Jira's `429 Retry-After`), pass it as `retryAfterMs` and it
 * wins over the progressive backoff; otherwise the backoff table applies.
 */
export function nextAttempt(
  attempts: number,
  now: Date,
  currentScheduledFor: Date | null,
  retryAfterMs?: number | null,
): NextAttempt {
  if (attempts >= OUTBOX_MAX_ATTEMPTS) return { status: 'failed', scheduledFor: currentScheduledFor };
  const backoffMs =
    retryAfterMs != null && retryAfterMs > 0
      ? retryAfterMs
      : OUTBOX_BACKOFF_MINUTES[Math.min(attempts, OUTBOX_BACKOFF_MINUTES.length) - 1]! * 60 * 1000;
  return { status: 'pending', scheduledFor: new Date(now.getTime() + backoffMs) };
}
