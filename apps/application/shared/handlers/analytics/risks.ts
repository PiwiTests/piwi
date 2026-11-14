import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { failureClusters, projects, quarantinedTests } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { MetricId } from '../../analytics/metrics';
import type { AnalyticsRiskMetric, AnalyticsRisks } from '../../analytics/types';
import { resolveCiCost } from '../ci-cost';
import { DAY_MS, getAnalyticsContext, type ProjectAccess } from './common';
import { computeMetricValues, metricValue } from './metric-values';
import { getAnalyticsPortfolio } from './portfolio';
import { evaluateTargets } from './targets';

const OLDEST_OPEN = 5;
/** A failing streak this long or longer is a risk. */
const RISKY_STREAK = 3;

/**
 * How far a metric may move the wrong way before it is a risk: in points for
 * a percentage, as a relative change for a count or a duration.
 */
const WORSENING: Array<{ metric: MetricId; points?: number; pct?: number }> = [
  { metric: 'test-pass-rate', points: 1 },
  { metric: 'run-success-rate', points: 5 },
  { metric: 'flaky-tests', pct: 20 },
  { metric: 'wasted-ci-minutes', pct: 25 },
  { metric: 'new-regressions', pct: 25 },
];

/** Whole days from `at` to `now`; a date past `now` (clock skew, imported rows) counts as today. */
function daysSince(at: Date | string | number, now: number): number {
  return Math.max(0, Math.floor((now - new Date(at).getTime()) / DAY_MS));
}

/**
 * What could go wrong next: metrics moving the wrong way against the
 * comparison period, projects failing run after run, the oldest open failure
 * clusters and the quarantine debt.
 */
export async function getAnalyticsRisks(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsRisks> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const empty: AnalyticsRisks = {
    worsening: [],
    failingProjects: [],
    oldestOpen: [],
    openCount: 0,
    quarantine: { count: 0, oldestDays: null },
    missedTargets: [],
  };
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return empty;
  const { cost } = await resolveCiCost(db);
  const ids = WORSENING.map((w) => w.metric);
  const now = new Date(ctx.now);
  const projectFilter = (column: any) => (ctx.allowed === 'all' ? undefined : inArray(column, ctx.allowed));

  const [current, previous, portfolio, openRows, quarantineRows, targets] = await Promise.all([
    computeMetricValues(db, ctx, ids, ctx.period.from.getTime(), ctx.period.to.getTime(), { cost }),
    ctx.comparison
      ? computeMetricValues(db, ctx, ids, ctx.comparison.from.getTime(), ctx.comparison.to.getTime(), { cost })
      : Promise.resolve(null),
    getAnalyticsPortfolio(db, scope, access),
    db
      .select({
        id: failureClusters.id,
        projectId: failureClusters.projectId,
        projectName: projects.name,
        projectLabel: projects.label,
        title: failureClusters.title,
        signature: failureClusters.signature,
        createdAt: failureClusters.createdAt,
        assignee: failureClusters.assignee,
        occurrences: failureClusters.occurrences,
      })
      .from(failureClusters)
      .innerJoin(projects, eq(failureClusters.projectId, projects.id))
      .where(
        and(
          eq(failureClusters.status, 'open'),
          or(isNull(failureClusters.snoozedUntil), lte(failureClusters.snoozedUntil, now)),
          projectFilter(failureClusters.projectId),
        ),
      )
      .orderBy(asc(failureClusters.createdAt)) as Promise<any[]>,
    db
      .select({ createdAt: quarantinedTests.createdAt })
      .from(quarantinedTests)
      .where(and(isNull(quarantinedTests.releasedAt), projectFilter(quarantinedTests.projectId)))
      .orderBy(asc(quarantinedTests.createdAt)) as Promise<{ createdAt: Date }[]>,
    evaluateTargets(db, ctx, cost),
  ]);

  const worsening: AnalyticsRiskMetric[] = [];
  if (previous) {
    for (const rule of WORSENING) {
      const v = metricValue(rule.metric, current.get(rule.metric) ?? null, previous.get(rule.metric) ?? null, cost);
      if (v.trend !== 'worse' || v.delta === null) continue;
      const beyond =
        rule.points !== undefined
          ? Math.abs(v.delta) >= rule.points
          : v.deltaPct !== null && Math.abs(v.deltaPct) >= (rule.pct ?? 0);
      if (!beyond) continue;
      worsening.push({
        metric: v.metric,
        label: v.label,
        unit: v.unit,
        value: v.value,
        previous: v.previous,
        delta: v.delta,
        deltaPct: v.deltaPct,
      });
    }
  }

  const oldestQuarantine = quarantineRows[0]?.createdAt;
  return {
    worsening,
    failingProjects: portfolio
      .filter((row) => row.failingStreak >= RISKY_STREAK)
      .map((row) => ({ projectId: row.projectId, name: row.label || row.name, streak: row.failingStreak }))
      .sort((a, b) => b.streak - a.streak),
    oldestOpen: openRows.slice(0, OLDEST_OPEN).map((r) => ({
      id: r.id,
      projectId: r.projectId,
      projectName: r.projectLabel || r.projectName,
      title: r.title || r.signature,
      ageDays: daysSince(r.createdAt, ctx.now),
      assignee: r.assignee ?? null,
      occurrences: r.occurrences ?? 0,
    })),
    openCount: openRows.length,
    quarantine: {
      count: quarantineRows.length,
      oldestDays: oldestQuarantine ? daysSince(oldestQuarantine, ctx.now) : null,
    },
    missedTargets: targets.filter((t) => t.met === false),
  };
}
