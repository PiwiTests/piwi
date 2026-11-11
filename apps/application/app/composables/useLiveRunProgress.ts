import { shallowReactive } from 'vue';
import { useRunProgress } from '~/composables/useRunStream';
import { keepTally, withLiveTally, type LiveRunRow, type RunTally } from '~/utils/live-run-progress';

/**
 * The running runs' tallies a list hears on the shared run stream (`run-progress`), and the function that gives a
 * row of the list its run's latest counts (`withLiveTally`), so the row shows how far the run is without the list
 * being read again. Reactive: a template or a computed that calls it updates with each tally.
 */
export function useLiveRunProgress(): <T extends LiveRunRow>(run: T) => T {
  const tallies = shallowReactive(new Map<number, RunTally>());
  useRunProgress((event) => keepTally(tallies, event.runId, event));
  return (run) => withLiveTally(run, tallies.get(run.id));
}
