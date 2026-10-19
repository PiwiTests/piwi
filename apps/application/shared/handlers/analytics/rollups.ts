/**
 * Daily rollups: one precomputed aggregate row per cell, where a cell is a
 * project, a UTC day, an environment, a branch and a run kind (full or partial).
 *
 * A cell has two parts. The **retained row** is recomputed from the runs still
 * stored, never incremented, so every write is idempotent. The **archived row**
 * holds the numbers of the runs age-based deletion removed; it is only ever
 * added to, inside the transaction that deletes those runs, so a retried sweep
 * finds nothing left to add. Reads sum both parts.
 *
 * Shared by the server and the demo (both call the ingest hook), so it lives in
 * `shared/`.
 */

import { and, eq, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { analyticsDailyRollups, projects, testRuns, testRunsCases } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import { notLabRun } from '../probes';
import { dayKey, DAY_MS, FAILING_RUN_STATUSES, TERMINAL_RUN_STATUSES } from './common';
import { branchPolicyCondition, type BranchPolicy } from './branch-policy';

/** The numbers a rollup row carries, summed over the runs of its cell. */
export interface RollupTotals {
  runs: number;
  passedRuns: number;
  failedRuns: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  didNotRunTests: number;
  flakyTests: number;
  /** Highest `totalTests` of one run: read with MAX, never summed. */
  maxTotalTests: number;
  durationMs: number;
  /** Runs with a duration: the divisor of `durationMs`, since a run without one (interrupted, imported) adds 0. */
  durationRuns: number;
  avgTestDurationSumMs: number;
  p90TestDurationSumMs: number;
  /** Runs with measured test durations: the divisor of the two test duration sums. */
  testDurationRuns: number;
  waitMs: number;
  failedExecMs: number;
  newRegressions: number;
  newFlaky: number;
}

const SUMMED_FIELDS = [
  'runs',
  'passedRuns',
  'failedRuns',
  'totalTests',
  'passedTests',
  'failedTests',
  'skippedTests',
  'didNotRunTests',
  'flakyTests',
  'durationMs',
  'durationRuns',
  'avgTestDurationSumMs',
  'p90TestDurationSumMs',
  'testDurationRuns',
  'waitMs',
  'failedExecMs',
  'newRegressions',
  'newFlaky',
] as const satisfies readonly (keyof RollupTotals)[];

export function emptyRollupTotals(): RollupTotals {
  return {
    runs: 0,
    passedRuns: 0,
    failedRuns: 0,
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    skippedTests: 0,
    didNotRunTests: 0,
    flakyTests: 0,
    maxTotalTests: 0,
    durationMs: 0,
    durationRuns: 0,
    avgTestDurationSumMs: 0,
    p90TestDurationSumMs: 0,
    testDurationRuns: 0,
    waitMs: 0,
    failedExecMs: 0,
    newRegressions: 0,
    newFlaky: 0,
  };
}

/** The dimensions that identify a cell. */
export interface RollupCellKey {
  projectId: number;
  day: string;
  environment: string;
  branch: string;
  fullRun: 0 | 1;
}

function cellId(key: RollupCellKey): string {
  return JSON.stringify([key.projectId, key.day, key.environment, key.branch, key.fullRun]);
}

const ID_BATCH = 500;

function* batches<T>(items: T[], size = ID_BATCH): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function nextDay(day: string): string {
  return dayKey(dayStart(day).getTime() + DAY_MS);
}

// ── Aggregation, shared by recompute and archive ────────────────────────────

interface RawRun {
  id: number;
  projectId: number;
  status: string;
  startTime: Date;
  environment: string | null;
  branch: string | null;
  isFullRun: number | null;
  duration: number | null;
  totalTests: number | null;
  passedTests: number | null;
  failedTests: number | null;
  skippedTests: number | null;
  didNotRunTests: number | null;
  flakyTests: number | null;
  avgTestDuration: number | null;
  p90TestDuration: number | null;
}

const RAW_RUN_FIELDS = {
  id: testRuns.id,
  projectId: testRuns.projectId,
  status: testRuns.status,
  startTime: testRuns.startTime,
  environment: testRuns.environment,
  branch: testRuns.branch,
  isFullRun: testRuns.isFullRun,
  duration: testRuns.duration,
  totalTests: testRuns.totalTests,
  passedTests: testRuns.passedTests,
  failedTests: testRuns.failedTests,
  skippedTests: testRuns.skippedTests,
  didNotRunTests: testRuns.didNotRunTests,
  flakyTests: testRuns.flakyTests,
  avgTestDuration: testRuns.avgTestDuration,
  p90TestDuration: testRuns.p90TestDuration,
};

/** The runs a rollup counts: finished, never a lab run (probe or flake experiment). */
function countedRunConditions(): SQL[] {
  return [inArray(testRuns.status, TERMINAL_RUN_STATUSES), notLabRun(testRuns.origin)];
}

interface ExecutionStats {
  waitMs: number;
  failedExecMs: number;
  newRegressions: number;
  newFlaky: number;
}

/** Per-run sums over the executions: wait time, failed-attempt time, regression signals. */
async function executionStatsByRun(db: DrizzleDB, runIds: number[]): Promise<Map<number, ExecutionStats>> {
  const byRun = new Map<number, ExecutionStats>();
  for (const batch of batches(runIds)) {
    const rows: any[] = await db
      .select({
        runId: testRunsCases.testRunId,
        waitMs: sql<number>`COALESCE(SUM(COALESCE(${testRunsCases.wastedTimeMs}, 0)), 0)`,
        failedExecMs: sql<number>`COALESCE(SUM(CASE WHEN ${testRunsCases.status} IN ('failed', 'timedout', 'timedOut') THEN COALESCE(${testRunsCases.duration}, 0) ELSE 0 END), 0)`,
        newRegressions: sql<number>`COALESCE(SUM(CASE WHEN ${testRunsCases.isNewRegression} = 1 THEN 1 ELSE 0 END), 0)`,
        newFlaky: sql<number>`COALESCE(SUM(CASE WHEN ${testRunsCases.isNewFlaky} = 1 THEN 1 ELSE 0 END), 0)`,
      })
      .from(testRunsCases)
      .where(inArray(testRunsCases.testRunId, batch))
      .groupBy(testRunsCases.testRunId);
    for (const row of rows) {
      byRun.set(Number(row.runId), {
        waitMs: Number(row.waitMs) || 0,
        failedExecMs: Number(row.failedExecMs) || 0,
        newRegressions: Number(row.newRegressions) || 0,
        newFlaky: Number(row.newFlaky) || 0,
      });
    }
  }
  return byRun;
}

function cellKeyOfRun(run: Pick<RawRun, 'projectId' | 'startTime' | 'environment' | 'branch' | 'isFullRun'>) {
  return {
    projectId: run.projectId,
    day: dayKey(run.startTime),
    environment: run.environment ?? '',
    branch: run.branch ?? '',
    fullRun: run.isFullRun === 1 ? 1 : 0,
  } satisfies RollupCellKey;
}

/** Aggregate raw runs into one totals object per cell. */
async function aggregateRuns(db: DrizzleDB, runs: RawRun[]) {
  const stats = await executionStatsByRun(
    db,
    runs.map((r) => r.id),
  );
  const cells = new Map<string, { key: RollupCellKey; totals: RollupTotals }>();
  for (const run of runs) {
    const key = cellKeyOfRun(run);
    const id = cellId(key);
    let cell = cells.get(id);
    if (!cell) {
      cell = { key, totals: emptyRollupTotals() };
      cells.set(id, cell);
    }
    const t = cell.totals;
    const s = stats.get(run.id);
    t.runs += 1;
    if (run.status === 'passed') t.passedRuns += 1;
    if (FAILING_RUN_STATUSES.includes(run.status)) t.failedRuns += 1;
    t.totalTests += run.totalTests ?? 0;
    t.passedTests += run.passedTests ?? 0;
    t.failedTests += run.failedTests ?? 0;
    t.skippedTests += run.skippedTests ?? 0;
    t.didNotRunTests += run.didNotRunTests ?? 0;
    t.flakyTests += run.flakyTests ?? 0;
    t.maxTotalTests = Math.max(t.maxTotalTests, run.totalTests ?? 0);
    // An average divides by the runs that have the value, so a run without one does not pull it down.
    if (run.duration != null && run.duration > 0) {
      t.durationMs += run.duration;
      t.durationRuns += 1;
    }
    if (run.p90TestDuration != null && run.p90TestDuration > 0) {
      t.avgTestDurationSumMs += run.avgTestDuration ?? 0;
      t.p90TestDurationSumMs += run.p90TestDuration;
      t.testDurationRuns += 1;
    }
    t.waitMs += s?.waitMs ?? 0;
    t.failedExecMs += s?.failedExecMs ?? 0;
    t.newRegressions += s?.newRegressions ?? 0;
    t.newFlaky += s?.newFlaky ?? 0;
  }
  return cells;
}

// ── Retained rows: recomputed from the stored runs ──────────────────────────

/**
 * Recompute the retained rows of one project over `[fromDay, toDay)` from the
 * runs still stored: upsert every cell that has runs, delete every retained row
 * of the range whose runs are gone. Never touches an archived row.
 *
 * Two recomputes of the same day can overlap (two runs finishing together).
 * Only a row listed before this one reads the runs, and still as listed, is
 * taken for stale: a cell another recompute writes meanwhile, for a run that
 * turned terminal after the read below, is never deleted.
 */
async function recomputeRetainedRange(
  db: DrizzleDB,
  projectId: number,
  fromDay: string,
  toDay: string,
): Promise<number> {
  const listed: Array<{ id: number; key: RollupCellKey; computedAt: Date }> = (
    await db
      .select({
        id: analyticsDailyRollups.id,
        projectId: analyticsDailyRollups.projectId,
        day: analyticsDailyRollups.day,
        environment: analyticsDailyRollups.environment,
        branch: analyticsDailyRollups.branch,
        fullRun: analyticsDailyRollups.fullRun,
        computedAt: analyticsDailyRollups.computedAt,
      })
      .from(analyticsDailyRollups)
      .where(
        and(
          eq(analyticsDailyRollups.projectId, projectId),
          eq(analyticsDailyRollups.part, 'retained'),
          gte(analyticsDailyRollups.day, fromDay),
          lt(analyticsDailyRollups.day, toDay),
        ),
      )
  ).map((row: any) => ({
    id: row.id,
    key: { ...row, fullRun: row.fullRun === 1 ? 1 : 0 },
    computedAt: row.computedAt,
  }));

  const runs: RawRun[] = await db
    .select(RAW_RUN_FIELDS)
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, projectId),
        gte(testRuns.startTime, dayStart(fromDay)),
        lt(testRuns.startTime, dayStart(toDay)),
        ...countedRunConditions(),
      ),
    );
  const cells = await aggregateRuns(db, runs);
  const now = new Date();
  for (const { key, totals } of cells.values()) {
    await db
      .insert(analyticsDailyRollups)
      .values({ ...key, part: 'retained', ...totals, computedAt: now })
      .onConflictDoUpdate({
        target: [
          analyticsDailyRollups.projectId,
          analyticsDailyRollups.day,
          analyticsDailyRollups.environment,
          analyticsDailyRollups.branch,
          analyticsDailyRollups.fullRun,
          analyticsDailyRollups.part,
        ],
        set: { ...totals, computedAt: now },
      });
  }

  // A listed row this read has no runs for is stale, unless another recompute rewrote it since the list.
  const stale = listed.filter((row) => !cells.has(cellId(row.key)));
  // Two parameters per row.
  for (const batch of batches(stale, ID_BATCH / 2)) {
    await db
      .delete(analyticsDailyRollups)
      .where(
        or(
          ...batch.map((row) =>
            and(eq(analyticsDailyRollups.id, row.id), eq(analyticsDailyRollups.computedAt, row.computedAt)),
          ),
        ),
      );
  }
  return cells.size;
}

