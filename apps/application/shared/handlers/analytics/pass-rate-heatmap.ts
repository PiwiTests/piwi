import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsHeatmap } from '../../analytics/types';
import { passRatePercent } from '../../utils/pass-rate';
import { fetchContextProjects, firstNonEmptyIndex, getAnalyticsContext, type ProjectAccess } from './common';
import { groupRows, loadScalarRows } from './scalar-rows';

/**
 * Projects × time-buckets grid of pass rates — shows at a glance who degraded
 * and when. A cell is one UTC day (or week, or month, per the granularity), the
 * same cells the daily rollups keep.
 */
export async function getAnalyticsPassRateHeatmap(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsHeatmap> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const [scopedProjects, dayRows] = await Promise.all([
    fetchContextProjects(db, ctx),
    loadScalarRows(db, ctx, ctx.period.from.getTime(), ctx.period.to.getTime()),
  ]);
  const buckets = ctx.buckets;
  const totals = groupRows(dayRows, (row) => {
    const key = buckets.keyFor(row.day);
    return key ? `${row.projectId}:${key}` : null;
  });

  const rows = scopedProjects
    .map((project) => ({
      projectId: project.id,
      name: project.name,
      label: project.label,
      cells: buckets.keys.map((key) => {
        const cell = totals.get(`${project.id}:${key}`);
        return cell ? passRatePercent({ passed: cell.passedTests, failed: cell.failedTests }, 1) : null;
      }),
    }))
    // Projects with no runs in the period would render an all-gray row — drop them.
    .filter((row) => row.cells.some((c) => c !== null))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Bounded periods render the whole window the user selected, so the axis
  // always spans the full period. Only the unbounded "All time" window trims its
  // leading all-empty columns — otherwise it would show years of blank buckets
  // before the first real data.
  const firstDataIndex = isAllTime(scope)
    ? firstNonEmptyIndex(
        buckets.keys.map((_, index) => index),
        (index) => rows.every((row) => row.cells[index] === null),
      )
    : 0;

  return {
    buckets: buckets.keys.slice(firstDataIndex),
    bucketDays: buckets.bucketDays,
    ...(scope.granularity === 'month' ? { monthly: true } : {}),
    rows: rows.map((row) => ({ ...row, cells: row.cells.slice(firstDataIndex) })),
  };
}

function isAllTime(scope: AnalyticsScope): boolean {
  return scope.period.kind === 'all' || (scope.period.kind === 'rolling' && scope.period.days >= 3650);
}
