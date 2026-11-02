/**
 * Where a project stands: its latest finished run and the tendency of its last
 * runs, as the home page's Project health table and stat strip read them. A run
 * still initializing, running or finalizing has no outcome yet, so neither reads
 * it. The project overview builds them on the server, and the home page again
 * from the runs its environment filter keeps.
 */

export type ProjectTendency = 'passing' | 'flaky' | 'failing' | 'unknown';

/** The fields of a run the health reads. */
export interface ProjectHealthRun {
  status: string;
  flakyTests: number;
}

const UNFINISHED_STATUSES: ReadonlySet<string> = new Set(['initializing', 'running', 'finalizing']);
const FAILING_STATUSES: ReadonlySet<string> = new Set(['failed', 'timedout', 'interrupted']);

/** Whether a run has finished: it has an outcome to read. */
export function isRunFinished(status: string): boolean {
  return !UNFINISHED_STATUSES.has(status);
}

/** The tendency of finished runs, oldest first: the latest one's failure, else the last five's mix. */
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

/** A project's latest finished run and its tendency, from its runs oldest first. */
export function projectHealth<T extends ProjectHealthRun>(
  runs: readonly T[],
): { latest: T | null; tendency: ProjectTendency } {
  const finished = runs.filter((run) => isRunFinished(run.status));
  return { latest: finished.at(-1) ?? null, tendency: deriveTendency(finished) };
}
