import { ACTIVE_RUN_STATUSES } from '~/utils/desktop-run-progress';

/** A run's counters while it runs: each result counted as it is reported, a retry again. */
export interface RunTally {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  didNotRunTests: number;
}

/** A row of a runs list, which a tally can update while its run runs. */
export interface LiveRunRow extends RunTally {
  id: number;
  status: string;
}

/** The most tallies a list keeps: past it, the oldest goes. */
export const MAX_KEPT_TALLIES = 200;

/** Whether the run is going on, so its counts may still move. */
export function isLiveRun(run: { status: string }): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

/** The results reported so far. */
export function tallyResults(tally: RunTally): number {
  return tally.passedTests + tally.failedTests + tally.skippedTests + tally.didNotRunTests;
}

/** Keep the run's latest tally in `tallies`, the oldest run's going past `MAX_KEPT_TALLIES`. */
export function keepTally(tallies: Map<number, RunTally>, runId: number, tally: RunTally): void {
  tallies.delete(runId);
  tallies.set(runId, {
    totalTests: tally.totalTests,
    passedTests: tally.passedTests,
    failedTests: tally.failedTests,
    skippedTests: tally.skippedTests,
    didNotRunTests: tally.didNotRunTests,
  });
  while (tallies.size > MAX_KEPT_TALLIES) tallies.delete(tallies.keys().next().value!);
}

/**
 * The row with the counts of its run's latest tally, while the run runs and the tally holds as many results as the
 * row or more: the counters only grow while a run runs, so a row read after the tally keeps its own. An ended run's
 * row is the one its list read.
 */
export function withLiveTally<T extends LiveRunRow>(run: T, tally: RunTally | undefined): T {
  if (!tally || !isLiveRun(run) || tallyResults(tally) < tallyResults(run)) return run;
  return {
    ...run,
    totalTests: tally.totalTests,
    passedTests: tally.passedTests,
    failedTests: tally.failedTests,
    skippedTests: tally.skippedTests,
    didNotRunTests: tally.didNotRunTests,
  };
}

/** How far a running run is, as a list says it: "120 of 400", and how many results failed. */
export interface LiveProgress {
  /** The results so far, never more than the planned total. */
  done: number;
  /** The planned total, 0 while the run has not said it. */
  total: number;
  failed: number;
  /** "120 of 400", or "120 done" before the total is known. */
  label: string;
}

export function liveProgress(tally: RunTally): LiveProgress {
  const results = tallyResults(tally);
  const total = Math.max(0, tally.totalTests);
  const done = total > 0 ? Math.min(results, total) : results;
  return { done, total, failed: tally.failedTests, label: total > 0 ? `${done} of ${total}` : `${done} done` };
}
