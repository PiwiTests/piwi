/**
 * The tracker issue a cluster is already known by, if any — the join every
 * surface that "carries the key" reads: the notifications, the PR feedback
 * comment, the fix plan, and the MCP outputs. A cluster's known issue is its
 * tracker link when it has one, else a link its tests declared
 * (`clusterKnownIssues`).
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { entityLinks } from '../../database/schema';
import type { DbClient } from '../../database';
import type { EntityLink } from '../../database/schema';
import { clusterKnownIssues, isDeclaredLink, isTrackerLink } from '#shared/handlers/known-issues';

export interface KnownIssue {
  key: string;
  url: string;
  status: string | null;
}

/**
 * The cluster's tracker link — the newest link with a key that Piwi can write
 * back through (a Jira link, or any link that carries a `connection_id`), pinned
 * or created: a link the tests declared is never written to. The full row, for
 * the policies that comment and transition.
 */
export async function getClusterTrackerLink(db: DbClient, clusterId: number): Promise<EntityLink | null> {
  const links = await db
    .select()
    .from(entityLinks)
    .where(and(eq(entityLinks.failureClusterId, clusterId), isNotNull(entityLinks.key)))
    .orderBy(desc(entityLinks.id));
  return links.find((link) => isTrackerLink(link) && !isDeclaredLink(link)) ?? null;
}

/** The cluster's known tracker issue, or null. */
export async function getClusterKnownIssue(db: DbClient, clusterId: number): Promise<KnownIssue | null> {
  const issue = (await clusterKnownIssues(db, [clusterId])).get(clusterId);
  return issue ? { key: issue.key, url: issue.url, status: issue.status } : null;
}

/** Known issues for several clusters at once, keyed by cluster id. */
export async function getClusterKnownIssues(db: DbClient, clusterIds: number[]): Promise<Map<number, KnownIssue>> {
  const issues = await clusterKnownIssues(db, clusterIds);
  return new Map([...issues].map(([id, issue]) => [id, { key: issue.key, url: issue.url, status: issue.status }]));
}
