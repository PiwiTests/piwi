import { inArray } from 'drizzle-orm';
import { failureClusters } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import type { AnalyticsClusterLandscape, AnalyticsClusterRow } from '../../analytics/types';
import { DAY_MS, fetchContextProjects, getAnalyticsContext, type ProjectAccess } from './common';

const TOP_CLUSTERS = 15;

/**
 * Open failure clusters across every project the caller can see: the biggest
 * and oldest unresolved root causes, plus the error-type mix. Clusters survive
 * run retention, so this view works on long horizons too.
 */
export async function getAnalyticsClusterLandscape(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsClusterLandscape> {
  const empty: AnalyticsClusterLandscape = { totalOpen: 0, resolvedInPeriod: 0, byErrorType: [], clusters: [] };

  const ctx = await getAnalyticsContext(db, scope, access);
  const allowed = ctx.allowed;
  if (allowed !== 'all' && allowed.length === 0) return empty;

  const rows: any[] = await db
    .select({
      id: failureClusters.id,
      projectId: failureClusters.projectId,
      title: failureClusters.title,
      signature: failureClusters.signature,
      errorType: failureClusters.errorType,
      selector: failureClusters.selector,
      occurrences: failureClusters.occurrences,
      status: failureClusters.status,
      createdAt: failureClusters.createdAt,
      updatedAt: failureClusters.updatedAt,
    })
    .from(failureClusters)
    .where(allowed === 'all' ? undefined : inArray(failureClusters.projectId, allowed));

  const cutoff = ctx.period.from.getTime();
  const open = rows.filter((c) => c.status === 'open');
  const resolvedInPeriod = rows.filter(
    (c) => c.status === 'resolved' && c.updatedAt && new Date(c.updatedAt).getTime() >= cutoff,
  ).length;

  const byErrorType = new Map<string, number>();
  for (const cluster of open) {
    const type = cluster.errorType ?? 'unknown';
    byErrorType.set(type, (byErrorType.get(type) ?? 0) + 1);
  }

  const scopedProjects = await fetchContextProjects(db, ctx);
  const projectById = new Map(scopedProjects.map((p) => [p.id, p]));
  const now = Date.now();

  const clusters = open
    .sort((a, b) => (b.occurrences ?? 0) - (a.occurrences ?? 0))
    .slice(0, TOP_CLUSTERS)
    .map((cluster): AnalyticsClusterRow => ({
      id: cluster.id,
      projectId: cluster.projectId,
      projectName: projectById.get(cluster.projectId)?.name ?? `Project ${cluster.projectId}`,
      projectLabel: projectById.get(cluster.projectId)?.label ?? null,
      title: cluster.title,
      signature: cluster.signature,
      errorType: cluster.errorType,
      selector: cluster.selector ?? null,
      occurrences: cluster.occurrences ?? 0,
      ageDays: Math.max(0, Math.floor((now - new Date(cluster.createdAt).getTime()) / DAY_MS)),
      firstSeenAt: cluster.createdAt,
    }));

  return {
    totalOpen: open.length,
    resolvedInPeriod,
    byErrorType: [...byErrorType.entries()]
      .map(([errorType, count]) => ({ errorType, count }))
      .sort((a, b) => b.count - a.count),
    clusters,
  };
}
