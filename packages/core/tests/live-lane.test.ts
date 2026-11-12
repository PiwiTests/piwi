import { describe, expect, test } from 'vitest';
import {
  LANE_STATES,
  emptyLane,
  laneKey,
  laneOf,
  readLane,
  reduceLane,
  type Lane,
  type LaneEvent,
  type LaneId,
  type LaneStop,
  type LaneTest,
} from '../src/live-lane';

const ID: LaneId = { run: 78, shard: 2, lane: 1 };

function aTest(id: string, retry = 0): LaneTest {
  return { id, title: `${id} works`, retry };
}

function aStop(id: string, reason = 'breakpoint'): LaneStop {
  return { id, reason, title: `click ${id}`, since: 1_700_000_000_000 };
}

describe('a lane', () => {
  test('starts between two tests, with no worker and nothing counted', () => {
    expect(emptyLane(ID)).toEqual({
      id: ID,
      state: 'between',
      worker: null,
      test: null,
      stop: null,
      waiting: null,
      done: 0,
      failed: 0,
    });
  });

  test('is keyed by its run, its shard and its lane', () => {
    expect(laneKey(ID)).toBe('78|2|1');
    expect(laneKey({ run: 'ed-1', shard: null, lane: 0 })).toBe('ed-1||0');
    expect(laneKey({ run: 'a|b', shard: null, lane: 0 })).not.toBe(laneKey({ run: 'a', shard: null, lane: 0 }));
  });

  test('names every state a surface shows', () => {
    expect(LANE_STATES).toEqual(['between', 'running', 'pausing', 'stopped', 'done']);
  });
});

