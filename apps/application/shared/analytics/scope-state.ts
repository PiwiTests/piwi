/**
 * The analytics page's scope as the browser keeps it: the flat state the
 * scope bar edits, stored in the `piwi-analytics-scope` cookie as the
 * per-browser default, and its mapping to and from `AnalyticsScope`.
 *
 * Cookies written before periods existed hold `{ days, projectIds,
 * environments, branches, fullRunsOnly }`; they decode to the same scope they
 * showed: `days` becomes a rolling period (3650 is All time), and a cookie
 * that names branches keeps them, so the default-branch policy never
 * overrides a choice someone made.
 */

import type { SelectionPredicateGroup } from '../selection/types';
import {
  DEFAULT_COMPARISON,
  DEFAULT_PERIOD,
  encodeComparison,
  encodePeriod,
  parseComparison,
  parseGranularity,
  parsePeriod,
  periodFromDays,
  type Granularity,
} from './period';
import { ANALYTICS_SCOPE_QUERY_KEYS, type AnalyticsScope } from './scope';

export interface AnalyticsScopeState {
  /** Encoded period (`last-30d`, `this-month`, …). */
  period: string;
  /** Encoded comparison (`previous`, `year`, …). */
  compare: string;
  granularity: Granularity;
  /** Selected project ids; empty = every project the caller can see. */
  projectIds: number[];
  /** Project tags; empty = no project tag filter. */
  projectTags: string[];
  /** Selected environments; empty = the environment policy applies. */
  environments: string[];
  /** The environment policy: false = each project's default environment (every one for a project without), true = every environment. */
  allEnvironments: boolean;
  /** Selected branches; empty = the branch policy applies. */
  branches: string[];
  /** The branch policy: false = each project's default branch, true = every branch. */
  allBranches: boolean;
  fullRunsOnly: boolean;
  /** Selection key; empty = none. */
  selection: string;
  /** Inline test predicates in the selection syntax; `{}` = none. The scope bar edits `tags`. */
  tests: SelectionPredicateGroup;
  /** Browsers; empty = every browser. */
  browsers: string[];
}

export const DEFAULT_ANALYTICS_SCOPE_STATE: AnalyticsScopeState = {
  period: encodePeriod(DEFAULT_PERIOD),
  compare: encodeComparison(DEFAULT_COMPARISON),
  granularity: 'auto',
  projectIds: [],
  projectTags: [],
  environments: [],
  allEnvironments: false,
  branches: [],
  allBranches: false,
  fullRunsOnly: true,
  selection: '',
  tests: {},
  browsers: [],
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

function idList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => Number.isInteger(v) && v > 0) : [];
}

/** Decode a cookie value (the current shape or the one before periods); never throws. */
export function decodeScopeCookie(raw: unknown): AnalyticsScopeState {
  let value: Record<string, unknown> | null = null;
  if (typeof raw === 'string' && raw) {
    try {
      const text = raw.startsWith('%') ? decodeURIComponent(raw) : raw;
      value = JSON.parse(text) as Record<string, unknown>;
    } catch {
      value = null;
    }
  } else if (raw && typeof raw === 'object') {
    value = raw as Record<string, unknown>;
  }
  if (!value || typeof value !== 'object') return { ...DEFAULT_ANALYTICS_SCOPE_STATE };

  const days = Number(value.days);
  const period =
    (typeof value.period === 'string' && parsePeriod(value.period) ? value.period : null) ??
    (Number.isFinite(days) && days > 0 ? encodePeriod(periodFromDays(days)) : DEFAULT_ANALYTICS_SCOPE_STATE.period);
  const compare =
    typeof value.compare === 'string' && parseComparison(value.compare)
      ? value.compare
      : DEFAULT_ANALYTICS_SCOPE_STATE.compare;

  return {
    period,
    compare,
    granularity: parseGranularity(typeof value.granularity === 'string' ? value.granularity : null) ?? 'auto',
    projectIds: idList(value.projectIds),
    projectTags: stringList(value.projectTags),
    environments: stringList(value.environments),
    allEnvironments: value.allEnvironments === true,
    branches: stringList(value.branches),
    allBranches: value.allBranches === true,
    fullRunsOnly: value.fullRunsOnly !== false,
    selection: typeof value.selection === 'string' ? value.selection : '',
    tests:
      value.tests && typeof value.tests === 'object' && !Array.isArray(value.tests)
        ? (value.tests as SelectionPredicateGroup)
        : {},
    browsers: stringList(value.browsers),
  };
}

/** The scope a state stands for. */
export function scopeFromState(state: AnalyticsScopeState): AnalyticsScope {
  const tests = Object.keys(state.tests).length > 0 ? state.tests : undefined;
  const scope: AnalyticsScope = {
    period: parsePeriod(state.period) ?? DEFAULT_PERIOD,
    comparison: parseComparison(state.compare) ?? DEFAULT_COMPARISON,
    granularity: state.granularity,
    projectIds: state.projectIds.length > 0 ? state.projectIds : undefined,
    projectTags: state.projectTags.length > 0 ? state.projectTags : undefined,
    environments: state.environments.length > 0 ? state.environments : undefined,
    allEnvironments: state.environments.length === 0 && state.allEnvironments ? true : undefined,
    branches: state.branches.length > 0 ? state.branches : undefined,
    defaultBranchOnly: state.branches.length === 0 && !state.allBranches,
    fullRunsOnly: state.fullRunsOnly,
    selection: state.selection || undefined,
    tests,
    browsers: state.browsers.length > 0 ? state.browsers : undefined,
  };
  for (const key of Object.keys(scope) as (keyof AnalyticsScope)[]) if (scope[key] === undefined) delete scope[key];
  return scope;
}

/** The state a scope (parsed from a URL) stands for. */
export function stateFromScope(scope: AnalyticsScope): AnalyticsScopeState {
  return {
    period: encodePeriod(scope.period),
    compare: encodeComparison(scope.comparison),
    granularity: scope.granularity,
    projectIds: scope.projectIds ?? [],
    projectTags: scope.projectTags ?? [],
    environments: scope.environments ?? [],
    allEnvironments: !scope.environments?.length && !!scope.allEnvironments,
    branches: scope.branches ?? [],
    allBranches: !scope.branches?.length && !scope.defaultBranchOnly,
    fullRunsOnly: scope.fullRunsOnly,
    selection: scope.selection ?? '',
    tests: scope.tests ?? {},
    browsers: scope.browsers ?? [],
  };
}

/** Whether a route query carries any scope key, so the URL wins over the cookie. */
export function queryHasScope(query: Record<string, unknown>): boolean {
  return ANALYTICS_SCOPE_QUERY_KEYS.some((key) => key !== 'tz' && key !== 'locale' && query[key] != null);
}

/** The route query without its scope keys, so syncing the scope keeps unrelated params. */
export function queryWithoutScope(query: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  const keys = new Set<string>(ANALYTICS_SCOPE_QUERY_KEYS);
  for (const [key, value] of Object.entries(query)) if (!keys.has(key)) rest[key] = value;
  return rest;
}

/** Whether a state is the default one (drives the Reset button). */
export function isDefaultScopeState(state: AnalyticsScopeState): boolean {
  return JSON.stringify(state) === JSON.stringify(DEFAULT_ANALYTICS_SCOPE_STATE);
}
