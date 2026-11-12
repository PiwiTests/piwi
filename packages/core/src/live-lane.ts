/**
 * A lane of a running run, as every surface shows it: Playwright's `parallelIndex` in a shard of the run, which the
 * worker Playwright starts in it again after a failure keeps. A lane runs one test at a time and stands in one of the
 * states of `LaneState`; it names the worker in it, its test and attempt, the stop it stands at, the call a Pause waits
 * in, and how many attempts it ended and how many of them failed.
 *
 * The producers reduce: the hub (the editor service, the desktop app's server) from what its workers say on the run
 * channel, the instance from the run's events, each through `reduceLane`, and each sends the lane as it stands to its
 * surfaces, which show it and never work it out themselves. A newcomer gets each lane as it stands (`readLane` reads
 * it back), then the lanes that change.
 *
 * A producer keeps its own shape of a test, a stop and a call (`LaneTestRef`, `LaneStopRef`): the reducer reads their
 * ids alone. The defaults (`LaneTest`, `LaneStop`, `LaneCall`) are the shapes a lane carries on the wire.
 */

/**
 * Where a lane stands: `between` two tests (no worker yet, or one waiting for its next test), `running` a test,
 * `pausing` (a Pause reached it and its test has not stopped yet, or, between two tests, the next test stops at its
 * first call), `stopped` at a call of its test, or `done` once the run ended.
 */
export type LaneState = 'between' | 'running' | 'pausing' | 'stopped' | 'done';

export const LANE_STATES: readonly LaneState[] = ['between', 'running', 'pausing', 'stopped', 'done'];

/** A lane of a run: the run as its producer names it, its shard (null for a run not sharded), its `parallelIndex`. */
export interface LaneId {
  run: string | number;
  shard: number | null;
  lane: number;
}

/** What the reducer reads of a test: its id, the same for each attempt, and which attempt it is (0 for the first). */
export interface LaneTestRef {
  id: string;
  retry: number;
}

/** What the reducer reads of a stop: its id, which its end names. */
export interface LaneStopRef {
  id: string | number;
}

/** A lane's test on the wire: its id, its title and its attempt. */
export interface LaneTest extends LaneTestRef {
  title: string;
}

/**
 * A lane's stop on the wire: its id, why it stopped (a breakpoint, a Pause, a failure, as its producer names it), the
 * call it stands at, and when it stopped (ms since the epoch; null when its producer cannot tell).
 */
export interface LaneStop extends LaneStopRef {
  id: string;
  reason: string;
  title: string;
  since: number | null;
}

/** The call a pausing lane's test waits in before it can stop, and since when it runs (ms; null when unknown). */
export interface LaneCall {
  title: string;
  since: number | null;
}

/** A lane as it stands. */
export interface Lane<T extends LaneTestRef = LaneTest, S extends LaneStopRef = LaneStop, C = LaneCall> {
  id: LaneId;
  state: LaneState;
  /** Playwright's worker index of the latest worker the lane heard from; null before any. */
  worker: number | null;
  /** The test it runs, or stands stopped in; null between two tests. */
  test: T | null;
  /** The stop it stands at; null unless `stopped`. */
  stop: S | null;
  /** While `pausing` with a test, the call that test waits in, once its worker says it; null otherwise. */
  waiting: C | null;
  /** The attempts that ended in the lane, and how many of them failed or timed out. */
  done: number;
  failed: number;
}

/**
 * What a producer hears of a lane. An event naming a worker (`worker`, Playwright's worker index) older than the
 * lane's is a worker that left it, and changes nothing; one naming a newer worker is the worker Playwright started in
 * the lane again, which takes it from its first event, the old one's test, stop and call dropped. An event naming no
 * worker is the lane's worker's. A stop, its end and a test's end may name the attempt they are about (`test`, its id;
 * `retry`): one about another attempt changes nothing but the counts.
 */
export type LaneEvent<T extends LaneTestRef = LaneTest, S extends LaneStopRef = LaneStop, C = LaneCall> =
  /** A worker joined the lane. */
  | { type: 'joined'; worker: number }
  /** The worker left the lane: its test, its stop and its Pause go with it. */
  | { type: 'left'; worker: number }
  /** A test began; `endsPause` when it cannot stop, which ends a Pause waiting for it. */
  | { type: 'test-begin'; worker?: number; test: T; endsPause?: boolean }
  /** A Pause reached the lane. */
  | { type: 'pause'; worker?: number }
  /** The Pause ended with no stop: its call was given up, and the test goes on to its end. */
  | { type: 'pause-ended'; worker?: number }
  /** The call the pausing test waits in, or null once it waits in none. */
  | { type: 'waiting'; worker?: number; call: C | null }
  | { type: 'stopped'; worker?: number; test?: string; retry?: number; stop: S }
  /** The stop `stop` names (any, when it names none) ended: the test goes on. */
  | { type: 'resumed'; worker?: number; test?: string; retry?: number; stop?: S['id'] }
  /** An attempt ended, with Playwright's status (`passed`, `failed`, `timedOut`, `skipped`, `interrupted`). */
  | { type: 'test-end'; worker?: number; test: string; retry?: number; status: string }
  /** The run ended: the lane is done. */
  | { type: 'run-end' };

/** The statuses of an attempt that failed: Playwright's, and the dashboard's lower-case `timedout`. */
const FAILED: ReadonlySet<string> = new Set(['failed', 'timedOut', 'timedout']);

/** A lane nothing was heard of yet. */
export function emptyLane<T extends LaneTestRef = LaneTest, S extends LaneStopRef = LaneStop, C = LaneCall>(
  id: LaneId,
): Lane<T, S, C> {
  return { id: { ...id }, state: 'between', worker: null, test: null, stop: null, waiting: null, done: 0, failed: 0 };
}

