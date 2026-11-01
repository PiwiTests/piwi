/**
 * Status pull — reading the ticket back into the dashboard. Every entity link
 * that carries the connection its project is bound to is refreshed through its
 * tracker: the status name and color, the title, the status category and
 * assignee (kept in the link's metadata), so a cluster whose Jira issue closed
 * last week stops sitting in the inbox as open. A link on another connection is
 * not read (`linksOnBoundConnection`).
 *
 * Links on an open cluster refresh every sweep; links on a resolved or ignored
 * cluster refresh at most daily. When the ticket moves to Done the
 * resolve-on-close policy closes the cluster (otherwise the cluster page offers
 * the reconcile), and a ticket moved out of Done under a resolved cluster
 * reopens it. Only a move counts, against the category last recorded for the
 * link (as it was filed or linked, or by the previous sync), so a cluster a
 * person reopened or that regressed under a closed ticket is not pulled back on
 * every sweep; a regressed cluster is never closed by its ticket.
 * Work is bounded per sweep and a connection's failure is recorded on its
 * `last_error` rather than failing the whole sweep.
 */
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { bugReports, entityLinks, failureClusters, integrationConnections } from '../../database/schema';
import type { DbClient } from '../../database';
import type { EntityLink } from '../../database/schema';
import type { IssueTracker } from './types';
import { statusColorForCategory, ticketMove } from './types';
import { createTracker } from './connections';
import { readProjectIntegration } from './binding';
import { linksOnBoundConnection } from './bound-connection';
import { updateEntityLinkStatus, mergeEntityLinkMetadata } from './entity-links';
import { appendTriageNote } from '../fix-verification';
import { SYNC_BATCH_LIMIT, isLinkRefreshDue } from '#shared/integrations/sync-config';
import type { ResolvedProjectIntegration } from '#shared/integrations/binding';

/** The cluster a link belongs to, for the policy checks. */
interface LinkCluster {
  id: number;
  projectId: number;
  status: string;
  triageNote: string | null;
  fixVerification: string | null;
}

