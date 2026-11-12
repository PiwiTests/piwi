import { runInProjectScope, type ProjectRunScope, type ScopedRunFields } from '#shared/project-run-scope';

/** A run of a runs list as the own-run rule reads it: its scope fields and whether it is the viewer's own. */
export interface ListedRun extends ScopedRunFields {
  mine?: true;
}

/** The scope's environments alone: the one filter that hides an own run too. */
function environmentsOnly(scope: ProjectRunScope): ProjectRunScope {
  return { environments: scope.environments, branches: [], allBranches: true, fullRunsOnly: false };
}

/**
 * Whether a runs list shows `run`: a run in the scope, or the viewer's own run in the scope's environments, whatever
 * the partial-run and branch filters say. Charts and figures read `runInProjectScope` alone.
 */
export function listsRun(run: ListedRun, scope: ProjectRunScope, defaultBranch: string): boolean {
  if (runInProjectScope(run, scope, defaultBranch)) return true;
  return !!run.mine && runInProjectScope(run, environmentsOnly(scope), defaultBranch);
}

/**
 * The quiet mark of an own run a list shows despite its filters, saying why: "Yours · partial run", "Yours ·
 * feature/x", or both. Null for a run the filters keep, and for a run that is not the viewer's.
 */
export function ownRunMark(run: ListedRun, scope: ProjectRunScope, defaultBranch: string): string | null {
  if (!run.mine || runInProjectScope(run, scope, defaultBranch)) return null;
  const why: string[] = [];
  if (scope.fullRunsOnly && run.isFullRun === false) why.push('partial run');
  if (!runInProjectScope(run, { ...scope, environments: [], fullRunsOnly: false }, defaultBranch)) {
    why.push(run.branch?.trim() || 'no branch');
  }
  return why.length > 0 ? ['Yours', ...why].join(' · ') : null;
}
