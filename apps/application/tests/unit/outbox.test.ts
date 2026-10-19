import { describe, test, expect } from 'vitest';
import { nextAttempt, OUTBOX_BACKOFF_MINUTES, OUTBOX_MAX_ATTEMPTS } from '../../server/utils/outbox';

const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('nextAttempt', () => {
  test('retries after 1, 5, 15, 60 and 240 minutes, then gives up', () => {
    const waits = [];
    for (let attempts = 1; attempts < OUTBOX_MAX_ATTEMPTS; attempts++) {
      const r = nextAttempt(attempts, NOW, NOW);
      expect(r.status).toBe('pending');
      waits.push((r.scheduledFor!.getTime() - NOW.getTime()) / 60_000);
    }
    expect(waits).toEqual([1, 5, 15, 60, 240]);
    expect(nextAttempt(OUTBOX_MAX_ATTEMPTS, NOW, NOW).status).toBe('failed');
  });

  test('marks failed at the attempt cap, keeping the current schedule', () => {
    const current = new Date('2026-01-02T00:00:00.000Z');
    const r = nextAttempt(OUTBOX_MAX_ATTEMPTS, NOW, current);
    expect(r.status).toBe('failed');
    expect(r.scheduledFor).toBe(current);
  });

  test('an explicit retry-after wins over the backoff table', () => {
    const r = nextAttempt(1, NOW, NOW, 90_000);
    expect(r.status).toBe('pending');
    expect(r.scheduledFor!.getTime()).toBe(NOW.getTime() + 90_000);
  });

  test('a zero or negative retry-after falls back to the backoff table', () => {
    const r = nextAttempt(1, NOW, NOW, 0);
    expect(r.scheduledFor!.getTime()).toBe(NOW.getTime() + OUTBOX_BACKOFF_MINUTES[0]! * 60_000);
  });
});