/** A lane's key among the lanes of every run its producer keeps: its run, its shard and its lane. */
export function laneKey(id: LaneId): string {
  return `${encodeURIComponent(id.run)}|${id.shard ?? ''}|${id.lane}`;
}

/** The lane after `event`: the same object when nothing changed. Pure. */
export function reduceLane<T extends LaneTestRef, S extends LaneStopRef, C>(
  lane: Lane<T, S, C>,
  event: LaneEvent<T, S, C>,
): Lane<T, S, C> {
  if (lane.state === 'done') return lane;
  if (event.type === 'run-end') return { ...lane, state: 'done', test: null, stop: null, waiting: null };
  let at = lane;
  if (event.worker !== undefined && event.worker !== lane.worker) {
    if (lane.worker !== null && event.worker < lane.worker) return lane;
    // A worker that leaves has nothing of a lane it was not in yet.
    if (event.type === 'left') return lane;
    at = { ...lane, state: 'between', worker: event.worker, test: null, stop: null, waiting: null };
  }
  const pausing = at.state === 'pausing';
  switch (event.type) {
    case 'joined':
      return at;
    case 'left':
      return settled({ ...at, test: null, stop: null, waiting: null }, false);
    case 'test-begin':
      return settled({ ...at, test: event.test, stop: null, waiting: null }, pausing && !event.endsPause);
    case 'pause':
      return at.stop || pausing ? at : settled(at, true);
    case 'pause-ended':
      return pausing ? settled({ ...at, waiting: null }, false) : at;
    case 'waiting':
      if (event.call === null) return at.waiting === null ? at : { ...at, waiting: null };
      return pausing && at.test ? { ...at, waiting: event.call } : at;
    case 'stopped':
      if (!isAttempt(at, event)) return at;
      return settled({ ...at, stop: event.stop, waiting: null }, false);
    case 'resumed':
      if (!at.stop || !isAttempt(at, event) || (event.stop !== undefined && event.stop !== at.stop.id)) return at;
      return settled({ ...at, stop: null }, false);
    case 'test-end': {
      const counted = { ...at, done: at.done + 1, failed: at.failed + (FAILED.has(event.status) ? 1 : 0) };
      if (at.test && !isAttempt(at, event)) return counted;
      return settled({ ...counted, test: null, stop: null, waiting: null }, pausing);
    }
  }
}

/** A lane after `events`, from a lane nothing was heard of: what a newcomer given the lane as it stands holds. */
export function laneOf<T extends LaneTestRef = LaneTest, S extends LaneStopRef = LaneStop, C = LaneCall>(
  id: LaneId,
  events: readonly LaneEvent<T, S, C>[],
): Lane<T, S, C> {
  return events.reduce<Lane<T, S, C>>(reduceLane, emptyLane<T, S, C>(id));
}

/** Whether an event names the attempt the lane runs, or none. */
function isAttempt(lane: Lane<LaneTestRef, LaneStopRef, unknown>, event: { test?: string; retry?: number }): boolean {
  if (event.test !== undefined && lane.test?.id !== event.test) return false;
  return event.retry === undefined || lane.test?.retry === event.retry;
}

/** The lane's state from where it stands: its stop, a Pause waiting, its test. */
function settled<L extends Lane<LaneTestRef, LaneStopRef, unknown>>(lane: L, pausing: boolean): L {
  const state: LaneState = lane.stop ? 'stopped' : pausing ? 'pausing' : lane.test ? 'running' : 'between';
  return lane.state === state ? lane : { ...lane, state };
}

// ── Reading a lane from the wire ─────────────────────────────────────────────

/** The longest title a lane's test, stop or call keeps: a longer one is cut. */
const MAX_LANE_TITLE = 1000;
/** The longest id a lane's run, test or stop keeps: a longer one does not read. */
const MAX_LANE_ID = 2000;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_LANE_ID;
}

function isTime(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function readTest(value: unknown): LaneTest | null {
  if (!isObject(value) || !isId(value.id) || typeof value.title !== 'string' || !isCount(value.retry)) return null;
  return { id: value.id, title: value.title.slice(0, MAX_LANE_TITLE), retry: value.retry };
}

function readStop(value: unknown): LaneStop | null {
  if (!isObject(value) || !isId(value.id) || typeof value.reason !== 'string') return null;
  if (typeof value.title !== 'string' || !isTime(value.since)) return null;
  return {
    id: value.id,
    reason: value.reason.slice(0, 64),
    title: value.title.slice(0, MAX_LANE_TITLE),
    since: value.since,
  };
}

function readCall(value: unknown): LaneCall | null {
  if (!isObject(value) || typeof value.title !== 'string' || !isTime(value.since)) return null;
  return { title: value.title.slice(0, MAX_LANE_TITLE), since: value.since };
}

/**
 * A lane as its producer sent it, rebuilt field by field, or null when it does not read: an unknown state reads as
 * `running`, and a test, a stop or a call that does not read as none.
 */
export function readLane(value: unknown): Lane | null {
  if (!isObject(value) || !isObject(value.id)) return null;
  const { run, shard, lane } = value.id;
  if (!(isId(run) || (typeof run === 'number' && Number.isFinite(run))) || !isCount(lane)) return null;
  if (shard !== null && !isCount(shard)) return null;
  if (value.worker !== null && !isCount(value.worker)) return null;
  if (!isCount(value.done) || !isCount(value.failed)) return null;
  const state = LANE_STATES.find((known) => known === value.state) ?? 'running';
  return {
    id: { run, shard, lane },
    state,
    worker: value.worker,
    test: readTest(value.test),
    stop: readStop(value.stop),
    waiting: readCall(value.waiting),
    done: value.done,
    failed: value.failed,
  };
}
