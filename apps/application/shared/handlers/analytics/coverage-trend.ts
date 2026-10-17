import { and, inArray, lte } from 'drizzle-orm';
import { coverageDaily, projects } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsCoverageTrend } from '../../analytics/types';
import type { CoverageTrendOptions } from '../../analytics/registry';
import { parseCoverageAreas } from '@piwitests/core/coverage-scope';
import { COMBINED_SUITE, coveragePercent } from '../../coverage-combine';
import { resolveProjectStates } from '../capabilities';
import { dayKey, firstNonEmptyIndex, getAnalyticsContext, type AnalyticsContext, type ProjectAccess } from './common';

/** One series of `coverage_daily`: a project on one branch, its days ascending. */
type Series = Array<{ day: string; executed: number; executable: number }>;

/** Days a series' last value counts after its last day: a suite, an area or a project that stopped reporting drops out. */
const SERIES_HORIZON_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The branch tags of `coverage_daily` a project counts under the scope's
 * branch policy: `''` (its default branch) for the default policy and for
 * any branch, the listed branches otherwise, its default branch's as `''`.
 */
function branchTags(ctx: AnalyticsContext, defaultBranch: string | null): string[] {
  if (ctx.branchPolicy.kind !== 'list') return [''];
  return [...new Set(ctx.branchPolicy.branches.map((b) => (b === defaultBranch ? '' : b)))];
}

