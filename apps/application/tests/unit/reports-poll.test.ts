import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { unmounts } = vi.hoisted(() => ({ unmounts: [] as Array<() => void> }));
vi.mock('vue', () => ({ onUnmounted: (fn: () => void) => unmounts.push(fn) }));

const { useReportsPoll } = await import('../../app/composables/useReportsPoll');

beforeEach(() => {
  unmounts.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('useReportsPoll', () => {
  test('reads the run five times, waiting longer each time', async () => {
    const refresh = vi.fn(async () => {});
    useReportsPoll(refresh).start();
    for (const wait of [1_500, 3_000, 4_500, 6_000, 7_500]) await vi.advanceTimersByTimeAsync(wait);
    expect(refresh).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(5);
  });

  test('stops reading when the page leaves, a read in flight included', async () => {
    const refresh = vi.fn(async () => {});
    useReportsPoll(refresh).start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(1);
    for (const unmount of unmounts) unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    let finish: () => void = () => {};
    const slow = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    unmounts.length = 0;
    useReportsPoll(slow).start();
    await vi.advanceTimersByTimeAsync(1_500);
    for (const unmount of unmounts) unmount();
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  test('starting again restarts the reads rather than running two chains', async () => {
    const refresh = vi.fn(async () => {});
    const poll = useReportsPoll(refresh);
    poll.start();
    poll.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
