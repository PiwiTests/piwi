import { and, eq, inArray, isNull, lt, or, gte, type SQL } from 'drizzle-orm';
import { quarantinedTests, testRuns, testRunsCases } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import { flakyResultSql } from '../test-case-aggregates';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsFlakyDebt } from '../../analytics/types';
import {
  contextRunConditions,
  firstNonEmptyIndex,
  getAnalyticsContext,
  type AnalyticsContext,
  type ProjectAccess,
} from './common';
import { groupRows, loadScalarRows } from './scalar-rows';

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The executions that passed after an earlier attempt failed in `[fromMs, toMs)`: one per test and run. */
async function loadFlakyExecutions(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  fromMs: number,
  toMs: number,
): Promise<Array<{ projectId: number; testCaseId: number; startTime: Date }>> {
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return [];
  const conditions: SQL[] = [...contextRunConditions(ctx, fromMs, toMs), flakyResultSql()];
  if (ctx.testFilter?.browsers) conditions.push(inArray(testRunsCases.browserName, ctx.testFilter.browsers));
  const rows: Array<{ projectId: number; testCaseId: number; startTime: Date }> = await db
    .select({ projectId: testRuns.projectId, testCaseId: testRunsCases.testCaseId, startTime: testRuns.startTime })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(...conditions));
  const ids = ctx.testFilter?.testCaseIds;
  return ids ? rows.filter((r) => ids.get(r.projectId)?.has(r.testCaseId)) : rows;
}

/** Quarantine rows that overlap `[fromMs, toMs)`, for the count at the end of each bucket. */
async function loadQuarantine(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  fromMs: number,
  toMs: number,
): Promise<Array<{ projectId: number; testCaseId: number; createdAt: Date; releasedAt: Date | null }>> {
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return [];
  const conditions: SQL[] = [
    lt(quarantinedTests.createdAt, new Date(toMs)),
    or(isNull(quarantinedTests.releasedAt), gte(quarantinedTests.releasedAt, new Date(fromMs)))!,
  ];
  if (ctx.allowed !== 'all') conditions.push(inArray(quarantinedTests.projectId, ctx.allowed));
  const rows: Array<{ projectId: number; testCaseId: number; createdAt: Date; releasedAt: Date | null }> = await db
    .select({
      projectId: quarantinedTests.projectId,
      testCaseId: quarantinedTests.testCaseId,
      createdAt: quarantinedTests.createdAt,
      releasedAt: quarantinedTests.releasedAt,
    })
    .from(quarantinedTests)
    .where(and(...conditions));
  const ids = ctx.testFilter?.testCaseIds;
  return ids ? rows.filter((r) => ids.get(r.projectId)?.has(r.testCaseId)) : rows;
}

/** Tests in quarantine at an instant. */
function quarantinedAt(rows: Awaited<ReturnType<typeof loadQuarantine>>, atMs: number): number {
  return rows.filter((r) => {
    const created = new Date(r.createdAt).getTime();
    const released = r.releasedAt ? new Date(r.releasedAt).getTime() : null;
    return created < atMs && (released === null || released >= atMs);
  }).length;
}

/**
 * Whether flakiness is going down: flaky occurrences per run per bucket (the
 * daily rollups), the distinct flaky tests of each bucket (the stored runs,
 * so only as far back as retention keeps them) and the quarantine debt at the
 * end of each bucket, against the comparison period.
 */
export async function getAnalyticsFlakyDebt(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsFlakyDebt> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const from = ctx.period.from.getTime();
  const to = ctx.period.to.getTime();
  const comparison = ctx.comparison;
  const [rows, previousRows, flaky, quarantine] = await Promise.all([
    loadScalarRows(db, ctx, from, to),
    comparison ? loadScalarRows(db, ctx, comparison.from.getTime(), comparison.to.getTime()) : Promise.resolve([]),
    loadFlakyExecutions(db, ctx, from, to),
    loadQuarantine(db, ctx, Math.min(from, comparison?.from.getTime() ?? from), to),
  ]);

  const buckets = ctx.buckets;
  const byBucket = groupRows(rows, (row) => buckets.keyFor(row.day));
  const flakyByBucket = new Map<string, Set<string>>();
  for (const e of flaky) {
    const key = buckets.keyFor(e.startTime);
    if (!key) continue;
    const set = flakyByBucket.get(key) ?? new Set<string>();
    set.add(`${e.projectId}:${e.testCaseId}`);
    flakyByBucket.set(key, set);
  }
  const end = Math.min(to, ctx.now + 1);
  const points = buckets.keys.map((date, i) => {
    const totals = byBucket.get(date);
    const next = buckets.keys[i + 1];
    const bucketEnd = next ? Date.parse(`${next}T00:00:00Z`) : end;
    return {
      date,
      flakyPerRun: totals && totals.runs > 0 ? round1(totals.flakyTests / totals.runs) : null,
      flakyTests: flakyByBucket.get(date)?.size ?? 0,
      quarantined: quarantinedAt(quarantine, Math.min(bucketEnd, end)),
    };
  });

  const perRun = (list: typeof rows) => {
    const totals = groupRows(list, () => 'all').get('all');
    return totals && totals.runs > 0 ? round1(totals.flakyTests / totals.runs) : null;
  };
  return {
    points: points.slice(
      firstNonEmptyIndex(points, (p) => p.flakyPerRun === null && p.flakyTests === 0 && p.quarantined === 0),
    ),
    bucketDays: buckets.bucketDays,
    flakyPerRun: perRun(rows),
    previousFlakyPerRun: comparison ? perRun(previousRows) : null,
    flakyTests: new Set(flaky.map((e) => `${e.projectId}:${e.testCaseId}`)).size,
    quarantined: quarantinedAt(quarantine, end),
    previousQuarantined: comparison ? quarantinedAt(quarantine, comparison.to.getTime()) : null,
  };
}
