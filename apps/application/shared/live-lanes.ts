/**
 * The lanes of each live run, as the instance keeps them (`@piwitests/core/live-lane`): reduced from the run's own
 * events as they are published (a test's begin and end, a stop and its end, a worker of the live view connecting,
 * stopping, going on or leaving, the run's end), and published as `lane` events, which a page that opens later gets
 * in the stream's catch-up. The server's event bus and the demo's both keep them, so both send the same lanes.
 *
 * A lane is a shard's `parallelIndex`: an event of a reporter that does not say it changes no lane. A stop comes from
 * the reporter (`test-stopped`, outside CI) and from the live view (`live-worker`'s `paused`); the live view's ends as
 * its worker goes on or leaves the view.
 */
import {
  emptyLane,
  laneKey,
  readLane,
  reduceLane,
  type Lane,
  type LaneEvent,
  type LaneId,
} from '@piwitests/core/live-lane';
import { resolveExpectedStatus } from '@piwitests/core/status-classify';

export type { Lane } from '@piwitests/core/live-lane';

/** A run event, as the bus publishes it. */
interface PublishedEvent {
  type: string;
  data: Record<string, unknown>;
}

/** The id of a stop the live view says, apart from the reporter's (`test-stopped`). */
const VIEW_STOP = 'view:';

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A test's id in its lane: its title, its place, its browser and its repetition, the same for each attempt. */
export function laneTestId(data: Record<string, unknown>): string {
  return JSON.stringify([data.title, data.location ?? null, data.browser ?? null, count(data.repeatEachIndex) ?? 0]);
}

/** The lane an event is about, from a reporter that says it; null otherwise, and for a hook's or a fixture's step. */
function laneOfEvent(runId: number, event: PublishedEvent): LaneId | null {
  const { data } = event;
  if (event.type === 'live-worker') {
    const lane = count(data.slot);
    return lane === undefined ? null : { run: runId, shard: count(data.shard) ?? null, lane };
  }
  const lane = count(data.parallelIndex);
  if (lane === undefined || data.stepCategory || typeof data.title !== 'string') return null;
  return { run: runId, shard: count(data.shardIndex) ?? null, lane };
}

/** What a run event says of its lane, read against the lane as it stands; null for nothing. */
function laneEventOf(event: PublishedEvent, lane: Lane): LaneEvent | null {
  const { data } = event;
  switch (event.type) {
    case 'test-begin':
      return {
        type: 'test-begin',
        worker: count(data.workerIndex),
        test: { id: laneTestId(data), title: data.title as string, retry: count(data.retries) ?? 0 },
      };
    case 'test-completed':
      return {
        type: 'test-end',
        worker: count(data.workerIndex),
        test: laneTestId(data),
        retry: count(data.retries),
        status: typeof data.status === 'string' ? data.status : 'passed',
        expected: resolveExpectedStatus(data.expectedStatus, data.testAnnotations),
      };
    case 'test-stopped': {
      const stop = data.stop as { reason?: unknown; title?: unknown; since?: unknown } | null | undefined;
      if (!stop || typeof stop.reason !== 'string') return null;
      const since = count(stop.since) ?? null;
      return {
        type: 'stopped',
        worker: count(data.workerIndex),
        test: laneTestId(data),
        retry: count(data.retries),
        stop: {
          id: `stop:${since ?? ''}`,
          reason: stop.reason,
          title: typeof stop.title === 'string' ? stop.title : '',
          since,
        },
      };
    }
    case 'test-resumed':
      return { type: 'resumed', worker: count(data.workerIndex), test: laneTestId(data), retry: count(data.retries) };
    case 'live-worker': {
      const worker = count(data.worker);
      if (worker === undefined) return null;
      const paused = data.paused as { reason?: unknown; call?: { title?: unknown } } | null | undefined;
      if (data.connected === true && paused && typeof paused.reason === 'string') {
        const title = typeof paused.call?.title === 'string' ? paused.call.title : '';
        const stop = { id: `${VIEW_STOP}${paused.reason}:${title}`, reason: paused.reason, title, since: null };
        return lane.stop?.id === stop.id ? null : { type: 'stopped', worker, stop };
      }
      // The live view's stop ends as its worker goes on or leaves the view.
      if (lane.stop?.id.startsWith(VIEW_STOP)) return { type: 'resumed', worker, stop: lane.stop.id };
      return data.connected === true ? { type: 'joined', worker } : null;
    }
  }
  return null;
}

/** The lanes of every live run a producer keeps. */
export class RunLanes {
  private readonly runs = new Map<number, Map<string, Lane>>();
  /** Each live run's attempts whose end its lanes counted, so a batch the reporter sends again counts none twice. */
  private readonly ended = new Map<number, Set<string>>();

  /** Hear a run event as it is published: the lanes it changed, as they stand now. */
  hear(runId: number, event: PublishedEvent): Lane[] {
    const lanes = this.runs.get(runId);
    if (event.type === 'run-finished') {
      this.forget(runId);
      return [...(lanes?.values() ?? [])].flatMap((lane) => {
        const done = reduceLane(lane, { type: 'run-end' });
        return done === lane ? [] : [done];
      });
    }
    const id = laneOfEvent(runId, event);
    if (!id) return [];
    const key = laneKey(id);
    const lane = lanes?.get(key) ?? emptyLane(id);
    const said = laneEventOf(event, lane);
    if (!said || this.endedBefore(runId, key, said)) return [];
    const next = reduceLane(lane, said);
    if (next === lane && lanes?.has(key)) return [];
    const kept = lanes ?? new Map<string, Lane>();
    kept.set(key, next);
    this.runs.set(runId, kept);
    return [next];
  }

  /** The lanes of a live run as they stand, in shard and lane order. */
  lanesOf(runId: number): Lane[] {
    return [...(this.runs.get(runId)?.values() ?? [])].sort(
      (a, b) => (a.id.shard ?? 0) - (b.id.shard ?? 0) || a.id.lane - b.id.lane,
    );
  }

  /** Let go of a run's lanes. */
  forget(runId: number): void {
    this.runs.delete(runId);
    this.ended.delete(runId);
  }

  /** Whether `said` ends an attempt of the lane `key` whose end was heard already; notes its end otherwise. */
  private endedBefore(runId: number, key: string, said: LaneEvent): boolean {
    if (said.type !== 'test-end' || said.retry === undefined) return false;
    const attempt = JSON.stringify([key, said.test, said.retry]);
    const ended = this.ended.get(runId) ?? new Set<string>();
    if (ended.has(attempt)) return true;
    ended.add(attempt);
    this.ended.set(runId, ended);
    return false;
  }
}

/**
 * The lanes a page of a live run holds, by `laneKey`, after an event of the run's stream: each lane as its last `lane`
 * event says it, and none from an `init` (the first event of each connection's catch-up, after which the catch-up
 * sends the lanes the instance keeps) or once the run ended (`run-finished`, a `done` lane). The same object when the
 * event changes none.
 */
export function heldLanes(
  lanes: Record<string, Lane>,
  event: { type?: unknown; data?: unknown },
): Record<string, Lane> {
  if (event.type === 'init' || event.type === 'run-finished') return Object.keys(lanes).length ? {} : lanes;
  const lane = event.type === 'lane' ? readLane(event.data) : null;
  if (!lane) return lanes;
  const key = laneKey(lane.id);
  if (lane.state !== 'done') return { ...lanes, [key]: lane };
  if (!(key in lanes)) return lanes;
  const { [key]: _done, ...held } = lanes;
  return held;
}
