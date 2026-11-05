import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { onStreamStall, STREAM_STALL_MS } from '../../app/utils/stream-stall';

const CONNECTING = 0;
const OPEN = 1;

describe('onStreamStall', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('says a stream still connecting after the delay stalled', () => {
    const stalled = vi.fn();
    onStreamStall({ readyState: CONNECTING }, stalled);
    vi.advanceTimersByTime(STREAM_STALL_MS - 1);
    expect(stalled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stalled).toHaveBeenCalledOnce();
  });

  test('stays quiet for a stream that opened', () => {
    const stalled = vi.fn();
    const source = { readyState: CONNECTING };
    onStreamStall(source, stalled);
    source.readyState = OPEN;
    vi.advanceTimersByTime(STREAM_STALL_MS);
    expect(stalled).not.toHaveBeenCalled();
  });

  test('stays quiet once cancelled', () => {
    const stalled = vi.fn();
    const cancel = onStreamStall({ readyState: CONNECTING }, stalled);
    cancel();
    vi.advanceTimersByTime(STREAM_STALL_MS);
    expect(stalled).not.toHaveBeenCalled();
  });
});
