import { describe, expect, test } from 'vitest';
import { LIVE_VIEW_END_TEXT, liveWorkerName, parseLiveViewerMessage } from '#shared/live-view';

/**
 * What the run page reads of a worker's view: a worker is named with its shard in a sharded run, a frame names its
 * test, and each way a view ends has its sentence.
 */

describe("a worker's view on the run page", () => {
  test('names a worker by its index, and its shard in a sharded run', () => {
    expect(liveWorkerName({ shard: null, worker: 0 })).toBe('worker 0');
    expect(liveWorkerName({ shard: 2, worker: 3 })).toBe('worker 3 of shard 2');
  });

  test('reads a frame with its call and its test, and nothing that is not one', () => {
    const call = { title: 'Click', file: 'tests/a.spec.ts', line: 4 };
    expect(parseLiveViewerMessage(JSON.stringify({ type: 'frame', data: '/9j/', call, test: 'pays' }))).toEqual({
      type: 'frame',
      data: '/9j/',
      call,
      test: 'pays',
    });
    expect(parseLiveViewerMessage(JSON.stringify({ type: 'frame', data: '/9j/' }))).toEqual({
      type: 'frame',
      data: '/9j/',
      call: null,
      test: null,
    });
    expect(parseLiveViewerMessage(JSON.stringify({ type: 'frame', data: '' }))).toBeNull();
    expect(parseLiveViewerMessage('not json')).toBeNull();
  });

  test('says why each view ended, its replacement by another of the same person included', () => {
    for (const reason of ['test-ended', 'worker-left', 'run-ended', 'off', 'replaced'] as const) {
      expect(parseLiveViewerMessage(JSON.stringify({ type: 'end', reason }))).toEqual({ type: 'end', reason });
      expect(LIVE_VIEW_END_TEXT[reason].length).toBeGreaterThan(0);
    }
    expect(parseLiveViewerMessage(JSON.stringify({ type: 'end', reason: 'other' }))).toBeNull();
  });
});
