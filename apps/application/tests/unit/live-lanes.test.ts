import { describe, expect, test } from 'vitest';
import { RunLanes, heldLanes, laneTestId, type Lane } from '#shared/live-lanes';
import { runEventBus, type RunEvent } from '../../server/utils/run-events';

/**
 * The lanes of a live run as the instance keeps them: reduced from the run's events as they are published, and
 * published as `lane` events, which the stream's catch-up replays.
 */

const PAYS = { title: 'pays by card', location: 'tests/checkout.spec.ts:12:3', browser: null, repeatEachIndex: 0 };

function begin(over: Record<string, unknown> = {}) {
  return {
    type: 'test-begin',
    data: { ...PAYS, workerIndex: 4, parallelIndex: 1, shardIndex: 2, retries: 0, ...over },
  };
}

function completed(status: string, over: Record<string, unknown> = {}) {
  return {
    type: 'test-completed',
    data: { ...PAYS, status, workerIndex: 4, parallelIndex: 1, shardIndex: 2, retries: 0, ...over },
  };
}

const STOP = {
  reason: 'breakpoint',
  title: 'click Pay',
  file: 'tests/checkout.spec.ts',
  line: 14,
  bar: true,
  since: 99,
};

describe('RunLanes', () => {
  test('a test begins and completes in its lane: running, then between, counted', () => {
    const lanes = new RunLanes();
    const [running] = lanes.hear(7, begin());
    expect(running).toMatchObject({
      id: { run: 7, shard: 2, lane: 1 },
      state: 'running',
      worker: 4,
      test: { id: laneTestId(PAYS), title: 'pays by card', retry: 0 },
    });
    const [ended] = lanes.hear(7, completed('failed'));
    expect(ended).toMatchObject({ state: 'between', test: null, done: 1, failed: 1 });
    expect(lanes.lanesOf(7)).toEqual([ended]);
  });

  test('a reporter’s stop and its end: stopped at its call, then running', () => {
    const lanes = new RunLanes();
    lanes.hear(7, begin());
    const stopped = { ...PAYS, workerIndex: 4, parallelIndex: 1, shardIndex: 2, retries: 0, stop: STOP };
    expect(lanes.hear(7, { type: 'test-stopped', data: stopped })[0]).toMatchObject({
      state: 'stopped',
      stop: { id: 'stop:99', reason: 'breakpoint', title: 'click Pay', since: 99 },
    });
    const resumed = { ...PAYS, workerIndex: 4, parallelIndex: 1, shardIndex: 2, retries: 0, pausedMs: 5 };
    expect(lanes.hear(7, { type: 'test-resumed', data: resumed })[0]).toMatchObject({ state: 'running', stop: null });
  });

  test('a stop about an earlier attempt leaves the running one as it is', () => {
    const lanes = new RunLanes();
    lanes.hear(7, begin({ retries: 1 }));
    const stopped = { ...PAYS, workerIndex: 4, parallelIndex: 1, shardIndex: 2, retries: 0, stop: STOP };
    expect(lanes.hear(7, { type: 'test-stopped', data: stopped })).toEqual([]);
  });

  test('the live view’s stop holds until its worker goes on or leaves the view', () => {
    const lanes = new RunLanes();
    lanes.hear(7, begin());
    const worker = { shard: 2, worker: 4, slot: 1, connected: true };
    const paused = { reason: 'pause', call: { title: 'fill Name', file: null, line: null }, test: 'pays by card' };
    expect(lanes.hear(7, { type: 'live-worker', data: { ...worker, paused } })[0]).toMatchObject({
      state: 'stopped',
      stop: { reason: 'pause', title: 'fill Name', since: null },
    });
    // The same stop said again changes nothing.
    expect(lanes.hear(7, { type: 'live-worker', data: { ...worker, paused } })).toEqual([]);
    expect(
      lanes.hear(7, { type: 'live-worker', data: { ...worker, connected: false, paused: null } })[0],
    ).toMatchObject({ state: 'running', stop: null, test: { title: 'pays by card' } });
  });

  test('a worker of the live view that leaves leaves its lane’s test running: the test says when it ends', () => {
    const lanes = new RunLanes();
    lanes.hear(7, begin());
    expect(lanes.hear(7, { type: 'live-worker', data: { shard: 2, worker: 4, slot: 1, connected: false } })).toEqual(
      [],
    );
    expect(lanes.lanesOf(7)[0]?.state).toBe('running');
  });

  test('the worker Playwright starts again in a lane takes it, with its retry', () => {
    const lanes = new RunLanes();
    lanes.hear(7, begin());
    lanes.hear(7, completed('failed'));
    const [retry] = lanes.hear(7, begin({ workerIndex: 5, retries: 1 }));
    expect(retry).toMatchObject({ state: 'running', worker: 5, test: { retry: 1 }, done: 1, failed: 1 });
    // The end of an attempt counted already changes nothing.
    expect(lanes.hear(7, completed('passed', { workerIndex: 4 }))).toEqual([]);
  });

  test('a failed attempt whose end comes after its retry began counts, once however often it is sent', () => {
    const lanes = new RunLanes();
    lanes.hear(7, begin({ workerIndex: 0 }));
    lanes.hear(7, begin({ workerIndex: 1, retries: 1 }));
    const [counted] = lanes.hear(7, completed('failed', { workerIndex: 0 }));
    expect(counted).toMatchObject({ state: 'running', worker: 1, test: { retry: 1 }, done: 1, failed: 1 });
    expect(lanes.hear(7, completed('failed', { workerIndex: 0 }))).toEqual([]);
    lanes.hear(7, completed('passed', { workerIndex: 1, retries: 1 }));
    expect(lanes.hear(7, completed('passed', { workerIndex: 1, retries: 1 }))).toEqual([]);
    expect(lanes.lanesOf(7)[0]).toMatchObject({ state: 'between', done: 2, failed: 1 });
  });

  test('a test.fail() attempt counts as the run counts it: failed as expected is a pass', () => {
    const lanes = new RunLanes();
    const [failedAsExpected] = lanes.hear(7, completed('failed', { expectedStatus: 'failed' }));
    expect(failedAsExpected).toMatchObject({ done: 1, failed: 0 });
    const annotated = { title: 'refunds', testAnnotations: [{ type: 'fail' }] };
    const [byAnnotation] = lanes.hear(7, completed('failed', annotated));
    expect(byAnnotation).toMatchObject({ done: 2, failed: 0 });
    const [passedUnexpectedly] = lanes.hear(7, completed('passed', { title: 'voids', expectedStatus: 'failed' }));
    expect(passedUnexpectedly).toMatchObject({ done: 3, failed: 1 });
  });

  test('a result without a lane, and a hook’s step, change no lane', () => {
    const lanes = new RunLanes();
    expect(lanes.hear(7, begin({ parallelIndex: null }))).toEqual([]);
    expect(lanes.hear(7, begin({ stepCategory: 'hook' }))).toEqual([]);
    expect(lanes.hear(7, { type: 'step-begin', data: { title: 'click', parallelIndex: 1 } })).toEqual([]);
    expect(lanes.lanesOf(7)).toEqual([]);
  });

  test('the run’s end: every lane done, then let go', () => {
    const lanes = new RunLanes();
    lanes.hear(7, begin());
    lanes.hear(7, begin({ parallelIndex: 0, workerIndex: 3, title: 'adds an item' }));
    const done = lanes.hear(7, { type: 'run-finished', data: { status: 'passed' } });
    expect(done.map((lane) => [lane.id.lane, lane.state])).toEqual([
      [1, 'done'],
      [0, 'done'],
    ]);
    expect(lanes.lanesOf(7)).toEqual([]);
  });

  test('lists a run’s lanes in shard and lane order, and keeps runs apart', () => {
    const lanes = new RunLanes();
    lanes.hear(7, begin({ shardIndex: 2, parallelIndex: 1 }));
    lanes.hear(7, begin({ shardIndex: 1, parallelIndex: 3, workerIndex: 9 }));
    lanes.hear(7, begin({ shardIndex: 2, parallelIndex: 0, workerIndex: 2 }));
    lanes.hear(8, begin());
    expect(lanes.lanesOf(7).map((lane) => [lane.id.shard, lane.id.lane])).toEqual([
      [1, 3],
      [2, 0],
      [2, 1],
    ]);
    lanes.forget(7);
    expect(lanes.lanesOf(7)).toEqual([]);
    expect(lanes.lanesOf(8)).toHaveLength(1);
  });
});

