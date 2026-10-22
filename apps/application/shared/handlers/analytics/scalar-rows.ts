/**
 * The one read path of every scalar series: per project and UTC day totals.
 *
 * With run filters only, the totals are always read from the daily rollups,
 * for every window. With a test filter they are always counted from the
 * matching executions, final attempt per test and browser, so a pass rate
 * "for @critical" is critical tests passed over critical tests run. One code
 * path per number and per filter kind, never "rollups for long windows".
 */

import type { DrizzleDB } from '../db';
import {
  dayKey,
  dayRange,
  distinctRunCountsFromAttempts,
  fetchContextRuns,
  fetchFilteredExecutions,
  type AnalyticsContext,
  type FilteredExecution,
} from './common';
import { emptyRollupTotals, readRollupSeries, type RollupDayRow } from './rollups';

const FAILED_EXECUTION_STATUSES = new Set(['failed', 'timedout', 'timedOut']);

/** Per project and day totals of the context over `[fromMs, toMs)`. */
export async function loadScalarRows(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  fromMs: number,
  toMs: number,
): Promise<RollupDayRow[]> {
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return [];
  if (!ctx.testFilter) {
    const { fromDay, toDay } = dayRange(fromMs, toMs);
    return readRollupSeries(db, {
      projectIds: ctx.allowed,
      fromDay,
      toDay,
      environments: ctx.scope.environments,
      branchPolicy: ctx.branchPolicy,
      fullRunsOnly: ctx.scope.fullRunsOnly,
    });
  }
  return countFromExecutions(db, ctx, fromMs, toMs);
}

async function countFromExecutions(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  fromMs: number,
  toMs: number,
): Promise<RollupDayRow[]> {
  // Whole UTC days, as the rollups read, so both paths bucket identically.
  const { fromDay, toDay } = dayRange(fromMs, toMs);
  const dayStart = Date.parse(`${fromDay}T00:00:00Z`);
  const dayEnd = Date.parse(`${toDay}T00:00:00Z`) + 24 * 60 * 60 * 1000;
  const runs = await fetchContextRuns(db, ctx, dayStart, dayEnd);
  return rowsFromExecutions(runs, await fetchFilteredExecutions(db, ctx, runs));
}

/**
 * Per project and day totals of executions, final attempt per test, browser and
 * repetition: a run counts once, and passed when none of its executions failed.
 */
export function rowsFromExecutions(
  runs: Array<{ id: number; projectId: number; startTime: Date | string | number }>,
  executions: FilteredExecution[],
): RollupDayRow[] {
  const byRun = new Map<number, FilteredExecution[]>();
  for (const execution of executions) {
    const list = byRun.get(execution.testRunId) ?? [];
    list.push(execution);
    byRun.set(execution.testRunId, list);
  }

  const rows = new Map<string, RollupDayRow>();
  for (const run of runs) {
    const matching = byRun.get(run.id);
    if (!matching || matching.length === 0) continue;
    const day = dayKey(run.startTime);
    const id = `${run.projectId}:${day}`;
    let row = rows.get(id);
    if (!row) {
      row = { projectId: run.projectId, day, ...emptyRollupTotals() };
      rows.set(id, row);
    }
    const counts = distinctRunCountsFromAttempts(matching);
    // For the filtered tests, a run passed when none of them failed.
    row.runs += 1;
    if (counts.failedTests > 0) row.failedRuns += 1;
    else row.passedRuns += 1;
    row.totalTests += counts.totalTests;
    row.passedTests += counts.passedTests;
    row.failedTests += counts.failedTests;
    row.skippedTests += counts.skippedTests;
    row.didNotRunTests += counts.didNotRunTests;
    row.flakyTests += counts.flakyTests;
    row.maxTotalTests = Math.max(row.maxTotalTests, counts.totalTests);
    let runDurationMs = 0;
    for (const execution of matching) {
      const duration = execution.duration ?? 0;
      runDurationMs += duration;
      row.waitMs += execution.wastedTimeMs ?? 0;
      if (FAILED_EXECUTION_STATUSES.has(execution.status)) row.failedExecMs += duration;
      if (execution.isNewRegression === 1) row.newRegressions += 1;
      if (execution.isNewFlaky === 1) row.newFlaky += 1;
    }
    row.durationMs += runDurationMs;
    if (runDurationMs > 0) row.durationRuns += 1;
  }
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Sum rows into one totals object per key. */
export function groupRows<K>(rows: RollupDayRow[], keyOf: (row: RollupDayRow) => K | null) {
  const groups = new Map<K, ReturnType<typeof emptyRollupTotals>>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    let totals = groups.get(key);
    if (!totals) {
      totals = emptyRollupTotals();
      groups.set(key, totals);
    }
    for (const field of Object.keys(totals) as (keyof typeof totals)[]) {
      if (field === 'maxTotalTests') totals[field] = Math.max(totals[field], row[field]);
      else totals[field] += row[field];
    }
  }
  return groups;
}
