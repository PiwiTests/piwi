import { and, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { failureClusters, testCases, testRuns, testRunsCases } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsOwnership, AnalyticsOwnershipRow } from '../../analytics/types';
import { ownershipOptionsSchema } from '../../analytics/registry';
import { contextRunConditions, DAY_MS, getAnalyticsContext, minutes, type ProjectAccess } from './common';
import { median } from '../../utils/stats';

/** The owner key of the *Unowned* row. */
const UNOWNED = '';

function ownerKey(value: string | null | undefined): string {
  return value?.trim() || UNOWNED;
}

/**
 * One row per owner: the open failure causes assigned to them
 * (`failure_clusters.assignee`), the flaky tests and the wasted CI minutes of
 * the tests they own (`test_cases.owner`) in the period, and the median time
 * to fix over the causes they fixed, with an *Unowned* row for everything no
 * one holds. Test counts read the stored runs, so they reach back only as far
 * as retention keeps them.
 */
export async function getAnalyticsOwnership(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
  rawOptions: unknown = {},
): Promise<AnalyticsOwnership> {
  const { limit } = ownershipOptionsSchema.parse(rawOptions ?? {});
  const ctx = await getAnalyticsContext(db, scope, access);
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return { rows: [], totalOpenClusters: 0 };
  const from = ctx.period.from.getTime();
  const to = ctx.period.to.getTime();
  const now = new Date(ctx.now);
  const projectFilter = ctx.allowed === 'all' ? undefined : inArray(failureClusters.projectId, ctx.allowed);

  const executionConditions: SQL[] = [...contextRunConditions(ctx, from, to)];
  if (ctx.testFilter?.browsers) executionConditions.push(inArray(testRunsCases.browserName, ctx.testFilter.browsers));

  const [openRows, fixedRows, testRows] = await Promise.all([
    db
      .select({ assignee: failureClusters.assignee })
      .from(failureClusters)
      .where(
        and(
          eq(failureClusters.status, 'open'),
          or(isNull(failureClusters.snoozedUntil), lte(failureClusters.snoozedUntil, now)),
          projectFilter,
        ),
      ) as Promise<Array<{ assignee: string | null }>>,
    db
      .select({
        assignee: failureClusters.assignee,
        fixLandedAt: failureClusters.fixLandedAt,
        timeToResolutionMs: failureClusters.timeToResolutionMs,
      })
      .from(failureClusters)
      .where(and(sql`${failureClusters.fixLandedAt} IS NOT NULL`, projectFilter)) as Promise<
      Array<{ assignee: string | null; fixLandedAt: Date | null; timeToResolutionMs: number | null }>
    >,
    db
      .select({
        projectId: testRuns.projectId,
        testCaseId: testRunsCases.testCaseId,
        owner: testCases.owner,
        wastedMs: sql<number>`coalesce(sum(${testRunsCases.wastedTimeMs}), 0)`,
        failedMs: sql<number>`coalesce(sum(case when ${testRunsCases.status} in ('failed', 'timedout', 'timedOut') then ${testRunsCases.duration} else 0 end), 0)`,
        flaky: sql<number>`max(case when ${testRunsCases.status} = 'passed' and ${testRunsCases.retries} > 0 then 1 else 0 end)`,
      })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(and(...executionConditions))
      .groupBy(testRuns.projectId, testRunsCases.testCaseId, testCases.owner) as Promise<
      Array<{
        projectId: number;
        testCaseId: number;
        owner: string | null;
        wastedMs: number;
        failedMs: number;
        flaky: number;
      }>
    >,
  ]);

  const rows = new Map<string, AnalyticsOwnershipRow & { fixes: number[] }>();
  const rowFor = (key: string) => {
    let row = rows.get(key);
    if (!row) {
      row = {
        owner: key === UNOWNED ? null : key,
        openClusters: 0,
        flakyTests: 0,
        wastedMinutes: 0,
        medianTimeToFixDays: null,
        fixes: [],
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const c of openRows) rowFor(ownerKey(c.assignee)).openClusters += 1;
  for (const c of fixedRows) {
    const t = c.fixLandedAt ? new Date(c.fixLandedAt).getTime() : NaN;
    if (!(t >= from && t < to) || c.timeToResolutionMs == null || c.timeToResolutionMs < 0) continue;
    rowFor(ownerKey(c.assignee)).fixes.push(c.timeToResolutionMs);
  }
  const ids = ctx.testFilter?.testCaseIds;
  const wastedMs = new Map<string, number>();
  for (const t of testRows) {
    if (ids && !ids.get(t.projectId)?.has(t.testCaseId)) continue;
    const key = ownerKey(t.owner);
    const row = rowFor(key);
    if (Number(t.flaky) > 0) row.flakyTests += 1;
    wastedMs.set(key, (wastedMs.get(key) ?? 0) + Number(t.wastedMs) + Number(t.failedMs));
  }

  const out: AnalyticsOwnershipRow[] = [...rows.entries()]
    .map(([key, row]) => {
      const mid = median(row.fixes);
      return {
        owner: row.owner,
        openClusters: row.openClusters,
        flakyTests: row.flakyTests,
        wastedMinutes: minutes(wastedMs.get(key) ?? 0),
        medianTimeToFixDays: mid === null ? null : Math.round((mid / DAY_MS) * 10) / 10,
      };
    })
    .filter((r) => r.openClusters > 0 || r.flakyTests > 0 || r.wastedMinutes > 0 || r.medianTimeToFixDays !== null)
    .sort(
      (a, b) =>
        // The Unowned row closes the list, whatever it holds.
        Number(a.owner === null) - Number(b.owner === null) ||
        b.openClusters - a.openClusters ||
        b.wastedMinutes - a.wastedMinutes ||
        b.flakyTests - a.flakyTests ||
        (a.owner ?? '').localeCompare(b.owner ?? ''),
    );
  const unowned = out.find((r) => r.owner === null);
  const owned = out.filter((r) => r.owner !== null).slice(0, limit);
  return { rows: unowned ? [...owned, unowned] : owned, totalOpenClusters: openRows.length };
}
