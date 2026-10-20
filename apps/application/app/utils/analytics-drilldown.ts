/**
 * Drill-down from an analytics number to the list behind it: a project's
 * runs, flaky tests, failure clusters or quarantine, opened with the same
 * scope (the analytics URL keys: period, environments, branches, the branch
 * policy and the run kind), so a number can be checked against its rows.
 */
import type { MetricId } from '#shared/analytics/metrics';
import { encodePeriod, parsePeriod, resolvePeriod, type PeriodMarker } from '#shared/analytics/period';

export type DrillList = 'runs' | 'flaky' | 'clusters' | 'quarantine';

/** The project page tab each list opens on (its tab or segment alias). */
const LIST_TABS: Record<DrillList, string> = {
  runs: 'runs',
  flaky: 'flaky-tests',
  clusters: 'failure-clusters',
  quarantine: 'quarantine',
};

/** The scope keys a drill-down carries; the project lists read these. */
const CARRIED_KEYS = ['period', 'environments', 'branches', 'allBranches', 'fullRunsOnly', 'tz'] as const;

/** The list behind each metric of the catalog. */
const METRIC_LISTS: Partial<Record<MetricId, DrillList>> = {
  'test-pass-rate': 'runs',
  'run-success-rate': 'runs',
  runs: 'runs',
  'suite-size': 'runs',
  'ci-time': 'runs',
  'wasted-ci-minutes': 'runs',
  'wasted-ci-cost': 'runs',
  'new-regressions': 'runs',
  'average-run-duration': 'runs',
  'average-p90-test-duration': 'runs',
  'flaky-tests': 'flaky',
  'flaky-occurrences': 'flaky',
  'newly-flaky': 'flaky',
  'open-failure-causes': 'clusters',
  'failure-causes-opened': 'clusters',
  'failure-causes-fixed': 'clusters',
  'median-time-to-fix': 'clusters',
  'oldest-open-failure-cause': 'clusters',
  'fixes-that-held': 'clusters',
  'quarantine-debt': 'quarantine',
};

export function metricDrillList(metric: MetricId): DrillList | null {
  return METRIC_LISTS[metric] ?? null;
}

/** The one project of a widget query, when the scope names exactly one. */
export function singleProjectOf(query: Record<string, string>): number | null {
  const ids = (query.projects ?? '').split(',').filter(Boolean);
  return ids.length === 1 && /^\d+$/.test(ids[0]!) ? Number(ids[0]) : null;
}

/** A bucket as an inclusive UTC date range: a day, a run of days, or a calendar month. */
export function bucketRange(date: string, bucketDays: number): { from: string; to: string } {
  const start = Date.parse(`${date}T00:00:00Z`);
  let end: number;
  if (bucketDays >= 28) {
    const d = new Date(start);
    end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 86_400_000;
  } else {
    end = start + (Math.max(1, bucketDays) - 1) * 86_400_000;
  }
  return { from: date, to: new Date(end).toISOString().slice(0, 10) };
}

/**
 * The project list behind a number, with the widget's scope. `range` narrows
 * the period to a bucket (UTC days); `status` opens the failure clusters on
 * one status.
 */
export function drillDownHref(
  list: DrillList,
  projectId: number,
  query: Record<string, string>,
  opts: { range?: { from: string; to: string }; status?: 'open' | 'resolved' } = {},
): string {
  const params = new URLSearchParams({ tab: LIST_TABS[list] });
  for (const key of CARRIED_KEYS) if (query[key]) params.set(key, query[key]!);
  if (opts.range) {
    params.set('period', encodePeriod({ kind: 'range', from: opts.range.from, to: opts.range.to }));
    // Buckets are UTC days, so their range resolves in UTC.
    params.set('tz', 'UTC');
  }
  if (opts.status) params.set('status', opts.status);
  params.set('source', 'analytics');
  return `/projects/${projectId}?${params.toString()}`;
}

/** What a project list takes from a drill-down address; null when the address came from elsewhere. */
export interface DrillScope {
  environments: string[];
  branches: string[];
  /** The analytics default: each project's default branch, plus runs with no known branch. */
  defaultBranchOnly: boolean;
  fullRunsOnly: boolean;
  /** The resolved period: instants, `to` exclusive. */
  period: { from: number; to: number; label: string } | null;
  status: 'open' | 'resolved' | null;
}

function list(value: unknown): string[] {
  return typeof value === 'string' && value ? value.split(',').filter(Boolean) : [];
}

/** Read a drill-down address; the period resolves in its `tz`, else the viewer's zone. */
/** The query keys `parseDrillQuery` reads. */
const DRILL_QUERY_KEYS = [
  'source',
  'period',
  'tz',
  'environments',
  'branches',
  'allBranches',
  'fullRunsOnly',
  'status',
];

/**
 * What identifies the drill-down a page's query carries, or null when it
 * carries none: a change of any other key (a tab, a page of a list) leaves it
 * the same, so the page does not apply the drill-down again.
 */
export function drillQueryKey(query: Record<string, unknown>): string | null {
  if (query.source !== 'analytics') return null;
  return JSON.stringify(DRILL_QUERY_KEYS.map((key) => query[key] ?? null));
}

export function parseDrillQuery(
  query: Record<string, unknown>,
  ctx: { now: number; timeZone: string; markers?: PeriodMarker[] },
): DrillScope | null {
  if (query.source !== 'analytics') return null;
  const branches = list(query.branches);
  const spec = parsePeriod(typeof query.period === 'string' ? query.period : null);
  const resolved = spec
    ? resolvePeriod(spec, {
        now: ctx.now,
        timeZone: typeof query.tz === 'string' && query.tz ? query.tz : ctx.timeZone,
        markers: ctx.markers,
      })
    : null;
  return {
    environments: list(query.environments),
    branches,
    defaultBranchOnly: branches.length === 0 && query.allBranches !== 'true',
    fullRunsOnly: query.fullRunsOnly !== 'false',
    period:
      resolved && !resolved.fallback
        ? { from: resolved.from.getTime(), to: resolved.to.getTime(), label: resolved.label }
        : null,
    status: query.status === 'open' || query.status === 'resolved' ? query.status : null,
  };
}

/**
 * With one project in scope, the list behind a bucket of a chart: its runs
 * (or another list) of that bucket's days. Null across projects.
 */
export function bucketDrill(
  query: Record<string, string>,
  bucketDays: number,
  list: DrillList = 'runs',
): ((date: string) => string) | null {
  const projectId = singleProjectOf(query);
  if (projectId === null) return null;
  return (date) => drillDownHref(list, projectId, query, { range: bucketRange(date, bucketDays) });
}
