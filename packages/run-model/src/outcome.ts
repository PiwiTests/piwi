/**
 * How a run came out beyond its status, as its own process counted it (`HubProgress`): its tests ended at a stop (End
 * the test) are skipped, each marked so, never a plain pass. A run of a reporter that predates the count names none.
 */
import type { HubProgress } from '@piwitests/core/run-hub';
import type { RunSpeaker } from './words';

/** How many of the run's tests were ended at a stop: never more than it skipped; 0 without a count. */
export function endedAtStopOf(progress: Pick<HubProgress, 'skipped' | 'endedAtStop'> | null | undefined): number {
  return Math.min(progress?.endedAtStop ?? 0, progress?.skipped ?? 0);
}

/** How many of a run's tests were ended at a stop, in a surface's words: `1 ended at a stop`; null for none. */
export function endedAtStopWords(count: number, speaker: RunSpeaker): string | null {
  return count > 0 ? speaker.count('runs_progressEndedAtStop', count) : null;
}
