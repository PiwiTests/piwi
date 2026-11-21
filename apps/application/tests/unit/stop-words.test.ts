import { describe, expect, test } from 'vitest';
import { emptyLane, reduceLane, type LaneStop } from '@piwitests/core/live-lane';
import type { Lane } from '#shared/live-lanes';
import type { LiveWorkerState } from '#shared/live-view';
import { STOOD_FOR_MS, stopStoodMs, stopWords, watchedStop } from '../../app/utils/stop-words';

/**
 * The stop a watched worker's test stands at, as the lane panel shows it in its row's words: the stop of the worker's
 * lane as the run's stream sends it, or, for a worker in no lane the page holds, the stop the live view says; and how
 * long it has stood, which the row and the panel both say once it stood a minute.
 */

/** Lane `slot` of the run, worker `worker` in it, running `title`, stopped at `stop` when given. */
const runLane = (slot: number, worker: number, title: string, stop?: LaneStop): Lane => {
  const running = reduceLane(emptyLane({ run: 1, shard: null, lane: slot }), {
    type: 'test-begin',
    worker,
    test: { id: title, title, retry: 0 },
  });
  return stop ? reduceLane(running, { type: 'stopped', stop }) : running;
};

const PAUSE: LaneStop = { id: 'view:pause:Check', reason: 'pause', title: 'Check', since: null };
const TOLD: LaneStop = { id: 'stop:1000', reason: 'breakpoint', title: 'Click', since: 1_000 };

const worker = (over: Partial<LiveWorkerState>): LiveWorkerState => ({
  shard: null,
  worker: 0,
  connected: true,
  paused: null,
  ...over,
});

describe('watchedStop', () => {
  test('is the stop of the lane the watched worker says, in the row’s words', () => {
    const lanes = [runLane(0, 0, 'pays'), runLane(1, 1, 'checks out', PAUSE)];
    const stop = watchedStop(lanes, [], { shard: null, worker: 1, slot: 1 });
    expect(stop).toEqual({ reason: 'pause', since: null });
    expect(stopWords(stop!.reason)).toBe('Paused');
    expect(watchedStop(lanes, [], { shard: null, worker: 0, slot: 0 })).toBeNull();
  });

  test('keeps when the stop began, as its reporter told it', () => {
    const lanes = [runLane(0, 0, 'pays', TOLD)];
    expect(watchedStop(lanes, [], { shard: null, worker: 0, slot: 0 })).toEqual({ reason: 'breakpoint', since: 1_000 });
  });

  test('follows the lane through the worker Playwright starts in it again', () => {
    const lanes = [runLane(0, 3, 'pays', PAUSE)];
    expect(watchedStop(lanes, [], { shard: null, worker: 0, slot: 0 })).toEqual({ reason: 'pause', since: null });
  });

  test('reads a lane of the watched shard alone', () => {
    const lanes = [runLane(0, 0, 'pays', PAUSE)];
    expect(watchedStop(lanes, [], { shard: 2, worker: 0, slot: 0 })).toBeNull();
  });

  test('ends with the lane’s stop', () => {
    const stopped = runLane(0, 0, 'pays', TOLD);
    const resumed = reduceLane(stopped, { type: 'resumed', stop: TOLD.id });
    expect(watchedStop([resumed], [], { shard: null, worker: 0, slot: 0 })).toBeNull();
  });

  test('is the live view’s stop for a worker in no lane the page holds', () => {
    const paused = worker({
      paused: { reason: 'page-pause', call: { title: 'Pause', file: 'a.spec.ts', line: 3 }, test: 'pays' },
    });
    expect(watchedStop([], [worker({ worker: 1 }), paused], { shard: null, worker: 0 })).toEqual({
      reason: 'page-pause',
      since: null,
    });
    expect(watchedStop([], [paused], { shard: null, worker: 1 })).toBeNull();
    expect(watchedStop([], [], { shard: null, worker: 0 })).toBeNull();
  });

  test('is the stop of the lane a worker that says no lane ran in last', () => {
    const lanes = [runLane(0, 0, 'pays', TOLD)];
    expect(watchedStop(lanes, [], { shard: null, worker: 0 })).toEqual({ reason: 'breakpoint', since: 1_000 });
    expect(watchedStop(lanes, [], { shard: null, worker: 1 })).toBeNull();
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
