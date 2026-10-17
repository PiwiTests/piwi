import { and, inArray, lte } from 'drizzle-orm';
import { coverageDaily, projects } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsCoverageTrend } from '../../analytics/types';
import { COMBINED_SUITE, coveragePercent } from '../../coverage-combine';
import { resolveProjectStates } from '../capabilities';
import { dayKey, firstNonEmptyIndex, getAnalyticsContext, type AnalyticsContext, type ProjectAccess } from './common';

/** One series of `coverage_daily`: a project on one branch, its days ascending. */
type Series = Array<{ day: string; executed: number; executable: number }>;

/**
 * The branch tags of `coverage_daily` a project counts under the scope's
 * branch policy: `''` (its default branch) for the default policy and for
 * any branch, the listed branches otherwise, its default branch's as `''`.
 */
function branchTags(ctx: AnalyticsContext, defaultBranch: string | null): string[] {
  if (ctx.branchPolicy.kind !== 'list') return [''];
  return [...new Set(ctx.branchPolicy.branches.map((b) => (b === defaultBranch ? '' : b)))];
}

/** The newest value of a series on or before `day`. */
function asOf(series: Series, day: string): Series[number] | null {
  let found: Series[number] | null = null;
  for (const row of series) {
    if (row.day > day) break;
    found = row;
  }
  return found;
}

/**
 * Combined line coverage over time: per bucket, the lines every suite ran
 * together over the executable lines, summed over the projects of the scope
 * with coverage on, each at its newest day with coverage on or before the
 * bucket's end, and the same for each suite by name. Read from
 * `coverage_daily`, which keeps the totals after the reports they came from
 * are pruned.
 */
export async function getAnalyticsCoverageTrend(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsCoverageTrend> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const empty: AnalyticsCoverageTrend = {
    points: [],
    bucketDays: ctx.buckets.bucketDays,
    linePercent: null,
    previousLinePercent: null,
    delta: null,
    executedLines: 0,
    executableLines: 0,
    suites: [],
    projects: 0,
    declined: 0,
  };
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return empty;

  const rows = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
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

  const wanted = new Map(included.map((p) => [p.id, new Set(branchTags(ctx, p.defaultBranch))]));
  // Per suite, one series per project and branch.
  const bySuite = new Map<string, Map<string, Series>>();
  for (const row of daily) {
    if (!wanted.get(row.projectId)?.has(row.branch)) continue;
    const key = `${row.projectId}\0${row.branch}`;
    const suite = bySuite.get(row.suite) ?? new Map<string, Series>();
    suite.set(key, [...(suite.get(key) ?? []), { day: row.day, executed: row.executed, executable: row.executable }]);
    bySuite.set(row.suite, suite);
  }
  const seriesOf = (suite: string) =>
    [...(bySuite.get(suite)?.values() ?? [])].map((list) => list.sort((a, b) => a.day.localeCompare(b.day)));
  const series = seriesOf(COMBINED_SUITE);

  const totalAsOf = (day: string, of: Series[] = series) => {
    let executed = 0;
    let executable = 0;
    let any = false;
    for (const list of of) {
      const value = asOf(list, day);
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
  const suites = [...bySuite.keys()]
    .filter((name) => name !== COMBINED_SUITE)
    .sort()
    .map((name) => {
      const of = seriesOf(name);
      return {
        name,
        points: keys.map((date, i) => ({ date, linePercent: percentOf(totalAsOf(ends[i]!, of)) })).slice(first),
        linePercent: percentOf(totalAsOf(toDay, of)),
      };
    });

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
    suites,
    projects: included.length,
    declined,
  };
}
