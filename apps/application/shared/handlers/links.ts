import {
  entityLinks,
  entityLinkDismissals,
  testRuns,
  testRunsCases,
  testCases,
  failureClusters,
  bugReports,
} from '../../server/database/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { safeHttpUrl } from '../utils/safe-url';
import { detectProvider, extractKey, type LinkProvider } from '../link-detect';

import type { DrizzleDB } from './db';
import { DECLARED_LINK_ORIGINS, isDeclaredLink } from './known-issues';

/**
 * How a URL resolved against the configured connections. Injected by the server
 * (which reaches the connection clients) so this shared handler stays free of
 * server-only code and keeps running in the browser demo.
 */
export type LinkConnectionResolver = (
  url: string,
) => Promise<{ provider: LinkProvider; connectionId: number | null; key: string | null }>;

/** Resolve a URL's provider/key/connection, using the resolver when given. */
async function resolveUrl(
  url: string,
  resolver?: LinkConnectionResolver,
): Promise<{ provider: string; key: string | null; connectionId: number | null; externalId: string | null }> {
  if (resolver) {
    const r = await resolver(url);
    return {
      provider: r.provider,
      key: r.key,
      connectionId: r.connectionId,
      externalId: r.connectionId ? r.key : null,
    };
  }
  const provider = detectProvider(url);
  return { provider, key: extractKey(url, provider), connectionId: null, externalId: null };
}

/** The entities an external link can be pinned to. */
export type LinkEntityType = 'test_run' | 'test_runs_case' | 'test_case' | 'failure_cluster' | 'bug_report';

export const LINK_ENTITY_TYPES: readonly LinkEntityType[] = [
  'test_run',
  'test_runs_case',
  'test_case',
  'failure_cluster',
  'bug_report',
];

/** The body of a link creation: the entity, an http(s) URL and an optional title. */
export const createLinkSchema = z.object({
  entityType: z.enum(['test_run', 'test_runs_case', 'test_case', 'failure_cluster', 'bug_report']),
  entityId: z.number().int().positive(),
  url: z.string().refine((url) => safeHttpUrl(url) !== null, 'Must be an http(s) URL'),
  title: z.string().max(200).nullable().optional(),
});

/** The `entity_links` FK column that holds an id of the given entity type. */
function fkColumnFor(entityType: LinkEntityType) {
  switch (entityType) {
    case 'test_run':
      return entityLinks.testRunId;
    case 'test_runs_case':
      return entityLinks.testRunsCaseId;
    case 'failure_cluster':
      return entityLinks.failureClusterId;
    case 'bug_report':
      return entityLinks.bugReportId;
    default:
      return entityLinks.testCaseId;
  }
}

/** The `entity_links` insert field name for the given entity type. */
function fkFieldFor(entityType: LinkEntityType, entityId: number): Record<string, number> {
  switch (entityType) {
    case 'test_run':
      return { testRunId: entityId };
    case 'test_runs_case':
      return { testRunsCaseId: entityId };
    case 'failure_cluster':
      return { failureClusterId: entityId };
    case 'bug_report':
      return { bugReportId: entityId };
    default:
      return { testCaseId: entityId };
  }
}

export async function listLinks(db: DrizzleDB, entityType: LinkEntityType, entityId: number) {
  const links = await db
    .select()
    .from(entityLinks)
    .where(eq(fkColumnFor(entityType), entityId));
  return { links };
}

/**
 * Pin a URL to an entity. On a failure cluster, a keyed URL clears the key's dismissal, and a link from the tests
 * with the same key becomes the pinned link instead of a second row.
 */
