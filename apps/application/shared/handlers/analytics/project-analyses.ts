/**
 * The single-project analyses of the project page as dashboard widgets: spec
 * health, the slowest tests, the performance trend, timeout opportunities and
 * selection health. Each answers only when the scope resolves to exactly one
 * project the viewer can open, and says so otherwise.
 */
import { inArray } from 'drizzle-orm';
import { projects } from '../../../server/database/schema';
import { getTimeoutThresholds } from '../../../server/utils/timeout-thresholds';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsProjectAnalysis } from '../../analytics/types';
import { periodDays } from '../../analytics/period';
import { singleProjectOptionsSchema } from '../../analytics/registry';
import type { TimeoutOpportunity } from '../../analytics/timeout-hygiene';
import {
  getProjectPerformance,
  getProjectSlowTests,
  getProjectSpecHealth,
  getProjectTimeoutOpportunities,
} from '../projects';
import { getSelectionAnalytics, type SelectionAnalytics } from '../selection-analytics';
import { getAnalyticsContext, type ProjectAccess } from './common';

export const SINGLE_PROJECT_REASON = 'This widget analyses one project: pick a single project under Filters.';

/** How many recent runs the run-count analyses read. */
const RECENT_RUNS = 20;

async function singleProject(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess,
): Promise<{ id: number; name: string } | null> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const rows: { id: number; name: string; label: string | null }[] = await db
    .select({ id: projects.id, name: projects.name, label: projects.label })
    .from(projects)
    .where(ctx.allowed === 'all' ? undefined : inArray(projects.id, ctx.allowed.length > 0 ? ctx.allowed : [0]))
    .limit(2);
  return rows.length === 1 ? { id: rows[0]!.id, name: rows[0]!.label || rows[0]!.name } : null;
}

async function analyse<T>(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess,
  run: (projectId: number) => Promise<T>,
): Promise<AnalyticsProjectAnalysis<T>> {
  const project = await singleProject(db, scope, access);
  if (!project) return { project: null, reason: SINGLE_PROJECT_REASON };
  return { project, data: await run(project.id) };
}

export type SpecHealthData = Awaited<ReturnType<typeof getProjectSpecHealth>>;
export type SlowTestsData = Awaited<ReturnType<typeof getProjectSlowTests>>;
export type PerformanceTrendData = Awaited<ReturnType<typeof getProjectPerformance>>;

/** Pass and flaky rates per spec directory over the period (at most the last 90 days). */
export async function getAnalyticsSpecHealth(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
  rawOptions: unknown = {},
): Promise<AnalyticsProjectAnalysis<SpecHealthData>> {
  const { limit } = singleProjectOptionsSchema.parse(rawOptions ?? {});
  const ctx = await getAnalyticsContext(db, scope, access);
  return analyse(db, scope, access, async (id) => {
    const health = await getProjectSpecHealth(db, id, periodDays(ctx.period));
    // Worst pass rate first; an area with no passed or failed run last.
    const specs = [...health.specs].sort((a, b) => (a.passRate ?? 2) - (b.passRate ?? 2)).slice(0, limit);
    return { specs };
  });
}

/** The slowest tests of the project's recent runs. */
export async function getAnalyticsSlowTests(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
  rawOptions: unknown = {},
): Promise<AnalyticsProjectAnalysis<SlowTestsData>> {
  const { limit } = singleProjectOptionsSchema.parse(rawOptions ?? {});
  return analyse(db, scope, access, async (id) => (await getProjectSlowTests(db, id, RECENT_RUNS)).slice(0, limit));
}

/** Run duration and test durations of the project's runs over the period. */
export async function getAnalyticsPerformanceTrend(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsProjectAnalysis<PerformanceTrendData>> {
  const ctx = await getAnalyticsContext(db, scope, access);
  return analyse(db, scope, access, (id) =>
    getProjectPerformance(db, id, 200, ctx.period.from.toISOString(), ctx.period.to.toISOString(), scope.fullRunsOnly),
  );
}

/** Tests whose timeout is far above their real duration, or that keep a `test.slow()` they no longer need. */
export async function getAnalyticsTimeoutOpportunities(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
  rawOptions: unknown = {},
): Promise<AnalyticsProjectAnalysis<TimeoutOpportunity[]>> {
  const { limit } = singleProjectOptionsSchema.parse(rawOptions ?? {});
  return analyse(db, scope, access, async (id) =>
    (await getProjectTimeoutOpportunities(db, id, RECENT_RUNS, await getTimeoutThresholds(db))).slice(0, limit),
  );
}

/** How the project's selections resolve today, and how much of the suite none of them selects. */
export async function getAnalyticsSelectionHealth(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsProjectAnalysis<SelectionAnalytics>> {
  return analyse(db, scope, access, (id) => getSelectionAnalytics(db, id));
}
