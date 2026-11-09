/**
 * Where a project stands: its latest run that ran to its end and the tendency
 * of its last such runs, as the home page's Project health table and stat strip
 * and the project header read them. A run still initializing, running or
 * finalizing has no outcome yet, and an interrupted or cancelled one stopped
 * before it, so neither reads them; the run lists and the trend bars still show
 * them. The project overview builds them on the server, and the home page again
 * from the runs its environment filter keeps.
 */

export type ProjectTendency = 'passing' | 'flaky' | 'failing' | 'unknown';

/** The fields of a run the health reads. */
export interface ProjectHealthRun {
  status: string;
  flakyTests: number;
}

/** The statuses of a run that ran to its end: passed, failed, or stopped by Playwright's global timeout. */
const RAN_TO_END_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'timedout']);
const FAILING_STATUSES: ReadonlySet<string> = new Set(['failed', 'timedout']);

/** Whether a run ran to its end: it has an outcome to read. */
export function ranToItsEnd(status: string): boolean {
  return RAN_TO_END_STATUSES.has(status);
}

/** The tendency of runs that ran to their end, oldest first: the latest one's failure, else the last five's mix. */
function deriveTendency(runs: readonly ProjectHealthRun[]): ProjectTendency {
  if (runs.length < 2) return 'unknown';
  const latest = runs[runs.length - 1]!;
  if (FAILING_STATUSES.has(latest.status)) return 'failing';
  const w = runs.slice(-5);
  const hasFlaky = w.some((r) => (r.flakyTests ?? 0) > 0);
  const anyFailed = w.some((r) => FAILING_STATUSES.has(r.status));
  const anyPassed = w.some((r) => r.status === 'passed');
  if (hasFlaky || (anyFailed && anyPassed)) return 'flaky';
  if (w.every((r) => r.status === 'passed')) return 'passing';
  return 'unknown';
}

/** A project's latest run that ran to its end and its tendency, from its runs oldest first. */
export function projectHealth<T extends ProjectHealthRun>(
  runs: readonly T[],
): { latest: T | null; tendency: ProjectTendency } {
  const ended = runs.filter((run) => ranToItsEnd(run.status));
  return { latest: ended.at(-1) ?? null, tendency: deriveTendency(ended) };
}
