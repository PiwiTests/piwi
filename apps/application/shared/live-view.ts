/**
 * What the run page reads of a live run's live view: whether the run holds a key (`live-view`), each connected worker's
 * state, which the run's event stream carries (`live-worker`), and the messages of one worker's view (`/api/test-runs/:id/live-view/watch`). The worker's
 * side of the protocol is `@piwitests/core/live-view`.
 */
import {
  isEpochMs,
  readLiveCall,
  readLiveCallLog,
  readLiveTestOutcome,
  readLiveTestTitle,
  type LiveCall,
  type LiveCallLog,
  type LiveStop,
  type LiveTestOutcome,
  type LiveWorkerId,
} from '@piwitests/core/live-view';

export {
  liveWorkerKey,
  type LiveCall,
  type LiveCallLog,
  type LiveStop,
  type LiveTestOutcome,
} from '@piwitests/core/live-view';

/**
 * A worker of a live run as the run page knows it: its lane (`slot`, from a reporter that says it), whether it is
 * connected, and its test's stop while it holds.
 */
export interface LiveWorkerState {
  shard: number | null;
  worker: number;
  slot?: number;
  connected: boolean;
  paused: LiveStop | null;
}

/**
 * Whether a live run holds a live view key on the instance, as its event stream says it (`live-view`): its project's
 * live view applies to it. A CI run's workers stream with it at once; those of a run outside CI only once its
 * developer shares it, so until then the run page says how (**Not shared live**), and offers **Ask to watch** to a
 * viewer who may ask (`canAsk`), with their latest ask (`ask`).
 */
export interface LiveViewRunState {
  keyed: boolean;
  /** Whether the project's live view is on now: off, the run page says so whatever the run holds. */
  enabled: boolean;
  /**
   * Whether this viewer may ask the run's developer to share it: a signed-in person, in a project that takes asks to
   * watch, of a running run outside CI that holds a key. The run's stream sets it for each viewer.
   */
  canAsk?: boolean;
  /** This viewer's latest ask to watch the run, null for none. The run's stream sets it for each viewer. */
  ask?: LiveAskView | null;
}

/**
 * A person's latest ask to watch a run that is not shared live (**Ask to watch**), as their run page shows it: in
 * `ask` of the run stream's `live-view` event, and in its `live-ask` event as it changes, which only the person who
 * asked hears.
 */
export interface LiveAskView {
  id: string;
  /** Who asked, as the developer reads it. */
  by: string;
  /** The developer's answer: none yet, `not-now`, or `shared` once a worker of the run streams. */
  answer: 'not-now' | 'shared' | null;
  /** How long before this person may ask again, in milliseconds, when the view was sent: 0 when they may now. */
  waitMs: number;
}

/**
 * Whether a run is one CI runs, whose workers stream as soon as the run holds a key: the reporter recorded the CI
 * that runs it (`metadata.ci`). Any other run streams only once its developer shares it.
 */
export function isCiRun(metadata: unknown): boolean {
  const ci = metadata && typeof metadata === 'object' ? (metadata as { ci?: unknown }).ci : null;
  return !!ci;
}

/**
 * How the run page names a worker: by its lane, counted from 1 (`worker 2`), which a worker Playwright starts again
 * after a failure keeps, else by its index from a reporter that does not say its lane; and its shard in a sharded run.
 */
export function liveWorkerName(id: LiveWorkerId): string {
  const name = id.slot === undefined ? `worker ${id.worker}` : `worker ${id.slot + 1}`;
  return id.shard === null ? name : `${name} of shard ${id.shard}`;
}

/** A worker's lane in a run: its shard (null when the run is not sharded) and its slot, Playwright's `parallelIndex`. */
export interface LiveLane {
  shard: number | null;
  slot: number;
}

/**
 * The `?watch=` value of the run page's address that opens the live view of a lane: the worker's number as the page
 * names it (`2` for worker 2), after its shard in a sharded run (`3.2` for worker 2 of shard 3).
 */