/**
 * Recompute the retained rows of the cells given, a whole project-day at a
 * time (the cheapest exact unit). Idempotent by construction.
 */
export async function recomputeRollupCells(
  db: DrizzleDB,
  cells: Array<Pick<RollupCellKey, 'projectId' | 'day'>>,
): Promise<void> {
  const seen = new Set<string>();
  for (const cell of cells) {
    const id = `${cell.projectId}:${cell.day}`;
    if (seen.has(id)) continue;
    seen.add(id);
    await recomputeRetainedRange(db, cell.projectId, cell.day, nextDay(cell.day));
  }
}

/**
 * The ingest hook: recompute the retained row of the cell a run belongs to.
 * A no-op for a run that does not exist; a lab or unfinished run leaves its
 * cell exactly as the other runs make it.
 */
export async function upsertDailyRollup(db: DrizzleDB, runId: number): Promise<void> {
  const [run] = await db
    .select({ projectId: testRuns.projectId, startTime: testRuns.startTime })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run) return;
  await recomputeRollupCells(db, [{ projectId: run.projectId, day: dayKey(run.startTime) }]);
}

/**
 * Recompute the retained rows of every project over the last `days` UTC days,
 * today included. The nightly reconcile: it catches a write path that missed
 * the hook, and never touches an archived row.
 */
