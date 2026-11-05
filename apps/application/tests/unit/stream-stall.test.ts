import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { onStreamStall, stallWatch, STREAM_RECONNECT_STALL_MS, STREAM_STALL_MS } from '../../app/utils/stream-stall';

describe('onStreamStall', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('says a stream still unopened after the delay stalled', () => {
    const stalled = vi.fn();
    onStreamStall(() => false, stalled);
    vi.advanceTimersByTime(STREAM_STALL_MS - 1);
    expect(stalled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stalled).toHaveBeenCalledOnce();
  });

  test('stays quiet for a stream that opened', () => {
    const stalled = vi.fn();
    let open = false;
    onStreamStall(() => open, stalled);
    open = true;
    vi.advanceTimersByTime(STREAM_STALL_MS);
    expect(stalled).not.toHaveBeenCalled();
  });

  test('stays quiet once cancelled', () => {
    const stalled = vi.fn();
    const cancel = onStreamStall(() => false, stalled);
    cancel();
    vi.advanceTimersByTime(STREAM_STALL_MS);
    expect(stalled).not.toHaveBeenCalled();
  });
});

describe('stallWatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('runs one check at a time, and says a stream stalled once', () => {
    const stalled = vi.fn();
    const watch = stallWatch(() => false, stalled);
    watch.arm();
    vi.advanceTimersByTime(STREAM_STALL_MS - 1_000);
    // An error while the first check runs keeps its time.
    watch.arm(STREAM_RECONNECT_STALL_MS);
    vi.advanceTimersByTime(1_000);
    expect(stalled).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(STREAM_RECONNECT_STALL_MS);
    expect(stalled).toHaveBeenCalledOnce();
  });

  test('checks again once armed after a stall, and never while the stream is open', () => {
    const stalled = vi.fn();
    let open = false;
    const watch = stallWatch(() => open, stalled);
    watch.arm();
    vi.advanceTimersByTime(STREAM_STALL_MS);
    watch.arm(STREAM_RECONNECT_STALL_MS);
    vi.advanceTimersByTime(STREAM_RECONNECT_STALL_MS);
    expect(stalled).toHaveBeenCalledTimes(2);
    open = true;
    watch.arm();
    vi.advanceTimersByTime(STREAM_RECONNECT_STALL_MS);
    expect(stalled).toHaveBeenCalledTimes(2);
  });

  test('starts no check while the stream is open, and checks again after one that found it open', () => {
    const stalled = vi.fn();
    let open = true;
    const watch = stallWatch(() => open, stalled);
    watch.arm();
    open = false;
    vi.advanceTimersByTime(STREAM_RECONNECT_STALL_MS);
    expect(stalled).not.toHaveBeenCalled();
    // A check that ends while the stream is open leaves the watch ready for the next drop.
    watch.arm();
    open = true;
    vi.advanceTimersByTime(STREAM_STALL_MS);
    open = false;
    watch.arm();
    vi.advanceTimersByTime(STREAM_STALL_MS);
    expect(stalled).toHaveBeenCalledOnce();
  });

  test('says nothing once disarmed', () => {
    const stalled = vi.fn();
    const watch = stallWatch(() => false, stalled);
    watch.arm();
    watch.disarm();
    vi.advanceTimersByTime(STREAM_RECONNECT_STALL_MS);
    expect(stalled).not.toHaveBeenCalled();
  });
});
