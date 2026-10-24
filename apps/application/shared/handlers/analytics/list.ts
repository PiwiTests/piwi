import { and, desc, eq, inArray } from 'drizzle-orm';
import { failureClusters, projects, scenarioGaps } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsList, AnalyticsListItem } from '../../analytics/types';
import { listOptionsSchema } from '../../analytics/registry';
import { fetchContextRuns, getAnalyticsContext, type ProjectAccess } from './common';
import { getAnalyticsFlakyLeaderboard } from './flaky-leaderboard';
import { testMapProjects } from './scenario-gaps';

const iso = (value: Date | string | number | null | undefined) =>
  value == null ? null : new Date(value).toISOString();

async function projectNames(db: DrizzleDB, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows: { id: number; name: string; label: string | null }[] = await db
    .select({ id: projects.id, name: projects.name, label: projects.label })
    .from(projects)
    .where(inArray(projects.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.label || r.name]));
}

/**
 * The top items matching the scope: the latest runs of the period, the open
 * failure causes with the most occurrences, the flakiest tests, or the
 * highest-scored open scenario gaps (in projects that keep the Test Map).
 */
export async function getAnalyticsList(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
  rawOptions: unknown = {},
): Promise<AnalyticsList> {
  const { source, limit } = listOptionsSchema.parse(rawOptions ?? {});
  const ctx = await getAnalyticsContext(db, scope, access);
  const none = ctx.allowed !== 'all' && ctx.allowed.length === 0;
  const empty: AnalyticsList = { source, items: [], declined: 0 };
  if (none) return empty;

  if (source === 'runs') {
    const runs = (await fetchContextRuns(db, ctx, ctx.period.from.getTime(), ctx.period.to.getTime()))
      .slice(-limit)
      .reverse();
    const names = await projectNames(
      db,
      runs.map((r) => r.projectId),
    );
    return {
      ...empty,
      items: runs.map((r): AnalyticsListItem => ({
        id: r.id,
        title: `Run #${r.id}`,
        detail: [
          r.status,
          `${r.passedTests}/${r.totalTests} passed`,
          r.branch ? `on ${r.branch}` : null,
          r.environment ? `in ${r.environment}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        projectName: names.get(r.projectId) ?? '',
        at: iso(r.startTime),
        href: `/test-runs/${r.id}`,
        facts: {
          source: 'runs',
          id: r.id,
          status: r.status,
          passed: r.passedTests,
          total: r.totalTests,
          branch: r.branch ?? null,
          environment: r.environment ?? null,
        },
      })),
    };
  }

  if (source === 'failure-clusters') {
    const rows = await db
      .select({
        id: failureClusters.id,
        projectId: failureClusters.projectId,
        title: failureClusters.title,
        errorType: failureClusters.errorType,
        occurrences: failureClusters.occurrences,
        assignee: failureClusters.assignee,
        updatedAt: failureClusters.updatedAt,
      })
      .from(failureClusters)
      .where(
        and(
          eq(failureClusters.status, 'open'),
          ctx.allowed === 'all' ? undefined : inArray(failureClusters.projectId, ctx.allowed),
        ),
      )
      .orderBy(desc(failureClusters.occurrences), desc(failureClusters.updatedAt))
      .limit(limit);
    const names = await projectNames(
      db,
      rows.map((r) => r.projectId),
    );
    return {
      ...empty,
      items: rows.map((r) => ({
        id: r.id,
        title: r.title || `Failure cause #${r.id}`,
        detail: [
          `${r.occurrences ?? 0} occurrences`,
          r.errorType ?? null,
          r.assignee ? `assigned to ${r.assignee}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        projectName: names.get(r.projectId) ?? '',
        at: iso(r.updatedAt),
        href: `/failure-clusters/${r.id}`,
        facts: {
          source: 'failure-clusters' as const,
          id: r.id,
          title: r.title || null,
          occurrences: r.occurrences ?? 0,
          errorType: r.errorType ?? null,
          assignee: r.assignee ?? null,
        },
      })),
    };
  }

  if (source === 'flaky-tests') {
    const rows = (await getAnalyticsFlakyLeaderboard(db, scope, access)).slice(0, limit);
    return {
      ...empty,
      items: rows.map((r) => ({
        id: r.testCaseId,
        title: r.title,
        detail: `flaky score ${Math.round(r.score)} · ${r.alternations} status flips in ${r.totalRuns} runs`,
        projectName: r.projectLabel || r.projectName,
        at: iso(r.lastFlakeAt),
        href: `/test-cases/${r.testCaseId}`,
        facts: {
          source: 'flaky-tests' as const,
          score: Math.round(r.score),
          alternations: r.alternations,
          totalRuns: r.totalRuns,
        },
      })),
    };
  }

  const { included, declined } = await testMapProjects(db, scope, access);
  if (included.length === 0) return { ...empty, declined };
  const names = new Map(included.map((p) => [p.id, p.name]));
  const gaps = await db
    .select({
      id: scenarioGaps.id,
      projectId: scenarioGaps.projectId,
      title: scenarioGaps.title,
      detector: scenarioGaps.detector,
      cls: scenarioGaps.class,
      score: scenarioGaps.score,
      createdAt: scenarioGaps.createdAt,
    })
    .from(scenarioGaps)
    .where(
      and(
        inArray(
          scenarioGaps.projectId,
          included.map((p) => p.id),
        ),
        eq(scenarioGaps.status, 'open'),
        eq(scenarioGaps.kind, 'gap'),
      ),
    )
    .orderBy(desc(scenarioGaps.score))
    .limit(limit);
  return {
    source,
    declined,
    items: gaps.map((g) => ({
      id: g.id,
      title: g.title,
      detail: g.cls,
      projectName: names.get(g.projectId) ?? '',
      at: iso(g.createdAt),
      href: `/projects/${g.projectId}?tab=gaps`,
      facts: { source: 'scenario-gaps' as const, detector: g.detector, gapClass: g.cls },
    })),
  };
}
