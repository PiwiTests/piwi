import { describe, expect, test } from 'vitest';
import type { LiveStop } from '@piwitests/core/live-view';
import type { TestStop } from '@piwitests/core/wire';
import type { LiveWorkerState } from '#shared/live-view';
import type { TestCaseResult } from '../../types/api';
import { STOOD_FOR_MS, stopStoodMs, testStop, watchedStop } from '../../app/utils/stop-words';

/**
 * The stop a running test stands at, as its row and its worker's lane panel both show it, from the two sources that say
 * it: the live view's stop (`paused`, said by the worker at once) and the stop its reporter told (`test-stopped`, with
 * when it began). Where both stand, the reason and the call are the live view's and the time the told stop's; either
 * alone is the stop. The panel reads them for the test its worker runs now, as the row does.
 */

const CALL = { title: 'Click', file: 'tests/live.spec.ts', line: 4 };
const VIEW: LiveStop = { reason: 'pause', call: CALL, test: 'pays' };
const TOLD: TestStop = { ...CALL, reason: 'breakpoint', bar: true, since: 1_000, pausedMs: 0 };

const row = (over: Partial<TestCaseResult>): TestCaseResult =>
  ({
    executionId: 1,
    testCaseId: 0,
    title: 'pays',
    location: 'tests/live.spec.ts:3:1',
    status: 'running',
    workerIndex: 0,
    shardIndex: null,
    startedAt: 10,
    liveStop: null,
    ...over,
  }) as TestCaseResult;

const worker = (over: Partial<LiveWorkerState>): LiveWorkerState => ({
  shard: null,
  worker: 0,
  connected: true,
  paused: null,
  ...over,
});
const workers = (...list: LiveWorkerState[]) =>
  Object.fromEntries(list.map((w) => [`${w.shard ?? ''}:${w.worker}`, w]));

describe('testStop', () => {
  test('takes the reason and the call from the live view and the time from the told stop when both stand', () => {
    expect(testStop(VIEW, TOLD)).toEqual({ reason: 'pause', call: CALL, since: 1_000 });
  });

  test('is either stop alone', () => {
    expect(testStop(VIEW, null)).toEqual({ reason: 'pause', call: CALL, since: null });
    expect(testStop(null, TOLD)).toEqual({ reason: 'breakpoint', call: CALL, since: 1_000 });
    expect(testStop(null, undefined)).toBeNull();
  });
});

describe('watchedStop', () => {
  test('is the stop of the test the worker runs now, from both sources', () => {
    const rows = [row({ executionId: 1, title: 'checks out', startedAt: 1 }), row({ liveStop: TOLD })];
    expect(watchedStop(rows, workers(worker({ paused: VIEW })), { shard: null, worker: 0 })).toEqual({
      reason: 'pause',
      call: CALL,
      since: 1_000,
    });
  });

  test('keeps the told stop once the live view’s ends, as the row does', () => {
    const rows = [row({ liveStop: TOLD })];
    expect(watchedStop(rows, workers(worker({})), { shard: null, worker: 0 })).toEqual({
      reason: 'breakpoint',
      call: CALL,
      since: 1_000,
    });
  });

  test('reads the live view’s stop of a worker that says no lane', () => {
    expect(watchedStop([row({})], workers(worker({ paused: VIEW })), { shard: null, worker: 0 })).toEqual({
      reason: 'pause',
      call: CALL,
      since: null,
    });
  });

  test('leaves out a live view’s stop of the worker’s next test, whose row has not come yet', () => {
    const next = { ...VIEW, test: 'refunds' };
    expect(watchedStop([row({})], workers(worker({ paused: next })), { shard: null, worker: 0 })).toBeNull();
  });

  test('is the live view’s stop of a worker with no running row', () => {
    expect(watchedStop([], workers(worker({ paused: VIEW })), { shard: null, worker: 0 })).toEqual({
      reason: 'pause',
      call: CALL,
      since: null,
    });
    expect(watchedStop([row({ status: 'passed', liveStop: TOLD })], workers(), { shard: null, worker: 0 })).toBeNull();
  });

  test('reads the watched worker of the watched shard alone', () => {
    const rows = [row({ liveStop: TOLD }), row({ executionId: 2, workerIndex: 1 })];
    expect(watchedStop(rows, workers(), { shard: null, worker: 1 })).toBeNull();
    expect(watchedStop(rows, workers(), { shard: 2, worker: 0 })).toBeNull();
  });
});

describe('stopStoodMs', () => {
  test('says how long a stop has stood once it stood a minute, in whole minutes', () => {
    expect(stopStoodMs(1_000, 1_000 + STOOD_FOR_MS - 1)).toBeNull();
    expect(stopStoodMs(1_000, 1_000 + STOOD_FOR_MS)).toBe(60_000);
    expect(stopStoodMs(1_000, 1_000 + 7 * 60_000 + 59_000)).toBe(7 * 60_000);
  });

  test('says nothing for a stop whose producer cannot tell when it began', () => {
    expect(stopStoodMs(null, Date.now())).toBeNull();
    expect(stopStoodMs(undefined, Date.now())).toBeNull();
  });
});
