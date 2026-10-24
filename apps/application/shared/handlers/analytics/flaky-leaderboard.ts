import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsFlakyRow } from '../../analytics/types';
import { getProjectFlakyTests } from '../projects';
import { contextRunConditions, fetchContextProjects, getAnalyticsContext, type ProjectAccess } from './common';

const RUNS_PER_PROJECT = 50;
const TOP_TESTS = 20;
const MAX_PROJECTS = 50;

/**
 * The worst flaky tests across every project the caller can see, impact-sorted
 * — reuses the per-project flakiness scoring so the numbers match the project
 * pages exactly. Each project's ranking reads the scope's runs (its period,
 * environments, branches and full-run filter) and only the tests and browsers
 * of its test filter, before its top tests are cut.
 */
export async function getAnalyticsFlakyLeaderboard(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsFlakyRow[]> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const scopedProjects = (await fetchContextProjects(db, ctx)).slice(0, MAX_PROJECTS);
  const runConditions = contextRunConditions(ctx, ctx.period.from.getTime(), ctx.period.to.getTime());
  const testCaseIds = ctx.testFilter?.testCaseIds;

  const perProject = await Promise.all(
    scopedProjects.map(async (project) => {
      const flaky = await getProjectFlakyTests(db, project.id, RUNS_PER_PROJECT, undefined, {
        runConditions,
        browsers: ctx.testFilter?.browsers ?? undefined,
        // A test filter that matches nothing in a project leaves none of its tests.
        testCaseIds: testCaseIds ? (testCaseIds.get(project.id) ?? new Set()) : undefined,
      });
      return flaky.map((test): AnalyticsFlakyRow => ({
        projectId: project.id,
        projectName: project.name,
        projectLabel: project.label,
        testCaseId: test.testCaseId,
        latestRunsCaseId: test.latestRunsCaseId,
        title: test.title,
        filePath: test.filePath,
        totalRuns: test.totalRuns,
        retryPassRuns: test.retryPassRuns,
        alternations: test.alternations,
        score: test.score,
        rootCause: test.rootCause,
        impact: test.impact,
        wastedCiMinutes: test.wastedCiMinutes,
        lastFlakeAt: test.lastFlakeAt,
      }));
    }),
  );

  return perProject
    .flat()
    .sort((a, b) => b.impact - a.impact || b.score - a.score)
    .slice(0, TOP_TESTS);
}