export async function reconcileRecentRollups(db: DrizzleDB, days: number, now = Date.now()): Promise<number> {
  if (days <= 0) return 0;
  const toDay = nextDay(dayKey(now));
  const fromDay = dayKey(now - (days - 1) * DAY_MS);
  const projectRows: { id: number }[] = await db.select({ id: projects.id }).from(projects);
  let cells = 0;
  for (const project of projectRows) cells += await recomputeRetainedRange(db, project.id, fromDay, toDay);
  return cells;
}

/** App setting that records a completed backfill, so it runs once per instance. */
export const ROLLUPS_BACKFILLED_SETTING = 'analytics_rollups_backfilled_at';

const BACKFILL_WINDOW_DAYS = 31;

/**
 * Compute the retained rows of every project-day that holds runs, in windows
 * of a month per project. Recomputing is idempotent, so an interrupted
 * backfill simply starts over. Returns the number of cells written.
 */
export async function backfillDailyRollups(db: DrizzleDB): Promise<number> {
  const spans: any[] = await db
    .select({
      projectId: testRuns.projectId,
      first: sql`MIN(${testRuns.startTime})`,
      last: sql`MAX(${testRuns.startTime})`,
    })
    .from(testRuns)
    .groupBy(testRuns.projectId);
  let cells = 0;
  for (const span of spans) {
    if (span.first == null || span.last == null) continue;
    let from = dayKey(toDate(span.first));
    const end = nextDay(dayKey(toDate(span.last)));
    while (from < end) {
      const to = minDay(dayKey(dayStart(from).getTime() + BACKFILL_WINDOW_DAYS * DAY_MS), end);
      cells += await recomputeRetainedRange(db, Number(span.projectId), from, to);
      from = to;
    }
  }
  return cells;
}