export function liveWatchAddress(lane: LiveLane): string {
  return lane.shard === null ? String(lane.slot + 1) : `${lane.shard}.${lane.slot + 1}`;
}

/** The lane a `?watch=` value names, or null when it names none. */
export function parseLiveWatchAddress(value: unknown): LiveLane | null {
  if (typeof value !== 'string') return null;
  const match = /^(?:(\d{1,4})\.)?(\d{1,5})$/.exec(value.trim());
  if (!match) return null;
  const shard = match[1] === undefined ? null : Number(match[1]);
  const number = Number(match[2]);
  if (number < 1 || number > 10_000 || (shard !== null && shard < 1)) return null;
  return { shard, slot: number - 1 };
}

/**
 * Why a view ended: its test ended, its worker left, the run ended, the project's live view was turned off, the person
 * who watched it opened a further one of the run, past their share, in its place (`replaced`), or the developer who
 * shared the run from their machine stopped sharing it (`unshared`).
 */
export type LiveViewEnd = 'test-ended' | 'worker-left' | 'run-ended' | 'off' | 'replaced' | 'unshared';

/** A message of one worker's view, to the person watching it. */
export type LiveViewerMessage =
  /**
   * A frame of the test's page, a JPEG in base64, the call it was taken at, the title of its test and, from a reporter
   * that says it, when the page looked so, in epoch milliseconds (`at`): the browser's paint time, at most the worker's
   * clock.
   */
  | { type: 'frame'; data: string; call: LiveCall | null; test: string | null; at?: number }
  /** The call the test is in, as Playwright logs it, in a CI run, and the title of its test. */
  | { type: 'call-log'; log: LiveCallLog; test: string | null }
  /** Why no frame shows now. */
  | { type: 'refused'; message: string }
  /** The test ended, how when its worker says (`outcome`): a view that follows the worker's lane stays for the next. */
  | { type: 'test-ended'; outcome: LiveTestOutcome | null }
  /** The view ended, with how its test ended when that is why: the stream closes after it. */
  | { type: 'end'; reason: LiveViewEnd; outcome?: LiveTestOutcome | null };

const ENDS: readonly string[] = ['test-ended', 'worker-left', 'run-ended', 'off', 'replaced', 'unshared'];

/** A message of a view's stream (the `data` of one event); null when it is not one. */
export function parseLiveViewerMessage(data: string): LiveViewerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'frame':
      if (typeof message.data !== 'string' || !message.data) return null;
      return {
        type: 'frame',
        data: message.data,
        call: message.call ? readLiveCall(message.call) : null,
        test: readLiveTestTitle(message.test),
        ...(isEpochMs(message.at) ? { at: message.at } : {}),
      };
    case 'call-log': {
      const log = readLiveCallLog(message.log);
      return log ? { type: 'call-log', log, test: readLiveTestTitle(message.test) } : null;
    }
    case 'refused':
      return typeof message.message === 'string' ? { type: 'refused', message: message.message.slice(0, 500) } : null;
    case 'test-ended':
      return { type: 'test-ended', outcome: readLiveTestOutcome(message.outcome) };
    case 'end': {
      if (!ENDS.includes(message.reason as string)) return null;
      const outcome = readLiveTestOutcome(message.outcome);
      return outcome
        ? { type: 'end', reason: message.reason as LiveViewEnd, outcome }
        : { type: 'end', reason: message.reason as LiveViewEnd };
    }
    default:
      return null;
  }
}

/** The sentence a view says as it ends. */
export const LIVE_VIEW_END_TEXT: Record<LiveViewEnd, string> = {
  'test-ended': 'The test ended.',
  'worker-left': 'The worker left the run.',
  'run-ended': 'The run ended.',
  off: "The project's live view was turned off.",
  replaced: 'You opened another view of this run in its place.',
  unshared: 'The developer stopped sharing this run from their machine.',
};
