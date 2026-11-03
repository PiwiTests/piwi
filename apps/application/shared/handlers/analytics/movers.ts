import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { projects, testCases, testRuns, testRunsCases } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import { flakyResultSql } from '../test-case-aggregates';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsMover, AnalyticsMoverKind, AnalyticsMovers } from '../../analytics/types';
import { MOVERS_MAX_ROWS, moversOptionsSchema } from '../../analytics/registry';
import { contextRunConditions, getAnalyticsContext, type AnalyticsContext, type ProjectAccess } from './common';

/** A duration moves when it changes by more than this share. */
export const MOVER_DURATION_CHANGE = 0.25;
/** Executions a test needs in each period before its duration is compared. */
const MIN_EXECUTIONS = 2;
/** Durations under this are noise at any ratio. */
const MIN_DURATION_MS = 200;

/** The movers' group labels; a report translates them. */
export const MOVER_LABELS: Record<AnalyticsMoverKind, string> = {
  'became-flaky': 'Became flaky',
  'stopped-flaky': 'Stopped being flaky',
  slower: 'Got slower',
  faster: 'Got faster',
};

interface TestStability {
  projectId: number;
  testCaseId: number;
  executions: number;
  flaky: number;
  /** Average duration of the passing executions; null without one. */
  avgPassedMs: number | null;
}

/** Per test, over `[fromMs, toMs)`: executions, flaky executions and the average passed duration. */
async function loadStability(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  fromMs: number,
  toMs: number,
): Promise<Map<string, TestStability>> {
  const out = new Map<string, TestStability>();
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return out;
  const conditions: SQL[] = [...contextRunConditions(ctx, fromMs, toMs)];
  if (ctx.testFilter?.browsers) conditions.push(inArray(testRunsCases.browserName, ctx.testFilter.browsers));
  const rows: Array<{
    projectId: number;
    testCaseId: number;
    executions: number;
    flaky: number;
    avgPassedMs: number | null;
  }> = await db
    .select({
      projectId: testRuns.projectId,
      testCaseId: testRunsCases.testCaseId,
      executions: sql<number>`count(*)`,
      flaky: sql<number>`sum(case when ${flakyResultSql()} then 1 else 0 end)`,
      avgPassedMs: sql<
        number | null
      >`avg(case when ${testRunsCases.status} = 'passed' then ${testRunsCases.duration} end)`,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(...conditions))
    .groupBy(testRuns.projectId, testRunsCases.testCaseId);
  const ids = ctx.testFilter?.testCaseIds;
  for (const row of rows) {
    if (ids && !ids.get(row.projectId)?.has(row.testCaseId)) continue;
    out.set(`${row.projectId}:${row.testCaseId}`, {
      projectId: row.projectId,
      testCaseId: row.testCaseId,
      executions: Number(row.executions),
      flaky: Number(row.flaky ?? 0),
      avgPassedMs: row.avgPassedMs == null ? null : Math.round(Number(row.avgPassedMs)),
    });
  }
  return out;
}

type Move = Omit<AnalyticsMover, 'projectName' | 'title' | 'filePath'> & { kind: AnalyticsMoverKind; rank: number };

/**
 * The tests that moved against the comparison period: pure over the two
 * periods' per-test numbers. A test became flaky when it flaked now and never
 * before (having run before), stopped when the reverse; it got slower or
 * faster when its average passed duration changed by more than 25 %.
 */
export function findMovers(current: Map<string, TestStability>, previous: Map<string, TestStability>): Move[] {
  const moves: Move[] = [];
  for (const [key, now] of current) {
    const before = previous.get(key);
    if (!before) continue;
    const base = { testCaseId: now.testCaseId, projectId: now.projectId };
    const rateNow = now.flaky / now.executions;
    const rateBefore = before.flaky / before.executions;
    if (now.flaky > 0 && before.flaky === 0) {
      moves.push({
        ...base,
        kind: 'became-flaky',
        before: 0,
        after: round2(rateNow),
        changePct: null,
        rank: now.flaky,
      });
    } else if (now.flaky === 0 && before.flaky > 0) {
      moves.push({
        ...base,
        kind: 'stopped-flaky',
        before: round2(rateBefore),
        after: 0,
        changePct: null,
        rank: before.flaky,
      });
    }
    if (
      now.avgPassedMs !== null &&
      before.avgPassedMs !== null &&
      now.executions >= MIN_EXECUTIONS &&
      before.executions >= MIN_EXECUTIONS &&
      Math.max(now.avgPassedMs, before.avgPassedMs) >= MIN_DURATION_MS &&
      before.avgPassedMs > 0
    ) {
      const change = (now.avgPassedMs - before.avgPassedMs) / before.avgPassedMs;
      if (Math.abs(change) > MOVER_DURATION_CHANGE) {
        moves.push({
          ...base,
          kind: change > 0 ? 'slower' : 'faster',
          before: before.avgPassedMs,
          after: now.avgPassedMs,
          changePct: Math.round(change * 100),
          // The biggest absolute time moved first.
          rank: Math.abs(now.avgPassedMs - before.avgPassedMs),
        });
      }
    }
  }
  return moves;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Tests that became flaky, stopped being flaky, got slower or faster by more
 * than 25 % against the comparison period. Read from the stored runs, so the
 * two periods reach back only as far as retention keeps them; each direction
 * keeps its top rows, at most 25.
 */
export async function getAnalyticsMovers(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
  rawOptions: unknown = {},
): Promise<AnalyticsMovers> {
  const { limit } = moversOptionsSchema.parse(rawOptions ?? {});
  const ctx = await getAnalyticsContext(db, scope, access);
  const kinds = Object.keys(MOVER_LABELS) as AnalyticsMoverKind[];
  const comparison = ctx.comparison;
  if (!comparison) return { groups: [], comparisonLabel: null };

  const [current, previous] = await Promise.all([
    loadStability(db, ctx, ctx.period.from.getTime(), ctx.period.to.getTime()),
    loadStability(db, ctx, comparison.from.getTime(), comparison.to.getTime()),
  ]);
  const moves = findMovers(current, previous);
  const cap = Math.min(limit, MOVERS_MAX_ROWS);
  const kept = kinds.flatMap((kind) =>
    moves
      .filter((m) => m.kind === kind)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, cap),
  );

  const caseIds = [...new Set(kept.map((m) => m.testCaseId))];
  const details: Array<{
    id: number;
    title: string;
    filePath: string;
    projectName: string;
    projectLabel: string | null;
  }> =
    caseIds.length > 0
      ? await db
          .select({
            id: testCases.id,
            title: testCases.title,
            filePath: testCases.filePath,
            projectName: projects.name,
            projectLabel: projects.label,
          })
          .from(testCases)
          .innerJoin(projects, eq(testCases.projectId, projects.id))
          .where(inArray(testCases.id, caseIds))
      : [];
  const byId = new Map(details.map((d) => [d.id, d]));

  return {
    comparisonLabel: comparison.label,
    groups: kinds
      .map((kind) => ({
        kind,
        label: MOVER_LABELS[kind],
        items: kept
          .filter((m) => m.kind === kind)
          .map(({ kind: _kind, rank: _rank, ...m }) => {
            const d = byId.get(m.testCaseId);
            return {
              ...m,
              projectName: d ? d.projectLabel || d.projectName : `Project ${m.projectId}`,
              title: d?.title ?? `Test ${m.testCaseId}`,
              filePath: d?.filePath ?? '',
            };
          }),
      }))
      .filter((g) => g.items.length > 0),
  };
}