/** Load the cluster (if any) each link is scoped to, keyed by link id. */
async function clustersForLinks(db: DbClient, links: EntityLink[]): Promise<Map<number, LinkCluster>> {
  const byLink = new Map<number, LinkCluster>();
  const clusterIds = [...new Set(links.map((l) => l.failureClusterId).filter((id): id is number => id != null))];
  if (clusterIds.length === 0) return byLink;
  const rows = await db
    .select({
      id: failureClusters.id,
      projectId: failureClusters.projectId,
      status: failureClusters.status,
      triageNote: failureClusters.triageNote,
      fixVerification: failureClusters.fixVerification,
    })
    .from(failureClusters)
    .where(inArray(failureClusters.id, clusterIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const link of links) {
    if (link.failureClusterId != null) {
      const c = byId.get(link.failureClusterId);
      if (c) byLink.set(link.id, c);
    }
  }
  return byLink;
}

/** Record a connection-level failure without failing the sweep. */
async function recordConnectionError(db: DbClient, connectionId: number, message: string): Promise<void> {
  await db
    .update(integrationConnections)
    .set({ status: 'failed', lastError: message.slice(0, 500), lastCheckedAt: new Date(), updatedAt: new Date() })
    .where(eq(integrationConnections.id, connectionId));
}

/** Refresh one link's cached status and drive the resolve/reopen policies. */
async function syncOneLink(
  db: DbClient,
  tracker: IssueTracker,
  link: EntityLink,
  cluster: LinkCluster | undefined,
  bindingFor: (projectId: number) => Promise<ResolvedProjectIntegration>,
): Promise<void> {
  const idOrKey = link.externalId ?? link.key;
  if (!idOrKey) return;
  const issue = await tracker.getIssue(idOrKey);
  if (!issue) return;

  await updateEntityLinkStatus(db, link.id, {
    title: issue.title,
    statusText: issue.status,
    statusColor: issue.statusColor ?? statusColorForCategory(issue.statusCategory),
    key: issue.key,
  });
  const previousCategory = (link.metadata as { statusCategory?: string | null } | null)?.statusCategory ?? null;
  // The last category the tracker reported: a sync that reports none keeps it.
  await mergeEntityLinkMetadata(db, link.id, {
    statusCategory: issue.statusCategory ?? previousCategory,
    assignee: issue.assignee?.displayName ?? null,
  });

  if (link.bugReportId != null) {
    await syncBugReport(db, link.bugReportId, previousCategory, issue.statusCategory, bindingFor);
    return;
  }
  if (!cluster) return;
  const move = ticketMove(previousCategory, issue.statusCategory);
  if (!move) return;
  const binding = await bindingFor(cluster.projectId);

  // Ticket moved to Done → resolve the cluster when the policy is on, unless the
  // failure came back after its fix. Without the policy, the cluster page offers
  // the reconcile instead.
  if (
    move === 'done' &&
    cluster.status === 'open' &&
    cluster.fixVerification !== 'regressed' &&
    binding.policies.resolveOnClose
  ) {
    await db
      .update(failureClusters)
      .set({
        status: 'resolved',
        triageNote: appendTriageNote(cluster.triageNote, `Resolved automatically: ${issue.key} is Done`),
        updatedAt: new Date(),
      })
      .where(eq(failureClusters.id, cluster.id));
    return;
  }

  // Ticket moved out of Done while the cluster is resolved → reopen it with a
  // note, mirroring the regression reopen.
  if (move === 'reopened' && cluster.status === 'resolved' && binding.policies.reopenOnTicketReopen) {
    await db
      .update(failureClusters)
      .set({
        status: 'open',
        triageNote: appendTriageNote(cluster.triageNote, `Reopened automatically: ${issue.key} was reopened`),
        updatedAt: new Date(),
      })
      .where(eq(failureClusters.id, cluster.id));
  }
}

export interface SyncResult {
  refreshed: number;
  failed: number;
  skipped: number;
}

/**
 * A bug report follows its ticket's moves: closed when the ticket moves to Done
 * (`resolveOnClose`), open again when it moves out of Done
 * (`reopenOnTicketReopen`). Only a move counts, against the category last
 * recorded for the link: a report its own passing test closed while the ticket is still in
 * progress stays closed. A dismissed report stays dismissed.
 */
async function syncBugReport(
  db: DbClient,
  bugReportId: number,
  previousCategory: string | null,
  statusCategory: string | null | undefined,
  bindingFor: (projectId: number) => Promise<ResolvedProjectIntegration>,
): Promise<void> {
  const move = ticketMove(previousCategory, statusCategory);
  if (!move) return;
  const [report] = await db
    .select({ projectId: bugReports.projectId, status: bugReports.status, testCaseId: bugReports.testCaseId })
    .from(bugReports)
    .where(eq(bugReports.id, bugReportId));
  if (!report || report.status === 'dismissed') return;
  const binding = await bindingFor(report.projectId);
  const now = new Date();
  if (move === 'done' && report.status !== 'closed' && binding.policies.resolveOnClose) {
    await db
      .update(bugReports)
      .set({ status: 'closed', closedAt: now, closedByRunId: null, statusRunId: null, updatedAt: now })
      .where(eq(bugReports.id, bugReportId));
    return;
  }
  if (move === 'reopened' && report.status === 'closed' && binding.policies.reopenOnTicketReopen) {
    await db
      .update(bugReports)
      .set({
        status: report.testCaseId ? 'test-committed' : 'open',
        closedAt: null,
        closedByRunId: null,
        statusRunId: null,
        updatedAt: now,
      })
      .where(eq(bugReports.id, bugReportId));
  }
}

/**
 * Refresh due tracker links, bounded to {@link SYNC_BATCH_LIMIT} per sweep. Open
 * clusters come first so a large backlog of resolved links never starves them.
 */
export async function syncTrackerLinks(db: DbClient, opts: { now?: Date; limit?: number } = {}): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? SYNC_BATCH_LIMIT;

  const links = await linksOnBoundConnection(
    db,
    await db
      .select()
      .from(entityLinks)
      .where(and(isNotNull(entityLinks.connectionId), isNotNull(entityLinks.key)))
      .orderBy(asc(entityLinks.unfurledAt)),
  );

  const clusterByLink = await clustersForLinks(db, links);
  const due = links
    .filter((l) => isLinkRefreshDue(clusterByLink.get(l.id)?.status ?? null, l.unfurledAt, now))
    .slice(0, limit);

  const trackerCache = new Map<number, IssueTracker | null>();
  const bindingCache = new Map<number, ResolvedProjectIntegration>();
  const bindingFor = async (projectId: number): Promise<ResolvedProjectIntegration> => {
    let b = bindingCache.get(projectId);
    if (!b) bindingCache.set(projectId, (b = await readProjectIntegration(db, projectId)));
    return b;
  };
  const failedConnections = new Set<number>();

  let refreshed = 0;
  let failed = 0;
  let skipped = 0;

  for (const link of due) {
    const connectionId = link.connectionId!;
    if (failedConnections.has(connectionId)) {
      skipped++;
      continue;
    }
    let tracker = trackerCache.get(connectionId);
    if (tracker === undefined) {
      tracker = await createTracker(db, connectionId).catch(() => null);
      trackerCache.set(connectionId, tracker);
    }
    if (!tracker) {
      failedConnections.add(connectionId);
      skipped++;
      continue;
    }
    try {
      await syncOneLink(db, tracker, link, clusterByLink.get(link.id), bindingFor);
      refreshed++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      await recordConnectionError(db, connectionId, message).catch(() => null);
      failedConnections.add(connectionId);
    }
  }

  // A connection that refreshed at least one link is healthy again.
  const healthy = [...trackerCache.entries()].filter(([id, t]) => t && !failedConnections.has(id)).map(([id]) => id);
  for (const id of healthy) {
    await db
      .update(integrationConnections)
      .set({ status: 'ok', lastError: null, lastCheckedAt: now })
      .where(and(eq(integrationConnections.id, id), eq(integrationConnections.status, 'failed')))
      .catch(() => null);
  }

  return { refreshed, failed, skipped };
}

/**
 * Sync a single connection's links to one issue immediately, those of the
 * projects bound to that connection (the webhook and the tests use this).
 */
export async function refreshLinkByExternalId(
  db: DbClient,
  connectionId: number,
  externalId: string,
): Promise<boolean> {
  const links = await linksOnBoundConnection(
    db,
    await db
      .select()
      .from(entityLinks)
      .where(and(eq(entityLinks.connectionId, connectionId), eq(entityLinks.externalId, externalId))),
  );
  if (links.length === 0) return false;
  const tracker = await createTracker(db, connectionId).catch(() => null);
  if (!tracker) return false;
  const clusterByLink = await clustersForLinks(db, links);
  const bindingCache = new Map<number, ResolvedProjectIntegration>();
  const bindingFor = async (projectId: number): Promise<ResolvedProjectIntegration> => {
    let b = bindingCache.get(projectId);
    if (!b) bindingCache.set(projectId, (b = await readProjectIntegration(db, projectId)));
    return b;
  };
  for (const link of links) {
    await syncOneLink(db, tracker, link, clusterByLink.get(link.id), bindingFor).catch(() => null);
  }
  return true;
}
