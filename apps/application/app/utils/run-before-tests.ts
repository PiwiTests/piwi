import { formatLongDuration } from './index';

/** Where a run stands before its first test, as its page knows it. */
export interface BeforeFirstTest {
  /** The run is in its global setup: it does not know its tests yet (they load after it, with its `begin`). */
  initializing: boolean;
  /** The page hears the run's events, so no test began that it would show. */
  heard: boolean;
  /** The tests the run plans. */
  total?: number | null;
}

/**
 * What a run's Tests list says before its first test: its global setup, then that its tests start while the page hears
 * the run, else only that it waits for them; with how long since the run began once the page counts it.
 */
export function beforeFirstTestText(run: BeforeFirstTest, elapsedMs: number | null): string {
  const what = run.initializing
    ? 'Global setup'
    : run.heard && run.total
      ? `Starting ${run.total} ${run.total === 1 ? 'test' : 'tests'}`
      : 'Waiting for the run’s tests';
  return elapsedMs === null ? what : `${what} · ${formatLongDuration(Math.max(0, elapsedMs))}`;
}
