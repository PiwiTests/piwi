/**
 * What the run page reads of a live run's live view: whether the run holds a key (`live-view`), each connected worker's
 * state, which the run's event stream carries (`live-worker`), and the messages of one worker's view (`/api/test-runs/:id/live-view/watch`). The worker's
 * side of the protocol is `@piwitests/core/live-view`.
 */
import {
  readLiveCall,
  readLiveCallLog,
  readLiveTestTitle,
  type LiveCall,
  type LiveCallLog,
  type LiveStop,
  type LiveWorkerId,
} from '@piwitests/core/live-view';

export { liveWorkerKey, type LiveCall, type LiveCallLog, type LiveStop } from '@piwitests/core/live-view';

/** A worker of a live run as the run page knows it: whether it is connected, and its test's stop while it holds. */
export interface LiveWorkerState {
  shard: number | null;
  worker: number;
  connected: boolean;
  paused: LiveStop | null;
}

/**
 * Whether a live run holds a live view key on the instance, as its event stream says it (`live-view`): its project's
 * live view applies to it. A CI run's workers stream with it at once; those of a run outside CI only once its
 * developer shares it, so until then the run page says how (**Not shared live**).
 */
export interface LiveViewRunState {
  keyed: boolean;
}

/** How the run page names a worker: its index, and its shard in a sharded run. */
export function liveWorkerName(id: LiveWorkerId): string {
  return id.shard === null ? `worker ${id.worker}` : `worker ${id.worker} of shard ${id.shard}`;
}

/**
 * Why a view ended: its test ended, its worker left, the run ended, the project's live view was turned off, the person
 * who watched it opened a further one of the run, past their share, in its place (`replaced`), or the developer who
 * shared the run from their machine stopped sharing it (`unshared`).
 */
export type LiveViewEnd = 'test-ended' | 'worker-left' | 'run-ended' | 'off' | 'replaced' | 'unshared';

/** A message of one worker's view, to the person watching it. */
export type LiveViewerMessage =
  /** A frame of the test's page, a JPEG in base64, the call it was taken at and the title of its test. */
  | { type: 'frame'; data: string; call: LiveCall | null; test: string | null }
  /** The call the test is in, as Playwright logs it, in a CI run, and the title of its test. */
  | { type: 'call-log'; log: LiveCallLog; test: string | null }
  /** Why no frame shows now. */
  | { type: 'refused'; message: string }
  /** The view ended: the stream closes after it. */
  | { type: 'end'; reason: LiveViewEnd };

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
      };
    case 'call-log': {
      const log = readLiveCallLog(message.log);
      return log ? { type: 'call-log', log, test: readLiveTestTitle(message.test) } : null;
    }
    case 'refused':
      return typeof message.message === 'string' ? { type: 'refused', message: message.message.slice(0, 500) } : null;
    case 'end':
      return ENDS.includes(message.reason as string) ? { type: 'end', reason: message.reason as LiveViewEnd } : null;
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
