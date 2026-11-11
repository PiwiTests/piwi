import type { RunSyncView } from '#shared/handlers/test-management-sync';

/** The waits between reads of a run that ended a moment ago and has no sync yet: it is queued just after the run ends. */
export const SYNC_APPEAR_WAITS_MS = [2_000, 4_000, 8_000, 16_000, 32_000];

/** How long after a run ends its page still looks for a sync that has not appeared. */
export const SYNC_APPEAR_WINDOW_MS = 2 * 60_000;

/** The wait between reads while a sync is being sent or waits for its first attempt. */
export const SYNC_SENDING_WAIT_MS = 5_000;

/** The longest wait before a sync that waits to retry is read again. */
export const SYNC_RETRY_MAX_WAIT_MS = 5 * 60_000;

/** How long after a retry is due the sync is read, so the attempt has had a moment to run. */
const AFTER_RETRY_DUE_MS = 2_000;

/** Whether a sync is waiting to retry an attempt that failed, rather than for its first attempt. */
export function syncRetryPending(sync: Pick<RunSyncView, 'status' | 'attempts' | 'error'>): boolean {
  return sync.status === 'pending' && sync.attempts > 0 && sync.error != null;
}

/**
 * How long the run page waits before it reads the run's sync again, in milliseconds, or null to stop reading. A run
 * that ended less than {@link SYNC_APPEAR_WINDOW_MS} ago and has no sync yet is read again after each of
 * {@link SYNC_APPEAR_WAITS_MS} in turn (`emptyReads` is how many of them were made). A sync being sent, or waiting for
 * its first attempt, is read every {@link SYNC_SENDING_WAIT_MS}. A sync waiting to retry is read once shortly after the
 * retry is due, at most {@link SYNC_RETRY_MAX_WAIT_MS} ahead, and the answer decides again. A finished sync is not read.
 */
export function nextSyncRead(
  sync: Pick<RunSyncView, 'status' | 'attempts' | 'error' | 'scheduledFor'> | null,
  context: { endedAt: number | null; emptyReads: number; now: number },
): number | null {
  if (!sync) {
    const { endedAt, emptyReads, now } = context;
    if (endedAt == null || now - endedAt >= SYNC_APPEAR_WINDOW_MS) return null;
    return SYNC_APPEAR_WAITS_MS[emptyReads] ?? null;
  }
  if (sync.status === 'processing') return SYNC_SENDING_WAIT_MS;
  if (sync.status !== 'pending') return null;
  if (!syncRetryPending(sync)) return SYNC_SENDING_WAIT_MS;
  const due = sync.scheduledFor ? Date.parse(sync.scheduledFor) : Number.NaN;
  if (Number.isNaN(due)) return SYNC_RETRY_MAX_WAIT_MS;
  return Math.min(Math.max(due - context.now, 0) + AFTER_RETRY_DUE_MS, SYNC_RETRY_MAX_WAIT_MS);
}
