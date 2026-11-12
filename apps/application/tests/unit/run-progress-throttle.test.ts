import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RUN_PROGRESS_INTERVAL_MS, keyedThrottle } from '../../server/utils/run-progress-throttle';

/**
 * The throttle of the runs' tallies on the instance stream and the demo's: at most one value per key every interval,
 * the first at once, the latest held one as the interval ends, and a held one sent at once when flushed.
 */

/** A throttle over 2 s, and what it sent: `[at, key, value]`. */
function throttled() {
  const sent: Array<[number, string, number]> = [];
  const throttle = keyedThrottle<string, number>(RUN_PROGRESS_INTERVAL_MS, (key, value) =>
    sent.push([Date.now(), key, value]),
  );
  return { throttle, sent };
}

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

describe('keyedThrottle', () => {
  test('sends the first value at once, then the latest one of the interval as it ends', () => {
    const { throttle, sent } = throttled();
    throttle.push('run-1', 1);
    vi.advanceTimersByTime(500);
    throttle.push('run-1', 2);
    throttle.push('run-1', 3);
    expect(sent).toEqual([[0, 'run-1', 1]]);
    vi.advanceTimersByTime(1_500);
    expect(sent).toEqual([
      [0, 'run-1', 1],
      [2_000, 'run-1', 3],
    ]);
  });

  test('sends at most one value per interval while values keep coming', () => {
    const { throttle, sent } = throttled();
    for (let at = 0; at < 10_000; at += 100) {
      throttle.push('run-1', at);
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(RUN_PROGRESS_INTERVAL_MS);
    const times = sent.map(([at]) => at);
    expect(times).toEqual([0, 2_000, 4_000, 6_000, 8_000, 10_000]);
    // The last value pushed is never lost.
    expect(sent.at(-1)).toEqual([10_000, 'run-1', 9_900]);
  });

  test('sends nothing more when nothing came during the interval, and a later value at once', () => {
    const { throttle, sent } = throttled();
    throttle.push('run-1', 1);
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([[0, 'run-1', 1]]);
    throttle.push('run-1', 2);
    expect(sent).toEqual([
      [0, 'run-1', 1],
      [10_000, 'run-1', 2],
    ]);
  });

  test('throttles each key on its own', () => {
    const { throttle, sent } = throttled();
    throttle.push('run-1', 1);
    throttle.push('run-2', 10);
    throttle.push('run-1', 2);
    expect(sent).toEqual([
      [0, 'run-1', 1],
      [0, 'run-2', 10],
    ]);
    vi.advanceTimersByTime(RUN_PROGRESS_INTERVAL_MS);
    expect(sent).toEqual([
      [0, 'run-1', 1],
      [0, 'run-2', 10],
      [2_000, 'run-1', 2],
    ]);
  });

  test('sends a held value at once when flushed, and the next value afresh', () => {
    const { throttle, sent } = throttled();
    throttle.push('run-1', 1);
    vi.advanceTimersByTime(300);
    throttle.push('run-1', 2);
    throttle.flush('run-1');
    expect(sent).toEqual([
      [0, 'run-1', 1],
      [300, 'run-1', 2],
    ]);
    vi.advanceTimersByTime(RUN_PROGRESS_INTERVAL_MS);
    expect(sent).toHaveLength(2);
    throttle.push('run-1', 3);
    expect(sent.at(-1)).toEqual([2_300, 'run-1', 3]);
    // A key with nothing held sends nothing.
    throttle.flush('run-2');
    expect(sent).toHaveLength(3);
  });

  test('drops what it holds once disposed', () => {
    const { throttle, sent } = throttled();
    throttle.push('run-1', 1);
    throttle.push('run-1', 2);
    throttle.dispose();
    vi.advanceTimersByTime(RUN_PROGRESS_INTERVAL_MS * 2);
    expect(sent).toEqual([[0, 'run-1', 1]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