export async function createLink(
  db: DrizzleDB,
  data: {
    entityType: LinkEntityType;
    entityId: number;
    url: string;
    title?: string | null;
  },
  resolver?: LinkConnectionResolver,
) {
  const { entityType, entityId, url, title } = data;

  let exists = false;
  if (entityType === 'test_run') {
    const row = await db.select({ id: testRuns.id }).from(testRuns).where(eq(testRuns.id, entityId));
    exists = row.length > 0;
  } else if (entityType === 'test_runs_case') {
    const row = await db.select({ id: testRunsCases.id }).from(testRunsCases).where(eq(testRunsCases.id, entityId));
    exists = row.length > 0;
  } else if (entityType === 'failure_cluster') {
    const row = await db
      .select({ id: failureClusters.id })
      .from(failureClusters)
      .where(eq(failureClusters.id, entityId));
    exists = row.length > 0;
  } else if (entityType === 'bug_report') {
    const row = await db.select({ id: bugReports.id }).from(bugReports).where(eq(bugReports.id, entityId));
    exists = row.length > 0;
  } else {
    const row = await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.id, entityId));
    exists = row.length > 0;
  }
  if (!exists) throw new Error('Entity not found');

  const { provider, key, connectionId, externalId } = await resolveUrl(url, resolver);

  if (entityType === 'failure_cluster' && key) {
    // Pinning an issue by hand clears its dismissal, and takes over the cluster's link from the tests to it.
    await db
      .delete(entityLinkDismissals)
      .where(and(eq(entityLinkDismissals.failureClusterId, entityId), eq(entityLinkDismissals.key, key)));
    const [declared] = await db
      .select()
      .from(entityLinks)
      .where(
        and(
          eq(entityLinks.failureClusterId, entityId),
          eq(entityLinks.key, key),
          inArray(entityLinks.origin, [...DECLARED_LINK_ORIGINS]),
        ),
      )
      .limit(1);
    if (declared) {
      const [pinned] = await db
        .update(entityLinks)
        .set({
          url,
          provider,
          connectionId: connectionId ?? declared.connectionId,
          externalId: declared.externalId ?? externalId,
          origin: 'pinned',
          ...(title ? { title } : {}),
        })
        .where(eq(entityLinks.id, declared.id))
        .returning();
      return { success: true, link: pinned ?? null };
    }
  }

  const result = await db
    .insert(entityLinks)
    .values({
      ...fkFieldFor(entityType, entityId),
      url,
      provider,
      key,
      connectionId,
      externalId,
      title: title ?? null,
    })
    .returning();
  return { success: true, link: result[0] ?? null };
}

/** A removed link, as {@link recordLinkDismissals} reads it. */
interface RemovedLink {
  failureClusterId: number | null;
  key: string | null;
  externalId: string | null;
  origin: string;
}

/**
 * Record that a person removed a cluster's keyed links, so the step that links the issues a cluster's tests name
 * does not add them back. A link from the tests or a created one keeps the tracker's issue id, and its dismissal holds
 * after the issue moves to another key; a pinned link's dismissal keeps its key only.
 */
async function recordLinkDismissals(db: DrizzleDB, removed: RemovedLink[], removedBy: number | null): Promise<void> {
  for (const link of removed) {
    if (link.failureClusterId == null || !link.key) continue;
    const keepsId = isDeclaredLink(link) || link.origin === 'created';
    await db
      .insert(entityLinkDismissals)
      .values({
        failureClusterId: link.failureClusterId,
        key: link.key,
        externalId: keepsId ? link.externalId : null,
        removedBy,
      })
      .onConflictDoNothing();
  }
}

/**
 * Remove a link by id. A keyed link on a failure cluster is recorded as dismissed, by `removedBy` when known, in the
 * same transaction as the delete.
 */
export async function deleteLink(db: DrizzleDB, id: number, removedBy: number | null = null) {
  const existing = await db.select().from(entityLinks).where(eq(entityLinks.id, id));
  if (!existing[0]) throw new Error('Link not found');
  await db.transaction(async (tx) => {
    await tx.delete(entityLinks).where(eq(entityLinks.id, id));
    await recordLinkDismissals(tx, existing, removedBy);
  });
  return { success: true };
}

/**
 * Remove every link of an entity to a URL, in one statement. Surrounding spaces
 * are ignored on both sides: a link may have been stored with them. A keyed link
 * on a failure cluster is recorded as dismissed in the same transaction, as
 * `deleteLink` records it. Returns how many links were removed.
 */
export async function deleteLinksTo(
  db: DrizzleDB,
  entityType: LinkEntityType,
  entityId: number,
  url: string,
  removedBy: number | null = null,
): Promise<number> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(entityLinks)
      .where(and(eq(fkColumnFor(entityType), entityId), eq(sql`trim(${entityLinks.url})`, url.trim())))
      .returning({
        id: entityLinks.id,
        failureClusterId: entityLinks.failureClusterId,
        key: entityLinks.key,
        externalId: entityLinks.externalId,
        origin: entityLinks.origin,
      });
    await recordLinkDismissals(tx, removed, removedBy);
    return removed.length;
  });
}
