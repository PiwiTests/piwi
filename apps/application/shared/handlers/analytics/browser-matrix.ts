import { and, eq, inArray, sql } from 'drizzle-orm';
import { testRuns, testRunsCases } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsBrowserMatrix } from '../../analytics/types';
import { passRatePercent } from '../../utils/pass-rate';
import { failedCountSql, passedCountSql } from '../../utils/pass-rate-sql';
import { finalAttemptSql } from '../test-case-aggregates';
import { contextRunConditions, fetchContextProjects, getAnalyticsContext, type ProjectAccess } from './common';

/**
 * Pass rate per browser × project — surfaces browser-specific rot (a suite
 * that's green on Chromium but red on WebKit). Uses the scalar `browserName`
 * column on `test_runs_cases`, and counts one result per run, test, project and
 * repetition (its final attempt), so a pass on a retry is a pass.
 */
export async function getAnalyticsBrowserMatrix(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsBrowserMatrix> {
  const ctx = await getAnalyticsContext(db, scope, access);
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return { browsers: [], rows: [] };

  const conditions = contextRunConditions(ctx, ctx.period.from.getTime(), ctx.period.to.getTime());
  conditions.push(finalAttemptSql());
  const filter = ctx.testFilter;
  if (filter?.browsers) conditions.push(inArray(testRunsCases.browserName, filter.browsers));

  // Under a test filter the grouping also keeps the test, so rows outside the
  // resolved set can be dropped before the grid is summed.
  const grouped: any[] = await db
    .select({
      projectId: testRuns.projectId,
      browserName: testRunsCases.browserName,
      testCaseId: filter?.testCaseIds ? testRunsCases.testCaseId : sql<number>`0`,
      passed: passedCountSql(testRunsCases.status),
      failed: failedCountSql(testRunsCases.status),
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(...conditions))
    .groupBy(testRuns.projectId, testRunsCases.browserName, ...(filter?.testCaseIds ? [testRunsCases.testCaseId] : []));
  const rows = filter?.testCaseIds
    ? grouped.filter((row) => filter.testCaseIds!.get(row.projectId)?.has(Number(row.testCaseId)))
    : grouped;

  // Aggregate into a project × browser grid.
  const browserSet = new Set<string>();
  const byProject = new Map<number, Map<string, { passed: number; failed: number }>>();
  for (const row of rows) {
    const browser = (row.browserName as string | null) || 'unknown';
    browserSet.add(browser);
    let byBrowser = byProject.get(row.projectId);
    if (!byBrowser) {
      byBrowser = new Map();
      byProject.set(row.projectId, byBrowser);
    }
    const cell = byBrowser.get(browser) ?? { passed: 0, failed: 0 };
    cell.passed += Number(row.passed) || 0;
    cell.failed += Number(row.failed) || 0;
    byBrowser.set(browser, cell);
  }

  const browsers = [...browserSet].sort();
  if (browsers.length === 0) return { browsers: [], rows: [] };

  const scopedProjects = await fetchContextProjects(db, ctx);

  const matrixRows = scopedProjects
    .filter((project) => byProject.has(project.id))
    .map((project) => {
      const byBrowser = byProject.get(project.id)!;
      return {
        projectId: project.id,
        name: project.name,
        label: project.label,
        cells: browsers.map((browser) => {
          const cell = byBrowser.get(browser);
          return cell ? passRatePercent(cell, 1) : null;
        }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { browsers, rows: matrixRows };
}