/** The newest value of a series on or before `day`, within the horizon. */
function asOf(series: Series, day: string): Series[number] | null {
  let found: Series[number] | null = null;
  for (const row of series) {
    if (row.day > day) break;
    found = row;
  }
  if (!found) return null;
  const age = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${found.day}T00:00:00Z`)) / DAY_MS;
  return age <= SERIES_HORIZON_DAYS ? found : null;
}

/**
 * Combined line coverage over time: per bucket, the lines every suite ran
 * together over the executable lines, summed over the projects of the scope
 * with coverage on, each at its newest day with coverage on or before the
 * bucket's end (at most thirty days before it) on the first branch of the
 * policy that has one, and the same for each suite by name, or with
 * `split: 'areas'` for each area the projects name now. Read from
 * `coverage_daily`, which keeps the totals after the reports they came from
 * are pruned.
 */
export async function getAnalyticsCoverageTrend(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
  options: Partial<CoverageTrendOptions> = {},
): Promise<AnalyticsCoverageTrend> {
  const split = options.split ?? 'suites';
  const ctx = await getAnalyticsContext(db, scope, access);
  const empty: AnalyticsCoverageTrend = {
    points: [],
    bucketDays: ctx.buckets.bucketDays,
    linePercent: null,
    previousLinePercent: null,
    delta: null,
    executedLines: 0,
    executableLines: 0,
    split,
    series: [],
    projects: 0,
    declined: 0,
  };
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return empty;

  const rows = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch, areas: projects.coverageAreas })
    .from(projects)
    .where(ctx.allowed === 'all' ? undefined : inArray(projects.id, ctx.allowed));
  const included: typeof rows = [];
  let declined = 0;
  for (const row of rows) {
    const state = (await resolveProjectStates(db, row.id)).coverage;
    if (state === 'declined' || state === 'not-applicable') declined++;
    else included.push(row);
  }
  if (included.length === 0) return { ...empty, declined };

  const toDay = dayKey(Math.max(ctx.period.from.getTime(), ctx.period.to.getTime() - 1));
  const daily = await db
    .select({
      projectId: coverageDaily.projectId,
      branch: coverageDaily.branch,
      suite: coverageDaily.suite,
      area: coverageDaily.area,
      day: coverageDaily.day,
      executed: coverageDaily.executedLines,
      executable: coverageDaily.executableLines,
    })
    .from(coverageDaily)
    .where(
      and(
        inArray(
          coverageDaily.projectId,
          included.map((p) => p.id),
        ),
        lte(coverageDaily.day, toDay),
      ),
    );

  const branchesOf = new Map(included.map((p) => [p.id, branchTags(ctx, p.defaultBranch)]));
  const areasOf = new Map(
    included.map((p) => [p.id, new Set(((p.areas ? parseCoverageAreas(p.areas) : null) ?? []).map((a) => a.name))]),
  );
  // Per line of the chart (every suite together, then each suite or area), per project, one series per branch.
  const lineOf = (row: { projectId: number; suite: string; area: string }): string | null => {
    if (row.area === '' && row.suite === COMBINED_SUITE) return COMBINED_SUITE;
    if (split === 'areas') {
      return row.suite === COMBINED_SUITE && areasOf.get(row.projectId)?.has(row.area) ? row.area : null;
    }
    return row.area === '' ? row.suite : null;
  };
  const byLine = new Map<string, Map<number, Map<string, Series>>>();
  for (const row of daily) {
    if (!branchesOf.get(row.projectId)?.includes(row.branch)) continue;
    const line = lineOf(row);
    if (line === null) continue;
    const perProject = byLine.get(line) ?? new Map<number, Map<string, Series>>();
    const perBranch = perProject.get(row.projectId) ?? new Map<string, Series>();
    perBranch.set(row.branch, [
      ...(perBranch.get(row.branch) ?? []),
      { day: row.day, executed: row.executed, executable: row.executable },
    ]);
    perProject.set(row.projectId, perBranch);
    byLine.set(line, perProject);
  }
  /** Per project of a line, its series in the order of the policy's branches. */
  const seriesOf = (line: string): Series[][] =>
    [...(byLine.get(line) ?? new Map<number, Map<string, Series>>())].map(([projectId, perBranch]) =>
      branchesOf.get(projectId)!.flatMap((branch) => {
        const list = perBranch.get(branch);
        return list ? [list.sort((a, b) => a.day.localeCompare(b.day))] : [];
      }),
    );
  const combinedSeries = seriesOf(COMBINED_SUITE);

  // A project counts once per bucket: the first branch of the policy with a value then.
  const totalAsOf = (day: string, of: Series[][] = combinedSeries) => {
    let executed = 0;
    let executable = 0;
    let any = false;
    for (const branches of of) {
      const value = branches.map((list) => asOf(list, day)).find((v) => v !== null);
      if (!value) continue;
      any = true;
      executed += value.executed;
      executable += value.executable;
    }
    return { any, executed, executable };
  };

  const keys = ctx.buckets.keys;
  const ends = keys.map((_, i) => {
    const next = keys[i + 1];
    return next ? dayKey(Date.parse(`${next}T00:00:00Z`) - 1) : toDay;
  });
  const points = keys.map((date, i) => {
    const total = totalAsOf(ends[i]!);
    return {
      date,
      linePercent: total.any ? coveragePercent(total.executed, total.executable) : null,
      executedLines: total.executed,
      executableLines: total.executable,
    };
  });

  const first = firstNonEmptyIndex(points, (p) => p.linePercent === null);
  const percentOf = (total: { any: boolean; executed: number; executable: number }) =>
    total.any ? coveragePercent(total.executed, total.executable) : null;
  const lines = [...byLine.keys()]
    .filter((name) => name !== COMBINED_SUITE)
    .sort()
    .map((name) => {
      const of = seriesOf(name);
      return {
        name,
        points: keys.map((date, i) => ({ date, linePercent: percentOf(totalAsOf(ends[i]!, of)) })).slice(first),
        linePercent: percentOf(totalAsOf(toDay, of)),
      };
    })
    // A suite or an area with no value in the period draws no line.
    .filter((line) => line.linePercent !== null || line.points.some((p) => p.linePercent !== null));

  const current = totalAsOf(toDay);
  const linePercent = current.any ? coveragePercent(current.executed, current.executable) : null;
  const previous = ctx.comparison
    ? totalAsOf(dayKey(Math.max(ctx.comparison.from.getTime(), ctx.comparison.to.getTime() - 1)))
    : null;
  const previousLinePercent = previous?.any ? coveragePercent(previous.executed, previous.executable) : null;
  return {
    points: points.slice(first),
    bucketDays: ctx.buckets.bucketDays,
    linePercent,
    previousLinePercent,
    delta:
      linePercent !== null && previousLinePercent !== null
        ? Math.round((linePercent - previousLinePercent) * 10) / 10
        : null,
    executedLines: current.executed,
    executableLines: current.executable,
    split,
    series: lines,
    projects: included.length,
    declined,
  };
}
