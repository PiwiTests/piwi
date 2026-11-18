/**
 * A project run scope (`#shared/project-run-scope`) as SQL over `test_runs`,
 * for every handler behind a project tab that reads run history.
 */
import { and, eq, inArray, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { environments, projects, testRuns } from '../../server/database/schema';
import { resolveStoredDefaultBranch } from '../../server/utils/scm/stored-default-branch';
import { scopeEnvironments, type ProjectRunScope } from '../project-run-scope';
import { notLabRun } from './probes';
import { environmentScopeSql } from './environment-scope';
import { defaultEnvironmentJoin } from './default-environment';
import type { DrizzleDB } from './db';

/**
 * The `test_runs` conditions of a scope over one project's runs. The default
 * branch is the project's stored one (`resolveStoredDefaultBranch`), and a run
 * with no branch counts on it; the default environment is the project's
 * (`projectDefaultEnvironment`, an archived one reading as none), and a run
 * with no environment never counts on it. One read of the project gives both.
 */
export async function projectRunScopeConditions(
  db: DrizzleDB,
  projectId: number,
  scope: ProjectRunScope,
): Promise<SQL[]> {
  const readsBranch = scopeReadsDefaultBranch(scope);
  const readsEnvironment = scopeReadsDefaultEnvironment(scope);
  if (!readsBranch && !readsEnvironment) return runScopeConditions(scope, '');
  const [project] = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch, defaultEnvironment: environments.key })
    .from(projects)
    .leftJoin(environments, defaultEnvironmentJoin())
    .where(eq(projects.id, projectId));
  const defaultBranch = readsBranch ? await resolveStoredDefaultBranch(db, project ?? { id: projectId }) : '';
  return runScopeConditions(scope, defaultBranch, project?.defaultEnvironment ?? null);
}

/** Whether a scope reads the default branch, the one case its conditions need it. */
export function scopeReadsDefaultBranch(scope: ProjectRunScope): boolean {
  return scope.branches.length === 0 && !scope.allBranches;
}

/** Whether a scope reads the default environment, the one case its conditions need it. */
function scopeReadsDefaultEnvironment(scope: ProjectRunScope): boolean {
  return scope.environments.length === 0 && !scope.allEnvironments;
}

/**
 * `projectRunScopeConditions` with the default branch and the key of the default environment already resolved (null
 * for none: every environment).
 */
export function runScopeConditions(
  scope: ProjectRunScope,
  defaultBranch: string,
  defaultEnvironment: string | null = null,
): SQL[] {
  const conditions: SQL[] = [];
  if (scope.fullRunsOnly) conditions.push(eq(testRuns.isFullRun, 1));
  const environment = environmentScopeSql(scopeEnvironments(scope, defaultEnvironment));
  if (environment) conditions.push(environment);
  if (scope.branches.length > 0) {
    conditions.push(inArray(testRuns.branch, scope.branches));
  } else if (!scope.allBranches) {
    conditions.push(or(eq(testRuns.branch, defaultBranch), isNull(testRuns.branch), eq(testRuns.branch, ''))!);
  }
  return conditions;
}

/**
 * The predicate on an execution's run id keeping the executions of the
 * project's runs that are not lab runs and meet `conditions` (from
 * `projectRunScopeConditions`): `notLabExecutionInProject` with a scope.
 */
export function scopedExecutionInProject(projectId: number, testRunId: SQLWrapper, conditions: SQL[]): SQL {
  const where = and(eq(testRuns.projectId, projectId), notLabRun(testRuns.origin), ...conditions)!;
  return sql`${testRunId} IN (SELECT ${testRuns.id} FROM ${testRuns} WHERE ${where})`;
}

/**
 * `scopedExecutionInProject` for a join that reads every execution of some of
 * the project's test cases; with no `conditions`, `notLabExecutionInProject`.
 * The project's runs it leaves out (lab runs, and runs whose conditions are
 * false or null) are listed once, and an execution is kept unless its run is
 * on that list, so no run is looked up per execution. Every execution of a
 * project's test case is of one of the project's runs, so both keep the same
 * executions. A lookup that stops at a test's first executions (`EXISTS`,
 * `LIMIT`) plans better with the `IN` form.
 */
export function scopedExecutionInProjectJoin(projectId: number, testRunId: SQLWrapper, conditions: SQL[] = []): SQL {
  const kept = and(notLabRun(testRuns.origin), ...conditions)!;
  return sql`${testRunId} NOT IN (SELECT ${testRuns.id} FROM ${testRuns} WHERE ${testRuns.projectId} = ${projectId} AND (${kept}) IS NOT TRUE)`;
}
