import { describe, expect, test } from 'vitest';
import type { LiveStop } from '@piwitests/core/live-view';
import type { TestStop } from '@piwitests/core/wire';
import { RUN_WORDS_EN } from '@piwitests/run-model/words';
import type { LiveWorkerState } from '#shared/live-view';
import type { TestCaseResult } from '../../types/api';
import {
  STOOD_FOR_MS,
  heldStopWords,
  pausedStopWords,
  stopStoodMs,
  stopWords,
  testStop,
  watchedStop,
} from '../../app/utils/stop-words';

/**
 * The stop a running test stands at, as its row and its worker's lane panel both show it, from the two sources that say
 * it: the live view's stop (`paused`, said by the worker at once) and the stop its reporter told (`test-stopped`, with
 * when it began). Where both stand, the reason and the call are the live view's and the time the told stop's; either
 * alone is the stop. The panel reads them for the test its worker runs now, as the row does, a failed CI test held for
 * its controllers included, with its hold, and a CI test they paused, with who paused it. The words: its reason's,
 * and for a held CI failure the run model's (`Failed, held at its line`), for whom and until when; for a paused CI test,
 * by whom and until when.
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

const UNTIL = 1_800_000_000_000;
/** The page's clock, as a test reads it: the hold's end alone, at 12:05. */
const clock = (time: number) => (time === UNTIL ? '12:05' : 'another time');
const HELD: LiveStop = { reason: 'held', call: CALL, test: 'pays', until: UNTIL };
const PAUSED: LiveStop = { reason: 'pause', call: CALL, test: 'pays', until: UNTIL };

describe('the words of a stop', () => {
  test('read a held CI failure as a failure held at its line', () => {
    expect(stopWords('held')).toBe(RUN_WORDS_EN.runs_stateFailed);
    expect(stopWords('failure')).toBe('Held at its failure');
    expect(stopWords('later')).toBe('Stopped');
  });

  test('say for whom a held CI failure is held, and until when', () => {
    expect(heldStopWords({ until: UNTIL }, ['Ana'], clock)).toBe('Held for Ana · until 12:05');
    expect(heldStopWords({ until: UNTIL }, ['Ana', 'Bo', 'Cy'], clock)).toBe('Held for Ana, Bo, and Cy · until 12:05');
    expect(heldStopWords({ until: UNTIL }, [], clock)).toBe('Held · until 12:05');
    // A held stop of a reporter that said no end names none.
    expect(heldStopWords({}, ['Ana'], clock)).toBeNull();
  });
});

describe('the words of a CI test paused for its controllers', () => {
  test('say who paused it, and until when', () => {
    expect(pausedStopWords({ until: UNTIL }, 'Ana', clock)).toBe('Paused by Ana · until 12:05');
    expect(pausedStopWords({ until: UNTIL }, null, clock)).toBe('Paused · until 12:05');
    expect(pausedStopWords({}, 'Ana', clock)).toBeNull();
  });
});

describe('testStop', () => {
  test('takes the reason and the call from the live view and the time from the told stop when both stand', () => {
    expect(testStop(VIEW, TOLD)).toEqual({ reason: 'pause', call: CALL, since: 1_000 });
  });

  test('carries a held CI failure’s hold: its end, its controllers and whether its worker can be let go', () => {
    expect(testStop(HELD, null, { heldFor: ['Ana'], holds: true })).toEqual({
      reason: 'held',
      call: CALL,
      since: null,
      held: { until: UNTIL, heldFor: ['Ana'], holds: true },
    });
    expect(testStop(HELD, null, null)?.held).toEqual({ until: UNTIL, heldFor: [], holds: false });
    expect(testStop(VIEW, null, { heldFor: ['Ana'], holds: true })).not.toHaveProperty('held');
  });

  test('carries a CI test’s pause for its controllers: its end, who paused it and whether its worker can pause', () => {
    expect(testStop(PAUSED, null, { pauses: true, holds: true, pausedBy: 'Ana' })).toEqual({
      reason: 'pause',
      call: CALL,
      since: null,
      ciPause: { until: UNTIL, pausedBy: 'Ana', pauses: true },
    });
    expect(testStop(PAUSED, null, { pauses: true, holds: true })?.ciPause).toEqual({
      until: UNTIL,
      pausedBy: null,
      pauses: true,
    });
    // A local run's pause, shared live, names no end: it is nobody's CI pause.
    expect(testStop(VIEW, null, { pauses: true, holds: true })).not.toHaveProperty('ciPause');
    expect(testStop(PAUSED, null, null)).not.toHaveProperty('ciPause');
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

  test('reads a held CI failure as the row reads it, its hold included', () => {
    const held = worker({ paused: HELD, slot: 0, holds: true, heldFor: ['Ana'] });
    const rows = [row({})];
    expect(watchedStop(rows, workers(held), { shard: null, worker: 0 })).toEqual(
      testStop(held.paused, rows[0]!.liveStop, held),
    );
    expect(watchedStop(rows, workers(held), { shard: null, worker: 0 })?.held).toEqual({
      until: UNTIL,
      heldFor: ['Ana'],
      holds: true,
    });
  });

  test('reads a paused CI test as the row reads it, who paused it included', () => {
    const paused = worker({ paused: PAUSED, slot: 0, holds: true, pauses: true, pausedBy: 'Ana' });
    expect(watchedStop([row({})], workers(paused), { shard: null, worker: 0 })?.ciPause).toEqual({
      until: UNTIL,
      pausedBy: 'Ana',
      pauses: true,
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