describe('reduceLane', () => {
  test('a worker joins, runs a test, and ends it: running, then between, one done', () => {
    const joined = reduceLane(emptyLane(ID), { type: 'joined', worker: 4 });
    expect(joined).toMatchObject({ state: 'between', worker: 4, test: null });
    const running = reduceLane(joined, { type: 'test-begin', worker: 4, test: aTest('a') });
    expect(running).toMatchObject({ state: 'running', worker: 4, test: aTest('a') });
    const ended = reduceLane(running, { type: 'test-end', worker: 4, test: 'a', status: 'passed' });
    expect(ended).toMatchObject({ state: 'between', test: null, done: 1, failed: 0 });
  });

  test('a test that fails or times out counts as failed; a skip or an interruption as done alone', () => {
    let lane = emptyLane(ID);
    for (const status of ['failed', 'timedOut', 'timedout', 'skipped', 'interrupted', 'passed']) {
      lane = reduceLane(lane, { type: 'test-begin', test: aTest(status) });
      lane = reduceLane(lane, { type: 'test-end', test: status, status });
    }
    expect(lane).toMatchObject({ done: 6, failed: 3, state: 'between' });
  });

  test('a stop, and its end: stopped, then running again', () => {
    let lane = laneOf(ID, [
      { type: 'joined', worker: 1 },
      { type: 'test-begin', worker: 1, test: aTest('a') },
    ]);
    lane = reduceLane(lane, { type: 'stopped', worker: 1, stop: aStop('s1') });
    expect(lane).toMatchObject({ state: 'stopped', stop: aStop('s1'), test: aTest('a') });
    // Another stop's end leaves it standing.
    expect(reduceLane(lane, { type: 'resumed', worker: 1, stop: 's0' })).toBe(lane);
    lane = reduceLane(lane, { type: 'resumed', worker: 1, stop: 's1' });
    expect(lane).toMatchObject({ state: 'running', stop: null });
    // An end that names no stop ends any.
    lane = reduceLane(lane, { type: 'stopped', worker: 1, stop: aStop('s2') });
    expect(reduceLane(lane, { type: 'resumed', worker: 1 })).toMatchObject({ state: 'running', stop: null });
  });

  test('a stop or its end about another attempt leaves the lane as it is', () => {
    const lane = laneOf(ID, [{ type: 'test-begin', test: aTest('a', 1) }]);
    expect(reduceLane(lane, { type: 'stopped', test: 'a', retry: 0, stop: aStop('s') })).toBe(lane);
    expect(reduceLane(lane, { type: 'stopped', test: 'b', stop: aStop('s') })).toBe(lane);
    const stopped = reduceLane(lane, { type: 'stopped', test: 'a', retry: 1, stop: aStop('s') });
    expect(stopped.state).toBe('stopped');
    expect(reduceLane(stopped, { type: 'resumed', test: 'a', retry: 0 })).toBe(stopped);
    expect(reduceLane(stopped, { type: 'resumed', test: 'a', retry: 1 }).state).toBe('running');
  });

  test('a Pause: pausing, the call it waits in, then the stop it comes to', () => {
    let lane = laneOf(ID, [{ type: 'test-begin', worker: 0, test: aTest('a') }]);
    lane = reduceLane(lane, { type: 'pause', worker: 0 });
    expect(lane).toMatchObject({ state: 'pausing', test: aTest('a'), waiting: null });
    lane = reduceLane(lane, { type: 'waiting', worker: 0, call: { title: 'click Pay', since: 5 } });
    expect(lane).toMatchObject({ state: 'pausing', waiting: { title: 'click Pay', since: 5 } });
    lane = reduceLane(lane, { type: 'waiting', worker: 0, call: null });
    expect(lane).toMatchObject({ state: 'pausing', waiting: null });
    lane = reduceLane(lane, { type: 'waiting', worker: 0, call: { title: 'click Pay', since: 5 } });
    lane = reduceLane(lane, { type: 'stopped', worker: 0, stop: aStop('p', 'pause') });
    expect(lane).toMatchObject({ state: 'stopped', waiting: null });
    expect(reduceLane(lane, { type: 'resumed', worker: 0 })).toMatchObject({ state: 'running' });
  });

  test('a call a lane waits in is heard only while a Pause waits for its test', () => {
    const call = { title: 'click Pay', since: null };
    const running = laneOf(ID, [{ type: 'test-begin', test: aTest('a') }]);
    expect(reduceLane(running, { type: 'waiting', call })).toBe(running);
    const between = reduceLane(emptyLane(ID), { type: 'pause' });
    expect(between.state).toBe('pausing');
    expect(reduceLane(between, { type: 'waiting', call })).toBe(between);
  });

  test('a Pause between two tests waits for the next test, unless that test cannot stop', () => {
    const pausing = reduceLane(emptyLane(ID), { type: 'pause' });
    expect(pausing).toMatchObject({ state: 'pausing', test: null });
    expect(reduceLane(pausing, { type: 'test-begin', test: aTest('a') })).toMatchObject({
      state: 'pausing',
      test: aTest('a'),
    });
    expect(reduceLane(pausing, { type: 'test-begin', test: aTest('a'), endsPause: true })).toMatchObject({
      state: 'running',
    });
  });

  test('a Pause that ends with no stop (the call given up) leaves the test running', () => {
    let lane = laneOf(ID, [
      { type: 'test-begin', test: aTest('a') },
      { type: 'pause' },
      { type: 'waiting', call: { title: 'click Pay', since: null } },
    ]);
    lane = reduceLane(lane, { type: 'pause-ended' });
    expect(lane).toMatchObject({ state: 'running', waiting: null });
  });

  test('a Pause still waiting as its test ends waits for the next test', () => {
    const lane = laneOf(ID, [
      { type: 'test-begin', test: aTest('a') },
      { type: 'pause' },
      { type: 'test-end', test: 'a', status: 'passed' },
    ]);
    expect(lane).toMatchObject({ state: 'pausing', test: null, done: 1 });
  });

  test('a Pause reaching a stopped lane leaves it stopped', () => {
    const lane = laneOf(ID, [
      { type: 'test-begin', test: aTest('a') },
      { type: 'stopped', stop: aStop('s') },
    ]);
    expect(reduceLane(lane, { type: 'pause' })).toBe(lane);
  });

  test('a test that ends at a stop leaves the lane between tests, the stop gone', () => {
    const lane = laneOf(ID, [
      { type: 'test-begin', test: aTest('a') },
      { type: 'stopped', stop: aStop('s') },
      { type: 'test-end', test: 'a', status: 'skipped' },
    ]);
    expect(lane).toMatchObject({ state: 'between', stop: null, test: null, done: 1 });
  });

  test('a retry: the attempt that failed counts, the next one runs in the lane', () => {
    const lane = laneOf(ID, [
      { type: 'test-begin', worker: 1, test: aTest('a', 0) },
      { type: 'test-end', worker: 1, test: 'a', retry: 0, status: 'failed' },
      { type: 'left', worker: 1 },
      { type: 'joined', worker: 2 },
      { type: 'test-begin', worker: 2, test: aTest('a', 1) },
    ]);
    expect(lane).toMatchObject({ state: 'running', worker: 2, test: aTest('a', 1), done: 1, failed: 1 });
    const passed = reduceLane(lane, { type: 'test-end', worker: 2, test: 'a', retry: 1, status: 'passed' });
    expect(passed).toMatchObject({ state: 'between', done: 2, failed: 1 });
  });

  test('the end of an earlier attempt, heard after the next began, counts and leaves the running attempt', () => {
    const lane = laneOf(ID, [
      { type: 'test-begin', test: aTest('a', 1) },
      { type: 'test-end', test: 'a', retry: 0, status: 'failed' },
    ]);
    expect(lane).toMatchObject({ state: 'running', test: aTest('a', 1), done: 1, failed: 1 });
  });

  test('a worker that restarts: the new one takes the lane, the old one’s test and stop dropped', () => {
    const before = laneOf(ID, [
      { type: 'joined', worker: 3 },
      { type: 'test-begin', worker: 3, test: aTest('a') },
      { type: 'stopped', worker: 3, stop: aStop('s') },
    ]);
    const restarted = reduceLane(before, { type: 'test-begin', worker: 5, test: aTest('b') });
    expect(restarted).toMatchObject({ state: 'running', worker: 5, test: aTest('b'), stop: null });
    // What the old worker says late is not the lane's any more.
    expect(reduceLane(restarted, { type: 'test-end', worker: 3, test: 'a', status: 'failed' })).toBe(restarted);
    expect(reduceLane(restarted, { type: 'left', worker: 3 })).toBe(restarted);
    expect(reduceLane(restarted, { type: 'stopped', worker: 3, stop: aStop('t') })).toBe(restarted);
  });

  test('a worker that leaves mid-test: the lane waits between tests for the next one', () => {
    const lane = laneOf(ID, [
      { type: 'joined', worker: 3 },
      { type: 'test-begin', worker: 3, test: aTest('a') },
      { type: 'pause', worker: 3 },
      { type: 'left', worker: 3 },
    ]);
    expect(lane).toMatchObject({ state: 'between', worker: 3, test: null, stop: null, waiting: null });
    expect(reduceLane(lane, { type: 'joined', worker: 4 })).toMatchObject({ state: 'between', worker: 4 });
  });

  test('the same worker joining again keeps what it runs', () => {
    const lane = laneOf(ID, [
      { type: 'joined', worker: 3 },
      { type: 'test-begin', worker: 3, test: aTest('a') },
    ]);
    expect(reduceLane(lane, { type: 'joined', worker: 3 })).toBe(lane);
  });

  test('an event that names no worker is the lane’s worker’s', () => {
    const lane = laneOf(ID, [
      { type: 'joined', worker: 3 },
      { type: 'test-begin', test: aTest('a') },
    ]);
    expect(lane).toMatchObject({ worker: 3, state: 'running' });
  });

  test('the run’s end: done, and nothing after it changes the lane', () => {
    const done = laneOf(ID, [
      { type: 'test-begin', worker: 1, test: aTest('a') },
      { type: 'test-end', worker: 1, test: 'a', status: 'passed' },
      { type: 'test-begin', worker: 1, test: aTest('b') },
      { type: 'run-end' },
    ]);
    expect(done).toMatchObject({ state: 'done', test: null, stop: null, waiting: null, done: 1, worker: 1 });
    for (const event of [
      { type: 'joined', worker: 9 },
      { type: 'test-begin', worker: 9, test: aTest('c') },
      { type: 'pause' },
      { type: 'run-end' },
    ] satisfies LaneEvent[]) {
      expect(reduceLane(done, event)).toBe(done);
    }
  });

  test('is pure: the lane it is given stays as it was', () => {
    const lane = laneOf(ID, [{ type: 'test-begin', test: aTest('a') }]);
    const copy = structuredClone(lane);
    reduceLane(lane, { type: 'stopped', stop: aStop('s') });
    reduceLane(lane, { type: 'test-end', test: 'a', status: 'failed' });
    expect(lane).toEqual(copy);
  });

  test('keeps the producer’s own test and stop shapes, read by their ids', () => {
    interface HeldStop {
      id: number;
      place: string;
    }
    interface OwnTest {
      id: string;
      retry: number;
      title: string[];
    }
    const lane = laneOf<OwnTest, HeldStop, string>({ run: 'ed-1', shard: null, lane: 0 }, [
      { type: 'test-begin', worker: 0, test: { id: 't', retry: 0, title: ['cart', 'adds'] } },
      { type: 'stopped', worker: 0, stop: { id: 7, place: 'cart.spec.ts:3' } },
    ]);
    expect(lane.stop).toEqual({ id: 7, place: 'cart.spec.ts:3' });
    expect(reduceLane(lane, { type: 'resumed', worker: 0, stop: 6 })).toBe(lane);
    expect(reduceLane(lane, { type: 'resumed', worker: 0, stop: 7 }).state).toBe('running');
  });
});

