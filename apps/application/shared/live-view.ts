/**
 * What the run page reads of a live run's live view: each connected worker's state, which the run's event stream
 * carries (`live-worker`), and the messages of one worker's view (`/api/test-runs/:id/live-view/watch`). The worker's
 * side of the protocol is `@piwitests/core/live-view`.
 */
import { readLiveCall, type LiveCall, type LiveStop } from '@piwitests/core/live-view';

export { liveWorkerKey, type LiveCall, type LiveStop } from '@piwitests/core/live-view';

/** A worker of a live run as the run page knows it: whether it is connected, and its test's stop while it holds. */
export interface LiveWorkerState {
  shard: number | null;
  worker: number;
  connected: boolean;
  paused: LiveStop | null;
}

/** Why a view ended. */
export type LiveViewEnd = 'test-ended' | 'worker-left' | 'run-ended' | 'off';

/** A message of one worker's view, to the person watching it. */
export type LiveViewerMessage =
  /** A frame of the test's page, a JPEG in base64, and the call it was taken at. */
  | { type: 'frame'; data: string; call: LiveCall | null }
  /** Why no frame shows now. */
  | { type: 'refused'; message: string }
  /** The view ended: the stream closes after it. */
  | { type: 'end'; reason: LiveViewEnd };

const ENDS: readonly string[] = ['test-ended', 'worker-left', 'run-ended', 'off'];

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
      return { type: 'frame', data: message.data, call: message.call ? readLiveCall(message.call) : null };
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
};
