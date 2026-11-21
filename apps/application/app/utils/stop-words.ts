import type { TestStopReason } from '@piwitests/core/wire';
import type { Lane } from '#shared/live-lanes';
import type { LiveWorkerState } from '#shared/live-view';

/**
 * What a stopped test says of its stop, by its reason, on the run page and in the desktop app's tray: one sentence per
 * reason, `other` for a reason of a newer reporter. A failure held for a look names it so.
 */
export const STOP_WORDS: Record<TestStopReason, string> = {
  breakpoint: 'Stopped at a breakpoint',
  step: 'Stopped after a step',
  pause: 'Paused',
  'run-to': 'Stopped at the line it ran to',
  'page-pause': 'Stopped at page.pause()',
  failure: 'Held at its failure',
  other: 'Stopped',
};

/** The words for a stop's reason as any source names it: one this page does not know reads as `other`'s. */
export function stopWords(reason: string): string {
  return reason in STOP_WORDS ? STOP_WORDS[reason as TestStopReason] : STOP_WORDS.other;
}

/** How long a stop stands before its row and its lane panel say for how long. */
export const STOOD_FOR_MS = 60_000;

/**
 * How long a stop has stood, in whole minutes as ms, once it stood `STOOD_FOR_MS`; null before, and for a stop whose
 * producer cannot tell when it began (`since` null).
 */
export function stopStoodMs(since: number | null | undefined, now: number): number | null {
  if (!since || now - since < STOOD_FOR_MS) return null;
  return Math.floor((now - since) / 60_000) * 60_000;
}

/** A stop as a watched worker's view shows it: its reason, for `stopWords`, and when it began (null when unknown). */
export interface WatchedStop {
  reason: string;
  since: number | null;
}

/**
 * The stop the test of a watched worker stands at: the stop of its lane as the run's stream sends it (`lane` events,
 * which reduce the reporter's told stops and the live view's alike), the lane of its `slot`, or, for a worker that says
 * none, the lane it ran in last; for a worker in no lane the page holds, the stop its live view says. Null for none.
 */
export function watchedStop(
  lanes: readonly Lane[],
  workers: readonly LiveWorkerState[],
  watched: { shard: number | null; worker: number; slot?: number },
): WatchedStop | null {
  const lane = lanes.find(
    ({ id, worker }) =>
      id.shard === watched.shard && (watched.slot === undefined ? worker === watched.worker : id.lane === watched.slot),
  );
  if (lane) return lane.state === 'stopped' && lane.stop ? { reason: lane.stop.reason, since: lane.stop.since } : null;
  const paused = workers.find(({ shard, worker }) => shard === watched.shard && worker === watched.worker)?.paused;
  return paused ? { reason: paused.reason, since: null } : null;
}
