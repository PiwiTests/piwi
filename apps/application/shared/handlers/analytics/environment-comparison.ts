import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsEnvironmentComparison } from '../../analytics/types';
import { environmentComparisonOptionsSchema } from '../../analytics/registry';
import { resolveCiCost } from '../ci-cost';
import { getAnalyticsContext, type ProjectAccess } from './common';
import { computeMetricBreakdown, type BreakdownRequest } from './metric-breakdown';
import { metricValue } from './metric-values';

/**
 * Pass rate and run success side by side per environment ("staging is green
 * and production is not"): each environment's values and change against the
 * comparison period, and its pass rate over time. The same breakdown the
 * metric widget computes by environment, from the daily rollups. With no
 * environment picked it compares every environment, never only each
 * project's default one.
 */
export async function getAnalyticsEnvironmentComparison(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
  rawOptions: unknown = {},
): Promise<AnalyticsEnvironmentComparison> {
  const { limit } = environmentComparisonOptionsSchema.parse(rawOptions ?? {});
  const compared = scope.environments?.length || scope.allEnvironments ? scope : { ...scope, allEnvironments: true };
  const ctx = await getAnalyticsContext(db, compared, access);
  const { cost } = await resolveCiCost(db);
  const base: Omit<BreakdownRequest, 'metric' | 'series'> = {
    dimension: 'environment',
    from: ctx.period.from.getTime(),
    to: ctx.period.to.getTime(),
    compare: ctx.comparison ? { from: ctx.comparison.from.getTime(), to: ctx.comparison.to.getTime() } : null,
    top: limit,
    cost,
  };
  const [passRate, runSuccess, runs] = await Promise.all([
    computeMetricBreakdown(db, ctx, { ...base, metric: 'test-pass-rate', series: true }),
    computeMetricBreakdown(db, ctx, { ...base, metric: 'run-success-rate', series: false }),
    computeMetricBreakdown(db, ctx, { ...base, metric: 'runs', series: false }),
  ]);
  const byKey = <T extends { key: string }>(list: T[]) => new Map(list.map((g) => [g.key, g]));
  const success = byKey(runSuccess);
  const counts = byKey(runs);
  return {
    bucketDays: ctx.buckets.bucketDays,
    rows: passRate
      .filter((g) => !g.other)
      .map((g) => {
        const s = success.get(g.key);
        return {
          environment: g.key,
          label: g.label,
          passRate: metricValue('test-pass-rate', g.value, g.previous, cost),
          runSuccessRate: metricValue('run-success-rate', s?.value ?? null, s?.previous ?? null, cost),
          runs: counts.get(g.key)?.value ?? 0,
          points: g.points ?? [],
        };
      }),
  };
}
