import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RefetchResult } from '../../app/utils/refetch-keeping';
import { STREAM_REOPEN_MAX_MS, STREAM_REOPEN_MIN_MS, streamReopener } from '../../app/utils/stream-reopen';

/** A reopener whose reads answer as `answers` says, one per try, and the times its stream opened. */
function reopenerOf(answers: RefetchResult[]) {
  const reads: number[] = [];
  const opens: number[] = [];
  const reopener = streamReopener(
    async () => {
      reads.push(Date.now());
      return answers.shift() ?? 'answered';
    },
    () => opens.push(Date.now()),
  );
  return { reopener, reads, opens };
}

describe('streamReopener', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  test('reads the data again after the shortest wait, then opens the stream', async () => {
    const { reopener, reads, opens } = reopenerOf(['answered']);
    reopener.schedule();
    await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MIN_MS - 1);
    expect(reads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toEqual([STREAM_REOPEN_MIN_MS]);
    expect(opens).toEqual([STREAM_REOPEN_MIN_MS]);
  });

  test('opens no stream while the data cannot be read, and tries again, waiting longer each time', async () => {
    const { reopener, reads, opens } = reopenerOf(['failed', 'failed', 'answered']);
    reopener.schedule();
    await vi.advanceTimersByTimeAsync(2_000 + 4_000);
    expect(reads).toEqual([2_000, 6_000]);
    expect(opens).toEqual([]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(reads).toEqual([2_000, 6_000, 14_000]);
    expect(opens).toEqual([14_000]);
  });

  test('waits longer after each stream that closed again, up to the longest wait, and from the shortest once reset', async () => {
    const { reopener, reads } = reopenerOf([]);
    /** How long the next try waits before it reads. */
    const nextWait = async () => {
      const scheduledAt = Date.now();
      reopener.schedule();
      await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MAX_MS);
      return reads.at(-1)! - scheduledAt;
    };
    const waits = [];
    for (let i = 0; i < 6; i++) waits.push(await nextWait());
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, STREAM_REOPEN_MAX_MS, STREAM_REOPEN_MAX_MS]);
    // The stream opened.
    reopener.reset();
    expect(await nextWait()).toBe(STREAM_REOPEN_MIN_MS);
  });

  test('runs one try at a time', async () => {
    const { reopener, reads } = reopenerOf([]);
    reopener.schedule();
    reopener.schedule();
    await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MAX_MS);
    expect(reads).toEqual([STREAM_REOPEN_MIN_MS]);
  });

  test('drops a try reset while it waits or while it reads', async () => {
    let answer: (result: RefetchResult) => void = () => {};
    const opens: number[] = [];
    let reads = 0;
    const reopener = streamReopener(
      () => {
        reads++;
        return new Promise<RefetchResult>((resolve) => (answer = resolve));
      },
      () => opens.push(Date.now()),
    );
    reopener.schedule();
    reopener.reset();
    await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MAX_MS);
    expect(reads).toBe(0);

    reopener.schedule();
    await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MIN_MS);
    expect(reads).toBe(1);
    // The page stops following the stream (it leaves, the run ends) while the data is read.
    reopener.reset();
    answer('failed');
    await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MAX_MS);
    expect([reads, opens]).toEqual([1, []]);

    // A read that answers after the reset opens no stream either.
    reopener.schedule();
    await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MIN_MS);
    expect(reads).toBe(2);
    reopener.reset();
    answer('answered');
    await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MAX_MS);
    expect([reads, opens]).toEqual([2, []]);
  });

  test('stops when the data is gone or the viewer cannot read it, and tries again after any other failure', async () => {
    for (const failure of ['gone', 'signed-out', 'forbidden'] as const) {
      const { reopener, reads, opens } = reopenerOf([failure, 'answered']);
      reopener.schedule();
      await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MAX_MS * 4);
      expect([reads.length, opens.length], failure).toEqual([1, 0]);
      // The page can start again (Retry), from the shortest wait.
      reopener.reset();
      reopener.schedule();
      await vi.advanceTimersByTimeAsync(STREAM_REOPEN_MIN_MS);
      expect([reads.length, opens.length], failure).toEqual([2, 1]);
    }
  });
});