describe('the run event bus', () => {
  test('publishes a lane event after each event that changes a lane, and keeps the lanes for the catch-up', () => {
    const runId = 90_001;
    const heard: RunEvent[] = [];
    const stop = runEventBus.subscribe(runId, (event) => heard.push(event));
    try {
      runEventBus.publish(runId, begin() as Omit<RunEvent, 'seq' | 'timestamp'>);
      runEventBus.publish(runId, { type: 'run-progress', data: { totalTests: 3 } });
      expect(heard.map((event) => event.type)).toEqual(['test-begin', 'lane', 'run-progress']);
      expect(heard[1]!.data).toMatchObject({ id: { run: runId, shard: 2, lane: 1 }, state: 'running' });
      expect(runEventBus.getLanes(runId)).toEqual([heard[1]!.data]);
      runEventBus.cleanup(runId);
      expect(runEventBus.getLanes(runId)).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe('the lanes a run page holds', () => {
  const lanes = new RunLanes();
  const [running] = lanes.hear(7, begin());
  const [stopped] = lanes.hear(7, { type: 'test-stopped', data: { ...begin().data, stop: STOP } });
  const event = (type: string, data: Record<string, unknown> = {}) => ({ type, data, seq: 0 });

  test('holds each lane as its last lane event says it', () => {
    let held: Record<string, Lane> = {};
    held = heldLanes(held, event('lane', { ...running }));
    held = heldLanes(held, event('lane', { ...stopped }));
    expect(Object.values(held)).toEqual([stopped]);
    expect(heldLanes(held, event('test-begin', begin().data))).toBe(held);
    expect(heldLanes(held, event('lane', { state: 'running' }))).toBe(held);
  });

  test('holds none from the start of a catch-up, so a lane the instance no longer keeps gives no stop', () => {
    const held = heldLanes({}, event('lane', { ...stopped }));
    expect(heldLanes(held, event('init', { status: 'running' }))).toEqual({});
  });

  test('holds none once the run ended, its lanes done', () => {
    const held = heldLanes({}, event('lane', { ...stopped }));
    expect(heldLanes(held, event('run-finished', { status: 'passed' }))).toEqual({});
    const [done] = new RunLanes().hear(7, begin()).map((lane) => ({ ...lane, state: 'done' as const }));
    expect(heldLanes(held, event('lane', { ...done }))).toEqual({});
  });
});
