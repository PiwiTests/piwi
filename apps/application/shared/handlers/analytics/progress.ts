import { and, count, desc, eq, gte, inArray, isNotNull, lt, lte, sum, type SQL } from 'drizzle-orm';
import {
  entityLinks,
  failureClusters,
  handbackOutcomeRollups,
  handbackOutcomes,
  projects,
  quarantinedTests,
} from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsProgress } from '../../analytics/types';
import { DAY_MS, dayKey, getAnalyticsContext, type AnalyticsContext, type ProjectAccess } from './common';

/** Link providers that are tracker tickets, for "with a ticket". */
const TICKET_PROVIDERS = ['jira', 'github-issue', 'gitlab-issue', 'linear'];
const RECENT_FIXES = 5;

function projectCondition(ctx: AnalyticsContext, column: any): SQL | undefined {
  return ctx.allowed === 'all' ? undefined : inArray(column, ctx.allowed);
}

/**
 * What is being done about failures in the period: failure clusters fixed and
 * whether the fixes held, open ones assigned or ticketed, tests quarantined
 * and released, auto-heal pull requests opened.
 *
 * Opened auto-heal pull requests are their `suggested` hand-back outcomes, so
 * the count survives retention pruning the heal actions: the rows still stored
 * in the period, plus the daily counters of the pruned ones on its days.
 */
export async function getAnalyticsProgress(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsProgress> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const empty: AnalyticsProgress = {
    fixed: 0,
    held: 0,
    assigned: 0,
    withTicket: 0,
    releasedFromQuarantine: 0,
    quarantined: 0,
    healPullRequests: 0,
    recentFixes: [],
  };
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return empty;
  const from = ctx.period.from;
  const to = ctx.period.to;
  const openCondition = and(eq(failureClusters.status, 'open'), projectCondition(ctx, failureClusters.projectId));

  const healOpened = and(eq(handbackOutcomes.kind, 'auto-heal-pr'), eq(handbackOutcomes.outcome, 'suggested'));
  const [fixedRows, assignedRows, ticketRows, releasedRows, quarantinedRows, healRows, healCounters] =
    await Promise.all([
      db
        .select({
          id: failureClusters.id,
          projectId: failureClusters.projectId,
          projectName: projects.name,
          projectLabel: projects.label,
          title: failureClusters.title,
          signature: failureClusters.signature,
          createdAt: failureClusters.createdAt,
          fixLandedAt: failureClusters.fixLandedAt,
          fixVerification: failureClusters.fixVerification,
          assignee: failureClusters.assignee,
          occurrences: failureClusters.occurrences,
        })
        .from(failureClusters)
        .innerJoin(projects, eq(failureClusters.projectId, projects.id))
        .where(
          and(
            gte(failureClusters.fixLandedAt, from),
            lt(failureClusters.fixLandedAt, to),
            projectCondition(ctx, failureClusters.projectId),
          ),
        )
        .orderBy(desc(failureClusters.fixLandedAt)) as Promise<any[]>,
      db
        .select({ n: count() })
        .from(failureClusters)
        .where(and(openCondition, isNotNull(failureClusters.assignee))) as Promise<{ n: number }[]>,
      db
        .selectDistinct({ id: entityLinks.failureClusterId })
        .from(entityLinks)
        .innerJoin(failureClusters, eq(entityLinks.failureClusterId, failureClusters.id))
        .where(and(openCondition, inArray(entityLinks.provider, TICKET_PROVIDERS))) as Promise<{ id: number }[]>,
      db
        .select({ n: count() })
        .from(quarantinedTests)
        .where(
          and(
            gte(quarantinedTests.releasedAt, from),
            lt(quarantinedTests.releasedAt, to),
            projectCondition(ctx, quarantinedTests.projectId),
          ),
        ) as Promise<{ n: number }[]>,
      db
        .select({ n: count() })
        .from(quarantinedTests)
        .where(
          and(
            gte(quarantinedTests.createdAt, from),
            lt(quarantinedTests.createdAt, to),
            projectCondition(ctx, quarantinedTests.projectId),
          ),
        ) as Promise<{ n: number }[]>,
      db
        .select({ n: count() })
        .from(handbackOutcomes)
        .where(
          and(
            healOpened,
            gte(handbackOutcomes.createdAt, from),
            lt(handbackOutcomes.createdAt, to),
            projectCondition(ctx, handbackOutcomes.projectId),
          ),
        ) as Promise<{ n: number }[]>,
      db
        .select({ n: sum(handbackOutcomeRollups.count) })
        .from(handbackOutcomeRollups)
        .where(
          and(
            eq(handbackOutcomeRollups.kind, 'auto-heal-pr'),
            eq(handbackOutcomeRollups.outcome, 'suggested'),
            gte(handbackOutcomeRollups.day, dayKey(from)),
            lte(handbackOutcomeRollups.day, dayKey(new Date(to.getTime() - 1))),
            projectCondition(ctx, handbackOutcomeRollups.projectId),
          ),
        ) as Promise<{ n: number | string | null }[]>,
    ]);

  const held = fixedRows.filter((r) => r.fixVerification !== 'regressed');
  return {
    fixed: fixedRows.length,
    held: held.length,
    assigned: Number(assignedRows[0]?.n ?? 0),
    withTicket: ticketRows.length,
    releasedFromQuarantine: Number(releasedRows[0]?.n ?? 0),
    quarantined: Number(quarantinedRows[0]?.n ?? 0),
    healPullRequests: Number(healRows[0]?.n ?? 0) + Number(healCounters[0]?.n ?? 0),
    recentFixes: fixedRows.slice(0, RECENT_FIXES).map((r) => ({
      id: r.id,
      projectId: r.projectId,
      projectName: r.projectLabel || r.projectName,
      title: r.title || r.signature,
      ageDays: Math.floor((new Date(r.fixLandedAt).getTime() - new Date(r.createdAt).getTime()) / DAY_MS),
      assignee: r.assignee ?? null,
      occurrences: r.occurrences ?? 0,
      fixedAt: new Date(r.fixLandedAt).toISOString(),
      held: r.fixVerification !== 'regressed',
    })),
  };
}
