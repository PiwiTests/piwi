import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { onStreamStall, STREAM_STALL_MS } from '../../app/utils/stream-stall';

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