describe('replay to a newcomer', () => {
  /** A run of one lane: a worker that fails a test, restarts, is paused, stops, goes on, and the run ends. */
  const EVENTS: LaneEvent[] = [
    { type: 'joined', worker: 0 },
    { type: 'test-begin', worker: 0, test: aTest('a') },
    { type: 'test-end', worker: 0, test: 'a', status: 'failed' },
    { type: 'left', worker: 0 },
    { type: 'joined', worker: 1 },
    { type: 'test-begin', worker: 1, test: aTest('a', 1) },
    { type: 'pause', worker: 1 },
    { type: 'waiting', worker: 1, call: { title: 'fill Name', since: 12 } },
    { type: 'stopped', worker: 1, stop: aStop('s') },
    { type: 'resumed', worker: 1, stop: 's' },
    { type: 'test-end', worker: 1, test: 'a', retry: 1, status: 'passed' },
    { type: 'test-begin', worker: 1, test: aTest('b') },
    { type: 'run-end' },
  ];

  test('a newcomer given the lane as it stands, read from its wire form, reaches the same state as one that heard everything', () => {
    const whole = laneOf(ID, EVENTS);
    for (let at = 0; at <= EVENTS.length; at++) {
      const sent = readLane(JSON.parse(JSON.stringify(laneOf(ID, EVENTS.slice(0, at)))));
      expect(sent).not.toBeNull();
      expect(EVENTS.slice(at).reduce(reduceLane, sent!), `joined after ${at} events`).toEqual(whole);
    }
  });

  test('each state along the way reads back as it was sent', () => {
    const seen = new Set<string>();
    let lane: Lane = emptyLane(ID);
    for (const event of EVENTS) {
      lane = reduceLane(lane, event);
      seen.add(lane.state);
      expect(readLane(JSON.parse(JSON.stringify(lane)))).toEqual(lane);
    }
    expect([...seen].sort()).toEqual([...LANE_STATES].sort());
  });
});

