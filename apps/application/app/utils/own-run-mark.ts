import { runInProjectScope, type ProjectRunScope, type ScopedRunFields } from '#shared/project-run-scope';

/** A run of a runs list as the own-run rule reads it: its scope fields and whether it is the viewer's own. */
export interface ListedRun extends ScopedRunFields {
  mine?: true;
}

/** The scope's environments alone, the default environment included: the one filter that hides an own run too. */
function environmentsOnly(scope: ProjectRunScope): ProjectRunScope {
  return {
    environments: scope.environments,
    allEnvironments: scope.allEnvironments,
    branches: [],
    allBranches: true,
    fullRunsOnly: false,
  };
}

/**
 * Whether a runs list shows `run`: a run in the scope, or the viewer's own run in the scope's environments, whatever
 * the partial-run and branch filters say. `defaultEnvironment` is the key of the project's default environment, if
 * any. Charts and figures read `runInProjectScope` alone.
 */
export function listsRun(
  run: ListedRun,
  scope: ProjectRunScope,
  defaultBranch: string,
  defaultEnvironment: string | null = null,
): boolean {
  if (runInProjectScope(run, scope, defaultBranch, defaultEnvironment)) return true;
  return !!run.mine && runInProjectScope(run, environmentsOnly(scope), defaultBranch, defaultEnvironment);
}

/**
 * The quiet mark of an own run a list shows despite its filters, saying why: "Yours · partial run", "Yours ·
 * feature/x", or both. Null for a run the filters keep, and for a run that is not the viewer's.
 */
export function ownRunMark(
  run: ListedRun,
  scope: ProjectRunScope,
  defaultBranch: string,
  defaultEnvironment: string | null = null,
): string | null {
  if (!run.mine || runInProjectScope(run, scope, defaultBranch, defaultEnvironment)) return null;
  const why: string[] = [];
  if (scope.fullRunsOnly && run.isFullRun === false) why.push('partial run');
  if (
    !runInProjectScope(run, { ...scope, environments: [], allEnvironments: true, fullRunsOnly: false }, defaultBranch)
  ) {
    why.push(run.branch?.trim() || 'no branch');
  }
  return why.length > 0 ? ['Yours', ...why].join(' · ') : null;
}

/**
 * A runs list's rows: the scoped runs and the viewer's own runs the scope leaves out, each run once, newest first.
 */
export function joinOwnRuns<T extends { id: number; startTime: string | Date }>(scoped: T[], own: T[]): T[] {
  const listed = new Set(scoped.map((run) => run.id));
  return [...scoped, ...own.filter((run) => !listed.has(run.id))].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  );
}
