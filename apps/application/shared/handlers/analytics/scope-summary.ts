import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  environments,
  markers,
  projects,
  testRuns,
  testRunsCases,
  testSelections,
} from '../../../server/database/schema';
import { markerEnvironmentScopeSql } from '../environment-scope';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsMarker, AnalyticsScopeSummary } from '../../analytics/types';
import { BUILTIN_SELECTIONS } from '../../selection/builtins';
import { contextRunConditions, dayRange, getAnalyticsContext, type ProjectAccess } from './common';
import { firstRollupDay } from './rollups';

/** Categories drawn on a cross-project trend; with one project in scope every marker is drawn. */
const CROSS_PROJECT_MARKER_CATEGORIES = ['release', 'infra', 'incident'];

const ANCHOR_LIMIT = 100;
const BROWSER_LOOKBACK_RUNS = 200;

/**
 * How a scope resolved, for the scope bar and the trend charts: the period and
 * comparison as dates, notes, the markers to draw inside the period, the
 * markers a period can anchor on, the selection keys and browsers the *Tests*
 * filter offers, and where the stored data starts.
 */
export async function getAnalyticsScopeSummary(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsScopeSummary> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const allowed = ctx.allowed;
  const none = allowed !== 'all' && allowed.length === 0;
  const projectFilter = (column: any) => (allowed === 'all' ? undefined : inArray(column, allowed));

  const projectRows: { id: number; name: string; label: string | null }[] = none
    ? []
    : await db
        .select({ id: projects.id, name: projects.name, label: projects.label })
        .from(projects)
        .where(projectFilter(projects.id));
  const projectName = new Map(projectRows.map((p) => [p.id, p.label || p.name]));
  const singleProject = projectRows.length === 1;

  const markerFields = {
    id: markers.id,
    projectId: markers.projectId,
    occurredAt: markers.occurredAt,
    label: markers.label,
    description: markers.description,
    category: markers.category,
    environment: markers.environment,
    environmentId: markers.environmentId,
    environmentName: environments.name,
    commit: markers.commit,
    source: markers.source,
    runId: markers.runId,
    createdAt: markers.createdAt,
    updatedAt: markers.updatedAt,
  };

  const inPeriodConditions = [
    gte(markers.occurredAt, ctx.period.from),
    lt(markers.occurredAt, ctx.period.to),
    projectFilter(markers.projectId),
  ];
  if (!singleProject) inPeriodConditions.push(inArray(markers.category, CROSS_PROJECT_MARKER_CATEGORIES));
  // A marker counts under the filter's environments through its environment's key or its label; one of every
  // environment always counts.
  if (scope.environments && scope.environments.length > 0) {
    inPeriodConditions.push(markerEnvironmentScopeSql(scope.environments) ?? undefined);
  }

  const [periodMarkers, anchors, selectionRows, browserRows, firstDay] = await Promise.all([
    none
      ? []
      : db
          .select(markerFields)
          .from(markers)
          .leftJoin(environments, eq(environments.id, markers.environmentId))
          .where(and(...inPeriodConditions))
          .orderBy(markers.occurredAt),
    none
      ? []
      : db
          .select(markerFields)
          .from(markers)
          .leftJoin(environments, eq(environments.id, markers.environmentId))
          .where(projectFilter(markers.projectId))
          .orderBy(desc(markers.occurredAt))
          .limit(ANCHOR_LIMIT),
    none
      ? []
      : db
          .select({ key: testSelections.key, name: testSelections.name })
          .from(testSelections)
          .where(projectFilter(testSelections.projectId)),
    none ? [] : recentBrowsers(db, ctx),
    none
      ? null
      : firstRollupDay(db, {
          projectIds: allowed,
          ...dayRange(ctx.period.from.getTime(), ctx.period.to.getTime()),
          fullRunsOnly: false,
        }),
  ]);

  const label = (m: { projectId: number; label: string }) =>
    singleProject ? m.label : `${projectName.get(m.projectId) ?? `Project ${m.projectId}`}: ${m.label}`;
  const toMarker = (m: any): AnalyticsMarker => ({
    ...m,
    label: label(m),
    ownLabel: m.label,
    projectName: projectName.get(m.projectId) ?? null,
  });

  const selections = new Map<string, string>();
  for (const builtin of BUILTIN_SELECTIONS) selections.set(builtin.key, builtin.name);
  for (const row of selectionRows as { key: string; name: string }[])
    if (!selections.has(row.key)) selections.set(row.key, row.name);

  return {
    period: summarizePeriod(ctx.period),
    comparison: ctx.comparison ? summarizePeriod(ctx.comparison) : null,
    notes: ctx.notes,
    markers: (periodMarkers as any[]).map(toMarker),
    anchors: (anchors as any[]).map(toMarker),
    selections: [...selections].map(([key, name]) => ({ key, name })),
    browsers: browserRows,
    dataStartsAt: firstDay,
    projectCount: projectRows.length,
  };
}

function summarizePeriod(p: { from: Date; to: Date; label: string; fallback?: string }) {
  return { from: p.from.toISOString(), to: p.to.toISOString(), label: p.label, fallback: p.fallback ?? null };
}

/** Browsers (Playwright project names) the recent runs of the scope ran on. */
async function recentBrowsers(db: DrizzleDB, ctx: Awaited<ReturnType<typeof getAnalyticsContext>>) {
  const runs: { id: number }[] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(...contextRunConditions(ctx, 0, Date.now() + 1)))
    .orderBy(desc(testRuns.startTime))
    .limit(BROWSER_LOOKBACK_RUNS);
  if (runs.length === 0) return [];
  const rows: { browserName: string | null }[] = await db
    .selectDistinct({ browserName: testRunsCases.browserName })
    .from(testRunsCases)
    .where(
      and(
        inArray(
          testRunsCases.testRunId,
          runs.map((r) => r.id),
        ),
        sql`${testRunsCases.browserName} IS NOT NULL`,
      ),
    );
  return rows
    .map((r) => r.browserName!)
    .filter(Boolean)
    .sort();
}
