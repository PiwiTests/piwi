import { describe, expect, test } from 'vitest';
import {
  MAX_LIVE_FRAME,
  createLiveMessageReader,
  encodeLiveMessage,
  readLiveViewerMessage,
} from '@piwitests/core/live-view';
import { LIVE_VIEW_END_TEXT, liveWatchAddress, liveWorkerName, parseLiveWatchAddress } from '#shared/live-view';

/**
 * What the run page reads of its watch: a worker is named with its shard in a sharded run, each message names its
 * worker, a frame its test and its image, and each way a view ends has its sentence.
 */

/** A JPEG's first bytes. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const ID = { shard: null, worker: 0, slot: 0 };

/** A message of the watch as the page reads it off its stream. */
function read(header: Record<string, unknown>, data: Uint8Array | null = null) {
  const [message] = createLiveMessageReader({ maxData: MAX_LIVE_FRAME })(encodeLiveMessage(header, data));
  return readLiveViewerMessage(message!);
}

describe("a worker's view on the run page", () => {
  test('names a lane in the page’s address by the worker’s number, after its shard, and reads it back', () => {
    expect(liveWatchAddress({ shard: null, slot: 1 })).toBe('2');
    expect(liveWatchAddress({ shard: 3, slot: 0 })).toBe('3.1');
    expect(parseLiveWatchAddress('2')).toEqual({ shard: null, slot: 1 });
    expect(parseLiveWatchAddress('3.1')).toEqual({ shard: 3, slot: 0 });
    for (const value of ['0', '0.1', '1.0', '-1', '1.2.3', 'two', '', ['1'], 2, undefined]) {
      expect(parseLiveWatchAddress(value), String(value)).toBeNull();
    }
  });

  test('reads when a frame’s page looked so, and leaves out a time it cannot read', () => {
    const frame = { type: 'frame', ...ID, call: null, test: 'pays' };
    expect(read({ ...frame, at: 1_760_000_000_000 }, JPEG)).toEqual({ ...frame, image: JPEG, at: 1_760_000_000_000 });
    expect(read({ ...frame, at: 'now' }, JPEG)).toEqual({ ...frame, image: JPEG });
    expect(read({ ...frame, at: 12 }, JPEG)).toEqual({ ...frame, image: JPEG });
  });

  test('names a worker by its lane from 1, else by its index, and its shard in a sharded run', () => {
    expect(liveWorkerName({ shard: null, worker: 5, slot: 1 })).toBe('worker 2');
    expect(liveWorkerName({ shard: 2, worker: 7, slot: 0 })).toBe('worker 1 of shard 2');
    expect(liveWorkerName({ shard: null, worker: 0 })).toBe('worker 0');
    expect(liveWorkerName({ shard: 2, worker: 3 })).toBe('worker 3 of shard 2');
  });

  test('reads how a test ended, on its own or with the view’s end, and leaves out an outcome it cannot read', () => {
    const outcome = { test: 'pays', status: 'timedOut', ms: 30_000 };
    expect(read({ type: 'test-ended', ...ID, outcome })).toEqual({ type: 'test-ended', ...ID, outcome });
    expect(read({ type: 'test-ended', ...ID, outcome: { status: 'done' } })).toEqual({
      type: 'test-ended',
      ...ID,
      outcome: null,
    });
    expect(read({ type: 'end', ...ID, reason: 'test-ended', outcome })).toEqual({
      type: 'end',
      ...ID,
      reason: 'test-ended',
      outcome,
    });
  });

  test('reads a frame with its call, its test and its image, and nothing that is not one', () => {
    const call = { title: 'Click', file: 'tests/a.spec.ts', line: 4 };
    expect(read({ type: 'frame', ...ID, call, test: 'pays' }, JPEG)).toEqual({
      type: 'frame',
      ...ID,
      image: JPEG,
      call,
      test: 'pays',
    });
    expect(read({ type: 'frame', ...ID }, JPEG)).toEqual({ type: 'frame', ...ID, image: JPEG, call: null, test: null });
    expect(read({ type: 'frame', ...ID })).toBeNull();
    expect(read({ type: 'frame', call }, JPEG)).toBeNull();
  });

  test('reads a call log with its test’s title, and nothing that is not one', () => {
    const log = {
      id: 'call@1',
      call: { title: 'Fill "S3cr3t"', file: 'tests/a.spec.ts', line: 4 },
      status: 'running',
      lines: ['  fill("S3cr3t")'],
      point: { x: 10, y: 20 },
      target: null,
      viewport: { width: 1280, height: 800 },
      ms: 500,
      error: null,
    };
    const shown = read({ type: 'call-log', ...ID, log, test: 'pays' });
    expect(shown).toMatchObject({ type: 'call-log', log: { id: 'call@1', point: { x: 10, y: 20 } }, test: 'pays' });
    expect(JSON.stringify(shown)).not.toContain('S3cr3t');
    expect(read({ type: 'call-log', ...ID, log: null })).toBeNull();
    expect(read({ type: 'call-log', ...ID, log: { ...log, status: 'done' } })).toBeNull();
  });

  test('says why each view ended, its replacement by another of the same person included', () => {
    for (const reason of ['test-ended', 'worker-left', 'run-ended', 'off', 'replaced', 'unshared'] as const) {
      expect(read({ type: 'end', reason })).toEqual({ type: 'end', reason });
      expect(LIVE_VIEW_END_TEXT[reason].length).toBeGreaterThan(0);
    }
    expect(read({ type: 'end', reason: 'other' })).toBeNull();
  });
});
