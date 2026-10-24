import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsTimeoutHygiene, AnalyticsTimeoutRow } from '../../analytics/types';
import { getProjectTimeoutOpportunities } from '../projects';
import { fetchContextProjects, getAnalyticsContext, type ProjectAccess } from './common';

const RUNS_PER_PROJECT = 50;
const TOP_ROWS = 20;
const MAX_PROJECTS = 50;

/**
 * Timeout-reduction opportunities across every project the caller can see —
 * reuses the per-project detection so the cross-project feed matches the
 * project pages exactly. Uses default thresholds (the per-project endpoint
 * applies operator-tuned thresholds where the exact recommended value matters).
 */
export async function getAnalyticsTimeoutHygiene(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsTimeoutHygiene> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const scopedProjects = (await fetchContextProjects(db, ctx)).slice(0, MAX_PROJECTS);
  const inFilter = (projectId: number, testCaseId: number) =>
    !ctx.testFilter?.testCaseIds || !!ctx.testFilter.testCaseIds.get(projectId)?.has(testCaseId);

  const perProject = await Promise.all(
    scopedProjects.map(async (project) => {
      const opps = await getProjectTimeoutOpportunities(db, project.id, RUNS_PER_PROJECT);
      return opps
        .filter((o) => inFilter(project.id, o.testCaseId))
        .map((o): AnalyticsTimeoutRow => ({
          projectId: project.id,
          projectName: project.name,
          projectLabel: project.label,
          testCaseId: o.testCaseId,
          title: o.title,
          filePath: o.filePath,
          kind: o.kind,
          timeout: o.timeout,
          p95: o.p95,
          recommendedTimeout: o.recommendedTimeout,
          estimatedSavingMs: o.estimatedSavingMs,
          impact: o.impact,
          hasSlowAnnotation: o.hasSlowAnnotation,
        }));
    }),
  );

  const rows = perProject.flat().sort((a, b) => b.impact - a.impact);
  return {
    rows: rows.slice(0, TOP_ROWS),
    oversizedCount: rows.filter((r) => r.kind === 'oversized-timeout').length,
    staleSlowCount: rows.filter((r) => r.kind === 'stale-slow').length,
    totalEstimatedSavingMs: rows.reduce((sum, r) => sum + r.estimatedSavingMs, 0),
    topProjectId: rows[0]?.projectId ?? null,
  };
}
