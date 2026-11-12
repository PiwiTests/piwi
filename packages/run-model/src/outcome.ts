/**
 * How far a run is and how it came out beyond its status, as its own process counted it (`HubProgress`): its tests ended
 * at a stop (End the test) are skipped, each marked so, never a plain pass. A run of a reporter that predates the count
 * names none.
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

/**
 * How far a run is, in a surface's words: how many of its tests ended of all it holds (`3 of 9 tests`), then how many
 * failed, were flaky and were ended at a stop, each only when there is one.
 */
export function progressWords(
  progress: Pick<HubProgress, 'total' | 'done' | 'failed' | 'flaky' | 'skipped' | 'endedAtStop'>,
  speaker: RunSpeaker,
): string[] {
  const words = [speaker.count('runs_progress', progress.total, { done: String(progress.done) })];
  if (progress.failed > 0) words.push(speaker.count('runs_progressFailed', progress.failed));
  if (progress.flaky > 0) words.push(speaker.count('runs_progressFlaky', progress.flaky));
  const ended = endedAtStopWords(endedAtStopOf(progress), speaker);
  if (ended) words.push(ended);
  return words;
}
