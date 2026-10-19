/**
 * The one filter object every analytics widget receives: which runs, which
 * tests, which period, compared with what. Parsed from the request query on
 * both the server route and the demo router so the two stay identical by
 * construction, and carried by the page URL so a copied link shows what its
 * sender saw.
 *
 * Run filters (projects, project tags, environments, branch policy, full runs)
 * are answered from the daily rollups; test filters (a selection, inline
 * predicates, browsers) from the stored executions.
 */

import type { SelectionPredicateGroup, SelectionPriority } from '../selection/types';
import { SELECTION_KEY_PATTERN } from '../selection/validate';
import {
  DEFAULT_COMPARISON,
  DEFAULT_PERIOD,
  encodeComparison,
  encodePeriod,
  parseComparison,
  parseGranularity,
  parsePeriod,
  periodFromDays,
  type ComparisonSpec,
  type Granularity,
  type PeriodSpec,
} from './period';

export interface AnalyticsScope {
  period: PeriodSpec;
  comparison: ComparisonSpec;
  granularity: Granularity;
  /** Optional explicit project filter (always intersected with the caller's project access). */
  projectIds?: number[];
  /** Only projects carrying any of these project tags (by tag text). */
  projectTags?: string[];
  /** Restrict to runs reported for any of these deployment environments. */
  environments?: string[];
  /** Restrict to runs reported on any of these SCM branches. Setting it turns the branch policy off. */
  branches?: string[];
  /**
   * The branch policy: only runs on each project's default branch; a run whose
   * branch is unknown counts only in a project that never reported a branch.
   * Ignored when `branches` is set.
   */
  defaultBranchOnly: boolean;
  /** Only count full-suite runs (default) — partial/--grep runs skew every rate. */
  fullRunsOnly: boolean;
  /** Test filter: a selection key, resolved in each project of the scope. */
  selection?: string;
  /** Test filter: an inline predicate group in the selection syntax. */
  tests?: SelectionPredicateGroup;
  /** Test filter on executions: Playwright project (browser) names. */
  browsers?: string[];
  /** Request context, not a filter: the viewer's time zone for calendar periods. Never in the page URL. */
  timeZone?: string;
  /** Request context, not a filter: the viewer's locale, for the first day of the week. */
  locale?: string;
}

export const DEFAULT_ANALYTICS_SCOPE: AnalyticsScope = {
  period: DEFAULT_PERIOD,
  comparison: DEFAULT_COMPARISON,
  granularity: 'auto',
  defaultBranchOnly: true,
  fullRunsOnly: true,
};

type QueryLike = URLSearchParams | Record<string, unknown> | undefined | null;

function pick(query: QueryLike, key: string): string | null {
  if (!query) return null;
  if (query instanceof URLSearchParams) return query.get(key);
  const value = (query as Record<string, unknown>)[key];
  if (value == null) return null;
  return Array.isArray(value) ? String(value[0] ?? '') : String(value);
}

const PRIORITIES = new Set<string>(['critical', 'high', 'medium', 'low']);

/**
 * The query keys the scope reads: `period`, `days`, `projects`,
 * `environments`, `branches`, `fullRunsOnly`, and the singular `environment`
 * and `branch`. `period` wins over `days` when both are set.
 */
export function parseAnalyticsScope(query: QueryLike): AnalyticsScope {
  const rawDays = Number(pick(query, 'days'));
  const legacyPeriod = Number.isFinite(rawDays) && rawDays > 0 ? periodFromDays(rawDays) : null;
  const period = parsePeriod(pick(query, 'period')) ?? legacyPeriod ?? DEFAULT_PERIOD;

  const rawProjects = pick(query, 'projects');
  const projectIds = rawProjects
    ? rawProjects
        .split(',')
        .map((p) => Number(p))
        .filter((p) => Number.isInteger(p) && p > 0)
    : undefined;

  const branches = parseList(pick(query, 'branches') ?? pick(query, 'branch'));
  const allBranches = pick(query, 'allBranches');

  const selection = pick(query, 'sel')?.trim();
  const tests = parseTestPredicates(query);

  const scope: AnalyticsScope = {
    period,
    comparison: parseComparison(pick(query, 'compare')) ?? DEFAULT_COMPARISON,
    granularity: parseGranularity(pick(query, 'by')) ?? 'auto',
    projectIds: projectIds && projectIds.length > 0 ? projectIds : undefined,
    projectTags: parseList(pick(query, 'projectTags')),
    environments: parseList(pick(query, 'environments') ?? pick(query, 'environment')),
    branches,
    defaultBranchOnly: !branches && allBranches !== 'true' && allBranches !== '1',
    fullRunsOnly: pick(query, 'fullRunsOnly') !== 'false',
    selection: selection && SELECTION_KEY_PATTERN.test(selection) ? selection : undefined,
    tests,
    browsers: parseList(pick(query, 'browsers') ?? pick(query, 'browser')),
    timeZone: pick(query, 'tz')?.trim() || undefined,
    locale: pick(query, 'locale')?.trim() || undefined,
  };
  return dropUndefined(scope);
}