describe('readLane', () => {
  const lane = laneOf(ID, [
    { type: 'test-begin', worker: 2, test: aTest('a') },
    { type: 'stopped', worker: 2, stop: aStop('s') },
  ]);

  test('reads a lane field by field, leaving out what it does not know', () => {
    expect(readLane({ ...lane, extra: 1, test: { ...lane.test, extra: 2 } })).toEqual(lane);
  });

  test('reads an unknown state as running, so a newer producer’s lane still shows', () => {
    expect(readLane({ ...lane, state: 'dreaming' })?.state).toBe('running');
  });

  test('refuses what is not a lane', () => {
    for (const value of [
      null,
      'lane',
      [],
      { ...lane, id: null },
      { ...lane, id: { ...ID, lane: -1 } },
      { ...lane, id: { ...ID, shard: 'x' } },
      { ...lane, id: { ...ID, run: {} } },
      { ...lane, done: -1 },
      { ...lane, failed: 1.5 },
      { ...lane, worker: 'w' },
    ]) {
      expect(readLane(value)).toBeNull();
    }
  });

  test('drops a test, a stop or a call that does not read, the lane kept', () => {
    expect(readLane({ ...lane, test: { id: 1 } })?.test).toBeNull();
    expect(readLane({ ...lane, stop: { id: 's', reason: 2 } })?.stop).toBeNull();
    expect(readLane({ ...lane, waiting: { title: null } })?.waiting).toBeNull();
  });

  test('cuts a title to what a surface shows', () => {
    const long = 'x'.repeat(5_000);
    const read = readLane({ ...lane, test: { ...lane.test, title: long }, stop: { ...lane.stop, title: long } });
    expect(read?.test?.title.length).toBe(1000);
    expect(read?.stop?.title.length).toBe(1000);
  });
});
