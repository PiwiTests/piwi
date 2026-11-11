import { describe, expect, test } from 'vitest';
import {
  nextSyncRead,
  SYNC_APPEAR_WAITS_MS,
  SYNC_RETRY_MAX_WAIT_MS,
  SYNC_SENDING_WAIT_MS,
  syncRetryPending,
} from '../../app/utils/run-sync-reads';

/** When the run page reads a run's results sync again. */
const NOW = Date.parse('2026-11-11T12:00:00Z');
const context = (endedAgoMs: number | null, emptyReads = 0) => ({
  endedAt: endedAgoMs == null ? null : NOW - endedAgoMs,
  emptyReads,
  now: NOW,
});
const sync = (status: 'pending' | 'processing' | 'done' | 'failed' | 'skipped', extra: object = {}) => ({
  status,
  attempts: 0,
  error: null as string | null,
  scheduledFor: null as string | null,
  ...extra,
});

describe('a run with no sync yet', () => {
  test('that just ended is read again after 2, 4, 8, 16 and 32 seconds, then no more', () => {
    const waits = [0, 1, 2, 3, 4, 5].map((reads) => nextSyncRead(null, context(1_000, reads)));
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, null]);
    expect(SYNC_APPEAR_WAITS_MS).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
  });

  test('that ended two minutes ago or more is not read again', () => {
    expect(nextSyncRead(null, context(2 * 60_000))).toBeNull();
    expect(nextSyncRead(null, context(2 * 60_000 - 1))).toBe(2_000);
  });

  test('whose end the page does not know is not read again', () => {
    expect(nextSyncRead(null, context(null))).toBeNull();
  });
});

describe('a sync', () => {
  test('being sent is read every five seconds', () => {
    expect(nextSyncRead(sync('processing', { attempts: 2 }), context(null))).toBe(SYNC_SENDING_WAIT_MS);
    expect(SYNC_SENDING_WAIT_MS).toBe(5_000);
  });

  test('waiting for its first attempt is read every five seconds', () => {
    const first = sync('pending', { scheduledFor: new Date(NOW).toISOString() });
    expect(syncRetryPending(first)).toBe(false);
    expect(nextSyncRead(first, context(null))).toBe(SYNC_SENDING_WAIT_MS);
  });

  test('waiting to retry is read once, just after the retry is due', () => {
    const retry = sync('pending', {
      attempts: 1,
      error: 'Zephyr Scale request failed (429)',
      scheduledFor: new Date(NOW + 60_000).toISOString(),
    });
    expect(syncRetryPending(retry)).toBe(true);
    expect(nextSyncRead(retry, context(null))).toBe(62_000);
  });

  test('whose retry is an hour away is read again in five minutes', () => {
    const retry = sync('pending', {
      attempts: 4,
      error: 'down',
      scheduledFor: new Date(NOW + 3_600_000).toISOString(),
    });
    expect(nextSyncRead(retry, context(null))).toBe(SYNC_RETRY_MAX_WAIT_MS);
    expect(SYNC_RETRY_MAX_WAIT_MS).toBe(5 * 60_000);
  });

  test('whose retry is overdue is read in a moment', () => {
    const retry = sync('pending', { attempts: 1, error: 'down', scheduledFor: new Date(NOW - 60_000).toISOString() });
    expect(nextSyncRead(retry, context(null))).toBe(2_000);
  });

  test.each(['done', 'failed', 'skipped'] as const)('that is %s is not read again', (status) => {
    expect(nextSyncRead(sync(status, { attempts: 1, error: 'x' }), context(1_000))).toBeNull();
  });
});
