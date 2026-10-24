import type { TestRunForChart } from '~~/types/api';
import { ACTIVE_RUN_STATUSES } from '~/utils/desktop-run-progress';

/**
 * What the connect wizard's status line says: no run has reported yet, a run is
 * reporting now, or which run reported last.
 */
export type FirstRunStatus =
  | { kind: 'waiting' }
  | { kind: 'reporting'; run: TestRunForChart }
  | { kind: 'reported'; run: TestRunForChart };

const time = (run: TestRunForChart) => new Date(run.startTime).getTime();

/** The status line for the runs `/api/test-runs/recent` returns, newest first whatever their order. */
export function firstRunStatus(runs: readonly TestRunForChart[]): FirstRunStatus {
  const newest = [...runs].sort((a, b) => time(b) - time(a) || b.id - a.id);
  const active = newest.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
  if (active) return { kind: 'reporting', run: active };
  const last = newest[0];
  return last ? { kind: 'reported', run: last } : { kind: 'waiting' };
}
