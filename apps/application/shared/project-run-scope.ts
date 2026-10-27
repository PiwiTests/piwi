/**
 * The runs a project page reads: the environments, branches and run kinds its
 * Filters block picks. Every tab that reads run history follows it, in SQL
 * through `projectRunScopeConditions` (`shared/handlers/project-run-scope.ts`)
 * and in the browser through `runInProjectScope`, so the runs table, the test
 * catalog, the failures, the Flake Lab and the performance trends read the same
 * runs.
 *
 * With no branch picked the scope reads the project's default branch and the
 * runs that report no branch; `allBranches` reads every branch. The query keys
 * are the analytics ones, so an analytics drill-down address is a scope too.
 */

export interface ProjectRunScope {
  /** Runs from any of these environments; every environment when empty. */
  environments: string[];
  /** Runs on any of these branches; the branch policy decides when empty. */
  branches: string[];
  /** With no branch picked: every branch, instead of the default branch and runs with no branch. */
  allBranches: boolean;
  /** Only runs of the whole suite, not a `--grep` or single-file subset. */
  fullRunsOnly: boolean;
}

/**
 * The keys a scoped request carries. `fullRunsOnly` alone does not make a
 * request scoped: the performance endpoint took it before scopes existed.
 */
const SCOPE_MARKER_KEYS = ['environments', 'branches', 'allBranches'] as const;

type QueryLike = URLSearchParams | Record<string, unknown> | null | undefined;

function pick(query: QueryLike, key: string): string | null {
  if (!query) return null;
  if (query instanceof URLSearchParams) return query.get(key);
  const value = query[key];
  if (value == null) return null;
  return Array.isArray(value) ? String(value[0] ?? '') : String(value);
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** The scope a request names, or null when it names none (a caller reading the unscoped lists). */
export function parseProjectRunScope(query: QueryLike): ProjectRunScope | null {
  if (!SCOPE_MARKER_KEYS.some((key) => pick(query, key) !== null)) return null;
  const allBranches = pick(query, 'allBranches');
  return {
    environments: parseList(pick(query, 'environments')),
    branches: parseList(pick(query, 'branches')),
    allBranches: allBranches === 'true' || allBranches === '1',
    fullRunsOnly: pick(query, 'fullRunsOnly') !== 'false',
  };
}

/** The query a scope travels in. `allBranches` is always written, so the request reads as scoped. */
export function projectRunScopeQuery(scope: ProjectRunScope): Record<string, string> {
  const query: Record<string, string> = {
    allBranches: String(scope.allBranches),
    fullRunsOnly: String(scope.fullRunsOnly),
  };
  if (scope.environments.length > 0) query.environments = scope.environments.join(',');
  if (scope.branches.length > 0) query.branches = scope.branches.join(',');
  return query;
}

/** The run fields the scope reads; `branch` is the run's logical branch. */
export interface ScopedRunFields {
  environment?: string | null;
  branch?: string | null;
  isFullRun?: boolean | null;
}

/** Whether a run is in the scope, given the project's default branch (`resolveStoredDefaultBranch`). */
export function runInProjectScope(run: ScopedRunFields, scope: ProjectRunScope, defaultBranch: string): boolean {
  if (scope.fullRunsOnly && run.isFullRun === false) return false;
  if (scope.environments.length > 0 && !(run.environment && scope.environments.includes(run.environment))) return false;
  const branch = run.branch?.trim() || null;
  if (scope.branches.length > 0) return branch !== null && scope.branches.includes(branch);
  if (scope.allBranches) return true;
  return branch === null || branch === defaultBranch;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(items)];
}

/**
 * A stored or submitted scope, normalized: trimmed, deduplicated lists and
 * booleans, `fullRunsOnly` on unless set to false. Null for anything that is
 * not an object, which stands for every run.
 */
export function resolveProjectRunScope(raw: unknown): ProjectRunScope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Partial<Record<keyof ProjectRunScope, unknown>>;
  return {
    environments: stringList(r.environments),
    branches: stringList(r.branches),
    allBranches: r.allBranches === true,
    fullRunsOnly: r.fullRunsOnly !== false,
  };
}

/** A scope in words: "the default branch (main) in production, full runs only". */
export function describeProjectRunScope(scope: ProjectRunScope, defaultBranch?: string | null): string {
  const branches =
    scope.branches.length > 0
      ? scope.branches.join(', ')
      : scope.allBranches
        ? 'any branch'
        : defaultBranch
          ? `the default branch (${defaultBranch})`
          : 'the default branch';
  const environments = scope.environments.length > 0 ? ` in ${scope.environments.join(', ')}` : '';
  return `${branches}${environments}${scope.fullRunsOnly ? ', full runs only' : ''}`;
}