/** A raw MIN/MAX over a timestamp column: seconds on SQLite, a date or string on PostgreSQL. */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value < 1e11 ? value * 1000 : value);
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return new Date(numeric < 1e11 ? numeric * 1000 : numeric);
  return new Date(String(value));
}

function minDay(a: string, b: string): string {
  return a < b ? a : b;
}

// ── Archived rows: the numbers of deleted runs ──────────────────────────────

/**
 * Add the numbers of the runs about to be deleted to their cells' archived
 * rows. MUST run in the transaction that deletes those runs: the archived row
 * is only ever added to, so the add and the delete stand or fall together.
 * Returns the project-days touched, for the retained recompute that follows.
 */
export async function archiveRunsIntoRollups(
  db: DrizzleDB,
  runIds: number[],
): Promise<Array<Pick<RollupCellKey, 'projectId' | 'day'>>> {
  const runs: RawRun[] = [];
  for (const batch of batches(runIds)) {
    runs.push(
      ...(await db
        .select(RAW_RUN_FIELDS)
        .from(testRuns)
        .where(and(inArray(testRuns.id, batch), ...countedRunConditions()))),
    );
  }
  const cells = await aggregateRuns(db, runs);
  const t = analyticsDailyRollups;
  const now = new Date();
  for (const { key, totals } of cells.values()) {
    const set: Record<string, unknown> = { computedAt: now };
    for (const field of SUMMED_FIELDS) set[field] = sql`${t[field]} + ${totals[field]}`;
    set.maxTotalTests = sql`CASE WHEN ${t.maxTotalTests} > ${totals.maxTotalTests} THEN ${t.maxTotalTests} ELSE ${totals.maxTotalTests} END`;
    await db
      .insert(t)
      .values({ ...key, part: 'archived', ...totals, computedAt: now })
      .onConflictDoUpdate({
        target: [t.projectId, t.day, t.environment, t.branch, t.fullRun, t.part],
        set,
      });
  }
  return [...cells.values()].map(({ key }) => ({ projectId: key.projectId, day: key.day }));
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Which rows a read covers. Every list is optional; an empty filter reads everything. */
export interface RollupFilter {
  projectIds: 'all' | number[];
  /** Inclusive UTC day range. */
  fromDay: string;
  toDay: string;
  environments?: string[];
  branchPolicy?: BranchPolicy;
  fullRunsOnly: boolean;
}

export interface RollupDayRow extends RollupTotals {
  projectId: number;
  day: string;
}

function rollupConditions(filter: RollupFilter): SQL[] | null {
  const t = analyticsDailyRollups;
  if (filter.projectIds !== 'all' && filter.projectIds.length === 0) return null;
  const conditions: SQL[] = [gte(t.day, filter.fromDay), lte(t.day, filter.toDay)];
  if (filter.projectIds !== 'all') conditions.push(inArray(t.projectId, filter.projectIds));
  if (filter.fullRunsOnly) conditions.push(eq(t.fullRun, 1));
  if (filter.environments && filter.environments.length > 0)
    conditions.push(inArray(t.environment, filter.environments));
  const branch = filter.branchPolicy
    ? branchPolicyCondition(filter.branchPolicy, { branch: t.branch, projectId: t.projectId }, 'empty')
    : null;
  if (branch) conditions.push(branch);
  return conditions;
}

/**
 * The rollup rows matching a filter, summed per project and day over every
 * environment, branch, run kind and part (retained plus archived). The suite
 * size is read with MAX; everything else is a sum, and averages are divided
 * by the summed run count by the caller, never per row.
 */
export async function readRollupSeries(db: DrizzleDB, filter: RollupFilter): Promise<RollupDayRow[]> {
  const conditions = rollupConditions(filter);
  if (!conditions) return [];
  const t = analyticsDailyRollups;
  const sums: Record<string, SQL> = {};
  for (const field of SUMMED_FIELDS) sums[field] = sql`COALESCE(SUM(${t[field]}), 0)`;
  const rows: any[] = await db
    .select({ projectId: t.projectId, day: t.day, ...sums, maxTotalTests: sql`COALESCE(MAX(${t.maxTotalTests}), 0)` })
    .from(t)
    .where(and(...conditions))
    .groupBy(t.projectId, t.day)
    .orderBy(t.day);
  return rows.map((row) => {
    const out = { projectId: Number(row.projectId), day: String(row.day) } as RollupDayRow;
    for (const field of SUMMED_FIELDS) out[field] = Number(row[field]) || 0;
    out.maxTotalTests = Number(row.maxTotalTests) || 0;
    return out;
  });
}

export interface RollupCellRow extends RollupDayRow {
  environment: string;
  branch: string;
  fullRun: boolean;
}

/**
 * The rollup rows matching a filter, summed per cell (project, day,
 * environment, branch and run kind) over the retained and archived parts:
 * what a breakdown by environment, branch or run kind groups.
 */
export async function readRollupCells(db: DrizzleDB, filter: RollupFilter): Promise<RollupCellRow[]> {
  const conditions = rollupConditions(filter);
  if (!conditions) return [];
  const t = analyticsDailyRollups;
  const sums: Record<string, SQL> = {};
  for (const field of SUMMED_FIELDS) sums[field] = sql`COALESCE(SUM(${t[field]}), 0)`;
  const rows: any[] = await db
    .select({
      projectId: t.projectId,
      day: t.day,
      environment: t.environment,
      branch: t.branch,
      fullRun: t.fullRun,
      ...sums,
      maxTotalTests: sql`COALESCE(MAX(${t.maxTotalTests}), 0)`,
    })
    .from(t)
    .where(and(...conditions))
    .groupBy(t.projectId, t.day, t.environment, t.branch, t.fullRun)
    .orderBy(t.day);
  return rows.map((row) => {
    const out = {
      projectId: Number(row.projectId),
      day: String(row.day),
      environment: String(row.environment ?? ''),
      branch: String(row.branch ?? ''),
      fullRun: Number(row.fullRun) === 1,
    } as RollupCellRow;
    for (const field of SUMMED_FIELDS) out[field] = Number(row[field]) || 0;
    out.maxTotalTests = Number(row.maxTotalTests) || 0;
    return out;
  });
}

/** The day of the oldest rollup row a filter covers, for "data starts on" notes. */
export async function firstRollupDay(db: DrizzleDB, filter: RollupFilter): Promise<string | null> {
  const conditions = rollupConditions(filter);
  if (!conditions) return null;
  const [row] = await db
    .select({ day: sql<string | null>`MIN(${analyticsDailyRollups.day})` })
    .from(analyticsDailyRollups)
    .where(and(...conditions));
  return row?.day ?? null;
}
