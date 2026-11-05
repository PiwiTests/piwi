import { describe, expect, test } from 'vitest';
import {
  LIVE_VIEW_END_TEXT,
  liveWatchAddress,
  liveWorkerName,
  parseLiveViewerMessage,
  parseLiveWatchAddress,
} from '#shared/live-view';

/**
 * What the run page reads of a worker's view: a worker is named with its shard in a sharded run, a frame names its
 * test, and each way a view ends has its sentence.
 */

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
    const frame = { type: 'frame', data: 'AAAA', call: null, test: 'pays' };
    expect(parseLiveViewerMessage(JSON.stringify({ ...frame, at: 1_760_000_000_000 }))).toEqual({
      ...frame,
      at: 1_760_000_000_000,
    });
    expect(parseLiveViewerMessage(JSON.stringify({ ...frame, at: 'now' }))).toEqual(frame);
    expect(parseLiveViewerMessage(JSON.stringify({ ...frame, at: 12 }))).toEqual(frame);
  });

  test('names a worker by its lane from 1, else by its index, and its shard in a sharded run', () => {
    expect(liveWorkerName({ shard: null, worker: 5, slot: 1 })).toBe('worker 2');
    expect(liveWorkerName({ shard: 2, worker: 7, slot: 0 })).toBe('worker 1 of shard 2');
    expect(liveWorkerName({ shard: null, worker: 0 })).toBe('worker 0');
    expect(liveWorkerName({ shard: 2, worker: 3 })).toBe('worker 3 of shard 2');
  });

  test('reads how a test ended, on its own or with the view’s end, and leaves out an outcome it cannot read', () => {
    const outcome = { test: 'pays', status: 'timedOut', ms: 30_000 };
    expect(parseLiveViewerMessage(JSON.stringify({ type: 'test-ended', outcome }))).toEqual({
      type: 'test-ended',
      outcome,
    });
    expect(parseLiveViewerMessage(JSON.stringify({ type: 'test-ended', outcome: { status: 'done' } }))).toEqual({
      type: 'test-ended',
      outcome: null,
    });
    expect(parseLiveViewerMessage(JSON.stringify({ type: 'end', reason: 'test-ended', outcome }))).toEqual({
      type: 'end',
      reason: 'test-ended',
      outcome,
    });
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
    const read = parseLiveViewerMessage(JSON.stringify({ type: 'call-log', log, test: 'pays' }));
    expect(read).toMatchObject({ type: 'call-log', log: { id: 'call@1', point: { x: 10, y: 20 } }, test: 'pays' });
    expect(JSON.stringify(read)).not.toContain('S3cr3t');
    expect(parseLiveViewerMessage(JSON.stringify({ type: 'call-log', log: null }))).toBeNull();
    expect(parseLiveViewerMessage(JSON.stringify({ type: 'call-log', log: { ...log, status: 'done' } }))).toBeNull();
  });

  test('says why each view ended, its replacement by another of the same person included', () => {
    for (const reason of ['test-ended', 'worker-left', 'run-ended', 'off', 'replaced'] as const) {
      expect(parseLiveViewerMessage(JSON.stringify({ type: 'end', reason }))).toEqual({ type: 'end', reason });
      expect(LIVE_VIEW_END_TEXT[reason].length).toBeGreaterThan(0);
    }
    expect(parseLiveViewerMessage(JSON.stringify({ type: 'end', reason: 'other' }))).toBeNull();
  });
});
