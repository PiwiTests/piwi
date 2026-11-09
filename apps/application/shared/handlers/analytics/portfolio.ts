import { and, count, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { failureClusters } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsPortfolioRow } from '../../analytics/types';
import {
  fetchContextProjects,
  fetchContextRuns,
  fetchTagsByProject,
  getAnalyticsContext,
  FAILING_RUN_STATUSES,
  type ProjectAccess,
  type ScopedRun,
} from './common';
import { passRatePercent } from '../../utils/pass-rate';
import { groupRows, loadScalarRows } from './scalar-rows';
import { evaluateTargets } from './targets';
import { resolveCiCost } from '../ci-cost';

const SPARKLINE_RUNS = 20;

/**
 * Per-project health over the period: pass rate (+ delta vs the comparison
 * period), flaky volume, open clusters, failing streak, and the recent-run
 * bars — one row per project the caller can see. The numbers come from the
 * scalar rows (rollups, or executions under a test filter); the streak, the
 * latest run and the bars are the stored runs of the period.
 */
export async function getAnalyticsPortfolio(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsPortfolioRow[]> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const scopedProjects = await fetchContextProjects(db, ctx);
  if (scopedProjects.length === 0) return [];
  const projectIds = scopedProjects.map((p) => p.id);
  const { from, to } = ctx.period;

  const { cost } = await resolveCiCost(db);
  const [currentRows, previousRows, runs, tagsByProject, clusterRows, targets] = await Promise.all([
    loadScalarRows(db, ctx, from.getTime(), to.getTime()),
    ctx.comparison
      ? loadScalarRows(db, ctx, ctx.comparison.from.getTime(), ctx.comparison.to.getTime())
      : Promise.resolve([]),
    fetchContextRuns(db, ctx, from.getTime(), to.getTime()),
    fetchTagsByProject(db, projectIds),
    db
      .select({ projectId: failureClusters.projectId, openCount: count() })
      .from(failureClusters)
      // A snoozed cluster is not failing now — leave it out of the open count.
      .where(
        and(
          inArray(failureClusters.projectId, projectIds),
          eq(failureClusters.status, 'open'),
          or(isNull(failureClusters.snoozedUntil), lte(failureClusters.snoozedUntil, new Date())),
        ),
      )
      .groupBy(failureClusters.projectId) as Promise<any[]>,
    evaluateTargets(db, ctx, cost),
  ]);

  const openClustersByProject = new Map<number, number>();
  for (const row of clusterRows) openClustersByProject.set(row.projectId, Number(row.openCount));

  const current = groupRows(currentRows, (row) => row.projectId);
  const previous = groupRows(previousRows, (row) => row.projectId);
  const runsByProject = new Map<number, ScopedRun[]>();
  for (const run of runs) {
    const list = runsByProject.get(run.projectId) ?? [];
    list.push(run);
    runsByProject.set(run.projectId, list);
  }

  const rows = scopedProjects.map((project): AnalyticsPortfolioRow => {
    const totals = current.get(project.id);
    const prevTotals = previous.get(project.id);
    const projectRuns = runsByProject.get(project.id) ?? [];

    const passRate = totals ? passRatePercent({ passed: totals.passedTests, failed: totals.failedTests }, 1) : null;
    const prevPassRate = prevTotals
      ? passRatePercent({ passed: prevTotals.passedTests, failed: prevTotals.failedTests }, 1)
      : null;
    const passRateDelta =
      passRate !== null && prevPassRate !== null ? Math.round((passRate - prevPassRate) * 10) / 10 : null;

    let failingStreak = 0;
    for (let i = projectRuns.length - 1; i >= 0; i--) {
      if (!FAILING_RUN_STATUSES.includes(projectRuns[i]!.status)) break;
      failingStreak++;
    }

    const latest = projectRuns.length > 0 ? projectRuns[projectRuns.length - 1]! : null;
    const runCount = totals?.runs ?? 0;

    return {
      projectId: project.id,
      name: project.name,
      label: project.label,
      tags: tagsByProject.get(project.id) ?? [],
      runCount,
      passRate,
      passRateDelta,
      flakyTests: totals?.flakyTests ?? 0,
      avgRunDurationMs: totals && totals.durationRuns > 0 ? Math.round(totals.durationMs / totals.durationRuns) : null,
      openClusters: openClustersByProject.get(project.id) ?? 0,
      failingStreak,
      latestRun: latest ? { id: latest.id, status: latest.status, startTime: latest.startTime } : null,
      recentRuns: projectRuns.slice(-SPARKLINE_RUNS).map((r) => ({
        id: r.id,
        status: r.status,
        passedTests: r.passedTests ?? 0,
        failedTests: r.failedTests ?? 0,
        flakyTests: r.flakyTests ?? 0,
        totalTests: r.totalTests ?? 0,
        startTime: r.startTime,
      })),
      targets: targets.filter((t) => t.projectId === project.id),
    };
  });

  // Worst health first: failing streaks, then lowest pass rate; idle projects last.
  return rows.sort((a, b) => {
    if ((b.runCount === 0) !== (a.runCount === 0)) return a.runCount === 0 ? 1 : -1;
    if (b.failingStreak !== a.failingStreak) return b.failingStreak - a.failingStreak;
    return (a.passRate ?? 101) - (b.passRate ?? 101);
  });
}