/** The inline test predicates: `tags` (all of), `anyTags`, `owner`, `priority`, `feature`, `files`, `q`, `quarantined`. */
function parseTestPredicates(query: QueryLike): SelectionPredicateGroup | undefined {
  const group: SelectionPredicateGroup = {};
  const tags = parseList(pick(query, 'tags'))?.map(stripAt);
  if (tags?.length) group.tags = tags;
  const anyTags = parseList(pick(query, 'anyTags'))?.map(stripAt);
  if (anyTags?.length) group.anyTags = anyTags;
  const owner = parseList(pick(query, 'owner'));
  if (owner) group.owner = owner;
  const priority = parseList(pick(query, 'priority'))?.filter((p) => PRIORITIES.has(p)) as
    | SelectionPriority[]
    | undefined;
  if (priority?.length) group.priority = priority;
  const feature = parseList(pick(query, 'feature'));
  if (feature) group.feature = feature;
  const files = parseList(pick(query, 'files'));
  if (files) group.files = files;
  const text = pick(query, 'q')?.trim();
  if (text) group.text = text;
  const quarantined = pick(query, 'quarantined');
  if (quarantined === 'true' || quarantined === 'false') group.quarantined = quarantined === 'true';
  return Object.keys(group).length > 0 ? group : undefined;
}

function stripAt(tag: string): string {
  return tag.replace(/^@+/, '');
}

/** Split a comma-separated query value into a trimmed, non-empty list (undefined when empty). */
function parseList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return values.length > 0 ? values : undefined;
}

function dropUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key];
  return value;
}

/** Whether the scope carries a test filter (selection, predicates or browsers). */
export function hasTestFilter(scope: AnalyticsScope): boolean {
  return !!(scope.selection || scope.tests || (scope.browsers && scope.browsers.length > 0));
}

/**
 * Serialize a scope into query params, writing the new keys: the page URL and
 * the widget requests both use it. The period is always written; everything
 * else only when it differs from the default. `tz` and `locale` are written
 * when present, which only the widget requests set.
 */
export function analyticsScopeToQuery(scope: AnalyticsScope): Record<string, string> {
  const query: Record<string, string> = { period: encodePeriod(scope.period) };
  if (scope.comparison.kind !== 'previous') query.compare = encodeComparison(scope.comparison);
  if (scope.granularity !== 'auto') query.by = scope.granularity;
  if (scope.projectIds && scope.projectIds.length > 0) query.projects = scope.projectIds.join(',');
  if (scope.projectTags && scope.projectTags.length > 0) query.projectTags = scope.projectTags.join(',');
  if (scope.environments && scope.environments.length > 0) query.environments = scope.environments.join(',');
  if (scope.branches && scope.branches.length > 0) query.branches = scope.branches.join(',');
  else if (!scope.defaultBranchOnly) query.allBranches = 'true';
  if (!scope.fullRunsOnly) query.fullRunsOnly = 'false';
  if (scope.selection) query.sel = scope.selection;
  const t = scope.tests;
  if (t?.tags?.length) query.tags = t.tags.join(',');
  if (t?.anyTags?.length) query.anyTags = t.anyTags.join(',');
  if (t?.owner?.length) query.owner = t.owner.join(',');
  if (t?.priority?.length) query.priority = t.priority.join(',');
  if (t?.feature?.length) query.feature = t.feature.join(',');
  if (t?.files?.length) query.files = t.files.join(',');
  if (t?.text) query.q = t.text;
  if (t?.quarantined !== undefined) query.quarantined = String(t.quarantined);
  if (scope.browsers && scope.browsers.length > 0) query.browsers = scope.browsers.join(',');
  if (scope.timeZone) query.tz = scope.timeZone;
  if (scope.locale) query.locale = scope.locale;
  return query;
}

/** The query keys `parseAnalyticsScope` reads, for the OpenAPI parameters and the page URL sync. */
export const ANALYTICS_SCOPE_QUERY_KEYS = [
  'period',
  'compare',
  'by',
  'days',
  'projects',
  'projectTags',
  'environments',
  'environment',
  'branches',
  'branch',
  'allBranches',
  'fullRunsOnly',
  'sel',
  'tags',
  'anyTags',
  'owner',
  'priority',
  'feature',
  'files',
  'q',
  'quarantined',
  'browsers',
  'browser',
  'tz',
  'locale',
] as const;
