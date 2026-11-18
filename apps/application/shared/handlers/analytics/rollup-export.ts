/**
 * The daily rollup rows of a scope, for a BI tool (Power BI, Metabase, a
 * spreadsheet): one row per cell (project, UTC day, environment, branch, run
 * kind), the retained and archived parts summed, over the scope's period and
 * run filters and the caller's project access. Read in chunks of days, so the
 * server can stream a long window without holding it in memory. Shared by
 * the server route and the demo.
 */
import { inArray } from 'drizzle-orm';
import { projects } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import { renderRowsCsv } from '../../reports/render-csv';
import { dayKey, getAnalyticsContext, type ProjectAccess } from './common';
import { readRollupCells, type RollupCellRow } from './rollups';

export const ROLLUP_EXPORT_FORMATS = ['json', 'csv'] as const;
export type RollupExportFormat = (typeof ROLLUP_EXPORT_FORMATS)[number];

/** The columns of an exported row, in order: the cell, then its numbers. */
export const ROLLUP_EXPORT_COLUMNS = [
  'projectId',
  'project',
  'day',
  'environment',
  'branch',
  'fullRun',
  'runs',
  'passedRuns',
  'failedRuns',
  'totalTests',
  'passedTests',
  'failedTests',
  'skippedTests',
  'didNotRunTests',
  'flakyTests',
  'maxTotalTests',
  'durationMs',
  'durationRuns',
  'avgTestDurationSumMs',
  'p90TestDurationSumMs',
  'testDurationRuns',
  'waitMs',
  'failedExecMs',
  'newRegressions',
  'newFlaky',
] as const;

export type RollupExportRow = RollupCellRow & { project: string };

/** Days read per query. */
const CHUNK_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The rollup rows of a scope, oldest day first, one chunk of days at a time. */
export async function* rollupExportChunks(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess,
  now?: number,
): AsyncGenerator<RollupExportRow[]> {
  const ctx = await getAnalyticsContext(db, scope, access, now);
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return;
  const nameRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(ctx.allowed === 'all' ? undefined : inArray(projects.id, ctx.allowed));
  const names = new Map(nameRows.map((r) => [r.id, r.name]));
  const from = ctx.period.from.getTime();
  const to = Math.max(from, ctx.period.to.getTime() - 1);
  for (let start = from; start <= to; start += CHUNK_DAYS * DAY_MS) {
    const end = Math.min(to, start + (CHUNK_DAYS - 1) * DAY_MS);
    const rows = await readRollupCells(db, {
      projectIds: ctx.allowed,
      fromDay: dayKey(start),
      toDay: dayKey(end),
      environmentPolicy: ctx.environmentPolicy,
      branchPolicy: ctx.branchPolicy,
      fullRunsOnly: ctx.scope.fullRunsOnly,
    });
    if (rows.length > 0) yield rows.map((row) => ({ ...row, project: names.get(row.projectId) ?? '' }));
  }
}

/** The CSV header line. */
export function rollupCsvHeader(): string {
  return renderRowsCsv([[...ROLLUP_EXPORT_COLUMNS]]);
}

/** Rows as CSV lines, formula-guarded like every CSV Piwi writes (a branch name is run-derived). */
export function rollupCsvRows(rows: RollupExportRow[]): string {
  if (rows.length === 0) return '';
  return renderRowsCsv(
    rows.map((row) =>
      ROLLUP_EXPORT_COLUMNS.map((column) => {
        const value = row[column];
        return typeof value === 'boolean' ? (value ? 1 : 0) : value;
      }),
    ),
  );
}

/** Every row of a scope at once, for the demo and small windows. */
export async function collectRollupExport(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess,
): Promise<RollupExportRow[]> {
  const out: RollupExportRow[] = [];
  for await (const chunk of rollupExportChunks(db, scope, access)) out.push(...chunk);
  return out;
}
