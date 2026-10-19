import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsTimeToFix } from '../../analytics/types';
import { DAY_MS, firstNonEmptyIndex, getAnalyticsContext, roundRate, type ProjectAccess } from './common';
import { clusterValue, loadClusters, type ClusterRow } from './metric-values';
import { percentile } from '../../utils/stats';

/**
 * The age buckets of open failure causes, youngest first; `maxDays` is
 * exclusive, null for the last group. A report translates their labels.
 */
export const AGE_GROUPS: Array<{ label: string; maxDays: number | null }> = [
  { label: 'Under a day', maxDays: 1 },
  { label: '1 to 7 days', maxDays: 7 },
  { label: '7 to 30 days', maxDays: 30 },
  { label: '30 to 90 days', maxDays: 90 },
  { label: 'Over 90 days', maxDays: null },
];

function ms(value: Date | number | string | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

const toDays = (value: number | null) => (value === null ? null : Math.round((value / DAY_MS) * 10) / 10);

/**
 * How fast failures get fixed: failure causes opened and fixed per bucket, the
 * median and 90th percentile time to fix over the causes fixed in the period
 * (with the comparison period's median), the share of fixes that held, and
 * the open causes by age. Failure clusters outlive run retention, so this
 * reaches as far back as the clusters do.
 */
export async function getAnalyticsTimeToFix(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsTimeToFix> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const from = ctx.period.from.getTime();
  const to = ctx.period.to.getTime();
  const comparison = ctx.comparison;
  const clusters: ClusterRow[] = await loadClusters(db, ctx, Math.min(from, comparison?.from.getTime() ?? from));

  const buckets = ctx.buckets;
  const opened = new Map<string, number>();
  const fixed = new Map<string, number>();
  for (const c of clusters) {
    const created = ms(c.createdAt);
    const fixLanded = ms(c.fixLandedAt);
    const openedKey = created !== null && created >= from && created < to ? buckets.keyFor(created) : null;
    const fixedKey = fixLanded !== null && fixLanded >= from && fixLanded < to ? buckets.keyFor(fixLanded) : null;
    if (openedKey) opened.set(openedKey, (opened.get(openedKey) ?? 0) + 1);
    if (fixedKey) fixed.set(fixedKey, (fixed.get(fixedKey) ?? 0) + 1);
  }
  const points = buckets.keys.map((date) => ({ date, opened: opened.get(date) ?? 0, fixed: fixed.get(date) ?? 0 }));

  const fixedInPeriod = clusters.filter((c) => {
    const t = ms(c.fixLandedAt);
    return t !== null && t >= from && t < to;
  });
  const durations = fixedInPeriod.map((c) => c.timeToResolutionMs).filter((v): v is number => v != null && v >= 0);

  const now = ctx.now;
  const openAges = clusters
    .filter((c) => c.status === 'open' && (ms(c.snoozedUntil) === null || ms(c.snoozedUntil)! <= now))
    .map((c) => (Math.min(to, now) - ms(c.createdAt)!) / DAY_MS);
  const openByAge = AGE_GROUPS.map((group, i) => {
    const min = i === 0 ? -Infinity : AGE_GROUPS[i - 1]!.maxDays!;
    const max = group.maxDays ?? Infinity;
    return { label: group.label, count: openAges.filter((age) => age >= min && age < max).length };
  });

  return {
    points: points.slice(firstNonEmptyIndex(points, (p) => p.opened === 0 && p.fixed === 0)),
    bucketDays: buckets.bucketDays,
    opened: clusters.filter((c) => {
      const t = ms(c.createdAt);
      return t !== null && t >= from && t < to;
    }).length,
    fixed: fixedInPeriod.length,
    medianDays: clusterValue('median-time-to-fix', clusters, from, to, now) as number | null,
    p90Days: toDays(
      durations.length === 0
        ? null
        : percentile(
            [...durations].sort((a, b) => a - b),
            90,
          ),
    ),
    previousMedianDays: comparison
      ? (clusterValue('median-time-to-fix', clusters, comparison.from.getTime(), comparison.to.getTime(), now) as
          | number
          | null)
      : null,
    fixesHeldPct:
      fixedInPeriod.length === 0
        ? null
        : roundRate(fixedInPeriod.filter((c) => c.fixVerification !== 'regressed').length, fixedInPeriod.length),
    openByAge,
  };
}
