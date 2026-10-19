/**
 * Values of the metric catalog over a period: the numbers the `stats`,
 * `metric` and `verdict` widgets, the quality report and the MCP metric tools
 * show. Rollup metrics are summed from the scalar rows (the daily rollups, or
 * the matching executions under a test filter); live metrics read the failure
 * clusters, the quarantine and the stored executions; the hand-back metrics
 * read the outcome counts (`handbacks.ts`).
 */

import { and, countDistinct, eq, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { failureClusters, quarantinedTests, testRuns, testRunsCases } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import { getMetric, METRICS, type MetricDef, type MetricId } from '../../analytics/metrics';
import { costOfMinutes, type CiCost } from '../../ci-cost';
import type { AnalyticsMetricValue, AnalyticsSeriesPoint } from '../../analytics/types';
import {
  contextRunConditions,
  DAY_MS,
  fetchContextRuns,
  fetchFilteredExecutions,
  makeTimeBuckets,
  minutes,
  roundRate,
  type AnalyticsContext,
} from './common';
import { emptyRollupTotals, type RollupTotals } from './rollups';
import { groupRows, loadScalarRows } from './scalar-rows';
import {
  HANDBACK_METRIC_IDS,
  handbackMetricSeries,
  handbackMetricValue,
  hasHandbackSeries,
  isHandbackMetric,
  loadHandbackCounts,
} from './handbacks';
import { median } from '../../utils/stats';

/** The metrics summed from the scalar rows. */
const ROLLUP_VALUE: Partial<Record<MetricId, (t: RollupTotals, cost: CiCost | null) => number | null>> = {
  'test-pass-rate': (t) => roundRate(t.passedTests, t.totalTests),
  'run-success-rate': (t) => roundRate(t.passedRuns, t.runs),
  runs: (t) => t.runs,
  'suite-size': (t) => (t.runs > 0 ? t.maxTotalTests : null),
  'flaky-occurrences': (t) => t.flakyTests,
  'wasted-ci-minutes': (t) => minutes(t.waitMs + t.failedExecMs),
  'wasted-ci-cost': (t, cost) => (cost ? costOfMinutes(minutes(t.waitMs + t.failedExecMs), cost) : null),
  'ci-time': (t) => minutes(t.durationMs),
  'new-regressions': (t) => t.newRegressions,
  'newly-flaky': (t) => t.newFlaky,
  'average-run-duration': (t) => (t.durationRuns > 0 ? Math.round(t.durationMs / t.durationRuns) : null),
  'average-p90-test-duration': (t) =>
    t.testDurationRuns > 0 ? Math.round(t.p90TestDurationSumMs / t.testDurationRuns) : null,
};

const CLUSTER_METRICS = new Set<MetricId>([
  'open-failure-causes',
  'failure-causes-opened',
  'failure-causes-fixed',
  'median-time-to-fix',
  'oldest-open-failure-cause',
  'fixes-that-held',
]);

/** The metrics with a series over time (the `metric` widget's line display). */
const SERIES_METRICS = new Set<MetricId>([
  ...(Object.keys(ROLLUP_VALUE) as MetricId[]),
  'failure-causes-opened',
  'failure-causes-fixed',
  ...HANDBACK_METRIC_IDS.filter(hasHandbackSeries),
]);

/**
 * The metrics this release can compute. The Test Map metrics are left out
 * until the scenario-gaps widget reads them.
 */
export const EVALUATED_METRIC_IDS = METRICS.map((m) => m.id).filter(
  (id) =>
    id in ROLLUP_VALUE ||
    CLUSTER_METRICS.has(id) ||
    id === 'flaky-tests' ||
    id === 'quarantine-debt' ||
    isHandbackMetric(id),
) as MetricId[];

/** A metric summed from the scalar rows (the rollups, or the matching executions). */
export function isRollupMetric(id: MetricId): boolean {
  return id in ROLLUP_VALUE;
}

export function isClusterMetric(id: MetricId): boolean {
  return CLUSTER_METRICS.has(id);
}

/** A rollup metric's value over summed totals; null over no run (the run count excepted). */
export function rollupMetricValue(id: MetricId, totals: RollupTotals, cost: CiCost | null): number | null {
  const rollup = ROLLUP_VALUE[id];
  if (!rollup) return null;
  return totals.runs === 0 && id !== 'runs' ? null : rollup(totals, cost);
}

export function hasMetricSeries(id: MetricId): boolean {
  return SERIES_METRICS.has(id);
}

export interface ClusterRow {
  projectId: number;
  errorType: string | null;
  assignee: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  fixLandedAt: Date | null;
  timeToResolutionMs: number | null;
  fixVerification: string | null;
  snoozedUntil: Date | null;
}

function ms(value: Date | number | string | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Clusters that could matter to a period starting at `fromMs`: open ones, and any touched since. */
export async function loadClusters(db: DrizzleDB, ctx: AnalyticsContext, fromMs: number): Promise<ClusterRow[]> {
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return [];
  const since = new Date(fromMs);
  const conditions: SQL[] = [
    or(
      eq(failureClusters.status, 'open'),
      gte(failureClusters.createdAt, since),
      gte(failureClusters.updatedAt, since),
      gte(failureClusters.fixLandedAt, since),
    )!,
  ];
  if (ctx.allowed !== 'all') conditions.push(inArray(failureClusters.projectId, ctx.allowed));
  return db
    .select({
      projectId: failureClusters.projectId,
      errorType: failureClusters.errorType,
      assignee: failureClusters.assignee,
      status: failureClusters.status,
      createdAt: failureClusters.createdAt,
      updatedAt: failureClusters.updatedAt,
      fixLandedAt: failureClusters.fixLandedAt,
      timeToResolutionMs: failureClusters.timeToResolutionMs,
      fixVerification: failureClusters.fixVerification,
      snoozedUntil: failureClusters.snoozedUntil,
    })
    .from(failureClusters)
    .where(and(...conditions)) as Promise<ClusterRow[]>;
}

/**
 * Whether a cluster was open (and not snoozed) at `atMs`. For the present that
 * is its status; for a past instant, a cluster created before it whose fix had
 * not landed yet and that was not resolved or ignored by then.
 */
function openAt(cluster: ClusterRow, atMs: number, now: number): boolean {
  const created = ms(cluster.createdAt)!;
  if (created >= atMs) return false;
  if (atMs >= now) {
    const snoozed = ms(cluster.snoozedUntil);
    return cluster.status === 'open' && (snoozed === null || snoozed <= now);
  }
  const fixed = ms(cluster.fixLandedAt);
  if (fixed !== null && fixed < atMs) return false;
  if (cluster.status === 'open') return true;
  // Resolved or ignored: open at `atMs` only if that happened afterwards.
  return (ms(cluster.updatedAt) ?? 0) >= atMs;
}

function round(value: number, precision: number): number {
  const f = 10 ** precision;
  return Math.round(value * f) / f;
}

export function clusterValue(id: MetricId, clusters: ClusterRow[], fromMs: number, toMs: number, now: number) {
  const inPeriod = (t: number | null) => t !== null && t >= fromMs && t < toMs;
  const fixed = clusters.filter((c) => inPeriod(ms(c.fixLandedAt)));
  switch (id) {
    case 'open-failure-causes':
      return clusters.filter((c) => openAt(c, toMs, now)).length;
    case 'failure-causes-opened':
      return clusters.filter((c) => inPeriod(ms(c.createdAt))).length;
    case 'failure-causes-fixed':
      return fixed.length;
    case 'median-time-to-fix': {
      const m = median(fixed.map((c) => c.timeToResolutionMs).filter((v): v is number => v != null && v >= 0));
      return m === null ? null : round(m / DAY_MS, 1);
    }
    case 'oldest-open-failure-cause': {
      const end = Math.min(toMs, now);
      const ages = clusters.filter((c) => openAt(c, toMs, now)).map((c) => end - ms(c.createdAt)!);
      return ages.length === 0 ? null : Math.floor(Math.max(...ages) / DAY_MS);
    }
    case 'fixes-that-held':
      return fixed.length === 0
        ? null
        : roundRate(fixed.filter((c) => c.fixVerification !== 'regressed').length, fixed.length);
    default:
      return null;
  }
}

/** Distinct tests that passed only on a retry in the period, honoring the test filter. */
async function countFlakyTests(db: DrizzleDB, ctx: AnalyticsContext, fromMs: number, toMs: number) {
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return 0;
  if (ctx.testFilter) {
    const runs = await fetchContextRuns(db, ctx, fromMs, toMs);
    const executions = await fetchFilteredExecutions(db, ctx, runs);
    const projectOf = new Map(runs.map((r) => [r.id, r.projectId]));
    const flaky = new Set<string>();
    for (const e of executions) {
      if (e.status === 'passed' && (e.retries ?? 0) > 0) flaky.add(`${projectOf.get(e.testRunId)}:${e.testCaseId}`);
    }
    return flaky.size;
  }
  const [row] = await db
    .select({ n: countDistinct(testRunsCases.testCaseId) })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(
      and(
        ...contextRunConditions(ctx, fromMs, toMs),
        eq(testRunsCases.status, 'passed'),
        sql`${testRunsCases.retries} > 0`,
      ),
    );
  return Number(row?.n ?? 0);
}

/** Tests in quarantine at the end of the period (today's count when the period ends now). */
async function countQuarantine(db: DrizzleDB, ctx: AnalyticsContext, toMs: number) {
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return 0;
  const end = new Date(Math.min(toMs, ctx.now + 1));
  const conditions: SQL[] = [
    lt(quarantinedTests.createdAt, end),
    or(isNull(quarantinedTests.releasedAt), gte(quarantinedTests.releasedAt, end))!,
  ];
  if (ctx.allowed !== 'all') conditions.push(inArray(quarantinedTests.projectId, ctx.allowed));
  const rows: { projectId: number; testCaseId: number }[] = await db
    .select({ projectId: quarantinedTests.projectId, testCaseId: quarantinedTests.testCaseId })
    .from(quarantinedTests)
    .where(and(...conditions));
  const ids = ctx.testFilter?.testCaseIds;
  return ids ? rows.filter((r) => ids.get(r.projectId)?.has(r.testCaseId)).length : rows.length;
}

export interface MetricValueOptions {
  cost: CiCost | null;
  /** Filled with the sample size of each rate that has a sample floor. */
  samples?: Map<MetricId, number>;
}

/** The value of each metric over `[fromMs, toMs)`; null where the metric has nothing to count. */
export async function computeMetricValues(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  ids: readonly MetricId[],
  fromMs: number,
  toMs: number,
  options: MetricValueOptions,
): Promise<Map<MetricId, number | null>> {
  const out = new Map<MetricId, number | null>();
  const wanted = [...new Set(ids)];
  // Flaky tests need the rows too: with no run in the range there is nothing to compare, not zero.
  const needsRows = wanted.some((id) => id in ROLLUP_VALUE || id === 'flaky-tests');
  const needsClusters = wanted.some((id) => CLUSTER_METRICS.has(id));
  const needsHandbacks = wanted.some(isHandbackMetric);

  const [rows, clusters, flaky, quarantine, handbacks] = await Promise.all([
    needsRows ? loadScalarRows(db, ctx, fromMs, toMs) : Promise.resolve([]),
    needsClusters ? loadClusters(db, ctx, fromMs) : Promise.resolve([]),
    wanted.includes('flaky-tests') ? countFlakyTests(db, ctx, fromMs, toMs) : Promise.resolve(null),
    wanted.includes('quarantine-debt') ? countQuarantine(db, ctx, toMs) : Promise.resolve(null),
    needsHandbacks ? loadHandbackCounts(db, ctx, fromMs, toMs) : Promise.resolve(null),
  ]);
  const totals = groupRows(rows, () => 'all').get('all') ?? emptyRollupTotals();

  for (const id of wanted) {
    const rollup = ROLLUP_VALUE[id];
    if (rollup) out.set(id, totals.runs === 0 && id !== 'runs' ? null : rollup(totals, options.cost));
    else if (id === 'flaky-tests' && totals.runs === 0) out.set(id, null);
    else if (CLUSTER_METRICS.has(id)) out.set(id, clusterValue(id, clusters, fromMs, toMs, ctx.now));
    else if (id === 'flaky-tests') out.set(id, flaky);
    else if (id === 'quarantine-debt') out.set(id, quarantine);
    else if (isHandbackMetric(id) && handbacks) {
      const { value, sample } = handbackMetricValue(id, handbacks);
      out.set(id, value);
      if (sample !== null) options.samples?.set(id, sample);
    } else out.set(id, null);
  }
  return out;
}

/** One metric bucketed over `[fromMs, toMs)`, or null for a metric with no series. */
export async function computeMetricSeries(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  id: MetricId,
  fromMs: number,
  toMs: number,
  options: MetricValueOptions,
): Promise<AnalyticsSeriesPoint[] | null> {
  if (!SERIES_METRICS.has(id)) return null;
  if (isHandbackMetric(id)) return handbackMetricSeries(db, ctx, id, fromMs, toMs);
  const buckets = makeTimeBuckets(fromMs, toMs, ctx.scope.granularity);
  const rollup = ROLLUP_VALUE[id];
  if (rollup) {
    const rows = await loadScalarRows(db, ctx, fromMs, toMs);
    const byBucket = groupRows(rows, (row) => buckets.keyFor(row.day));
    return buckets.keys.map((date) => {
      const totals = byBucket.get(date);
      return { date, value: totals && totals.runs > 0 ? rollup(totals, options.cost) : null };
    });
  }
  const clusters = await loadClusters(db, ctx, fromMs);
  const counts = new Map<string, number>();
  for (const c of clusters) {
    const t = ms(id === 'failure-causes-opened' ? c.createdAt : c.fixLandedAt);
    if (t === null || t < fromMs || t >= toMs) continue;
    const key = buckets.keyFor(t);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return buckets.keys.map((date) => ({ date, value: counts.get(date) ?? 0 }));
}

/** Whether a change reads as better, worse or neither for this metric. */
function metricTrend(def: MetricDef, delta: number | null): AnalyticsMetricValue['trend'] {
  if (delta === null || delta === 0 || def.betterWhen === 'neutral') return delta === null ? null : 'same';
  const up = delta > 0;
  return (def.betterWhen === 'higher') === up ? 'better' : 'worse';
}

/**
 * A metric's value with its comparison: the change in points for a percentage,
 * in the metric's unit otherwise, and the relative change when the previous
 * value is not zero. A rate with a sample floor carries the size of its sample.
 */
export function metricValue(
  id: MetricId,
  value: number | null,
  previous: number | null,
  cost: CiCost | null,
  sampleSize?: number,
): AnalyticsMetricValue {
  const def = getMetric(id);
  const delta = value !== null && previous !== null ? round(value - previous, def.precision) : null;
  const deltaPct =
    value !== null && previous !== null && previous !== 0 && def.unit !== 'percent'
      ? Math.round(((value - previous) / Math.abs(previous)) * 100)
      : null;
  return {
    metric: id,
    label: def.label,
    unit: def.unit,
    betterWhen: def.betterWhen,
    definition: def.definition,
    precision: def.precision,
    source: def.source,
    value,
    previous,
    delta,
    deltaPct,
    trend: metricTrend(def, delta),
    currency: def.unit === 'money' ? (cost?.currency ?? null) : null,
    ...(def.minSample ? { sample: sampleSize === undefined ? null : { size: sampleSize, min: def.minSample } } : {}),
  };
}
