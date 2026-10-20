import {
  entityLinks,
  testRuns,
  testRunsCases,
  testCases,
  failureClusters,
  bugReports,
} from '../../server/database/schema';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { safeHttpUrl } from '../utils/safe-url';
import { detectProvider, extractKey, type LinkProvider } from '../link-detect';

import type { DrizzleDB } from './db';

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

export async function deleteLink(db: DrizzleDB, id: number) {
  const existing = await db.select().from(entityLinks).where(eq(entityLinks.id, id));
  if (!existing[0]) throw new Error('Link not found');
  await db.delete(entityLinks).where(eq(entityLinks.id, id));
  return { success: true };
}

/**
 * Remove every link of an entity to a URL, in one statement. Surrounding spaces
 * are ignored on both sides: a link may have been stored with them. Returns how
 * many links were removed.
 */
export async function deleteLinksTo(
  db: DrizzleDB,
  entityType: LinkEntityType,
  entityId: number,
  url: string,
): Promise<number> {
  const removed = await db
    .delete(entityLinks)
    .where(and(eq(fkColumnFor(entityType), entityId), eq(sql`trim(${entityLinks.url})`, url.trim())))
    .returning({ id: entityLinks.id });
  return removed.length;
}
