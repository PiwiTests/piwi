/**
 * Entity-link writes the integration layer owns: recording the link Piwi creates
 * when it files an issue, and refreshing a link's status fields when the sync
 * task reads the tracker back. Kept apart from `shared/handlers/links.ts` (which
 * serves the user-pinned link CRUD) because these rows carry a `connection_id`
 * and an `origin` a person never sets by hand.
 */
import { and, eq, or } from 'drizzle-orm';
import { entityLinks } from '../../database/schema';
import type { DbClient } from '../../database';
import type { LinkEntityType } from '#shared/handlers/links';

/** The `entity_links` insert field for the given entity type. */
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

/** The `entity_links` column holding the given entity type's id. */
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

/**
 * Whether an issue Piwi filed still tracks its entity: its link is still there
 * (a person can remove it) and the issue is not Done (a closed issue on a
 * failure that goes on calls for a new one). Otherwise the filing no longer
 * answers a new create. A filing whose result names neither key nor URL cannot
 * be checked and counts as tracking.
 */
export async function filedIssueStillTracks(
  db: DbClient,
  entityType: LinkEntityType,
  entityId: number,
  issue: { key?: string | null; url?: string | null } | null,
): Promise<boolean> {
  const matches = [
    issue?.key ? eq(entityLinks.key, issue.key) : undefined,
    issue?.url ? eq(entityLinks.url, issue.url) : undefined,
  ].filter((m) => m !== undefined);
  if (matches.length === 0) return true;
  const [row] = await db
    .select({ metadata: entityLinks.metadata })
    .from(entityLinks)
    .where(and(eq(fkColumnFor(entityType), entityId), or(...matches)))
    .limit(1);
  if (!row) return false;
  return (row.metadata as { statusCategory?: string | null } | null)?.statusCategory !== 'done';
}

export interface CreatedIssueLink {
  provider: string;
  url: string;
  key: string | null;
  externalId: string | null;
  title: string | null;
  statusText: string | null;
  statusColor: string | null;
  /** The tracker's status category at creation, so the first sync can tell a move from it. */
  statusCategory?: string | null;
}

/** The metadata a created link starts with: the status category at creation and the caller's bookkeeping. */
function createdLinkMetadata(
  statusCategory: string | null | undefined,
  extra: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const metadata = { ...(statusCategory ? { statusCategory } : {}), ...(extra ?? {}) };
  return Object.keys(metadata).length ? metadata : null;
}

/**
 * Record the link to an issue Piwi just created. `origin: 'created'` distinguishes
 * it from a link a person pinned, so the sync task knows it can write back through
 * the connection. Runs inside the caller's transaction so the row and the action
 * result commit together.
 */
export async function writeCreatedIssueLink(
  db: DbClient,
  input: {
    entityType: LinkEntityType;
    entityId: number;
    connectionId: number;
    createdBy: number | null;
    issue: CreatedIssueLink;
    /** Bookkeeping kept on the link from the start, such as what Piwi wrote. */
    metadata?: Record<string, unknown> | null;
  },
): Promise<{ id: number } | null> {
  const [row] = await db
    .insert(entityLinks)
    .values({
      ...fkFieldFor(input.entityType, input.entityId),
      url: input.issue.url,
      provider: input.issue.provider,
      key: input.issue.key,
      title: input.issue.title,
      statusText: input.issue.statusText,
      statusColor: input.issue.statusColor,
      connectionId: input.connectionId,
      externalId: input.issue.externalId,
      origin: 'created',
      createdBy: input.createdBy,
      metadata: createdLinkMetadata(input.issue.statusCategory, input.metadata) as never,
      unfurledAt: new Date(),
    })
    .returning({ id: entityLinks.id });
  return row ?? null;
}

/**
 * Merge a patch into a link's `metadata` JSON, preserving the keys it already
 * carries. The sync task and the still-failing policy keep their bookkeeping
 * (the tracker's status category and assignee, the last-commented occurrence
 * count) here.
 */
export async function mergeEntityLinkMetadata(db: DbClient, id: number, patch: Record<string, unknown>): Promise<void> {
  const [row] = await db.select({ metadata: entityLinks.metadata }).from(entityLinks).where(eq(entityLinks.id, id));
  const current = (row?.metadata as Record<string, unknown> | null) ?? {};
  await db
    .update(entityLinks)
    .set({ metadata: { ...current, ...patch } as never, updatedAt: new Date() })
    .where(eq(entityLinks.id, id));
}

/**
 * Refresh an entity link's cached status fields — what the status pull
 * (`sync.ts`) calls after reading the tracker back through the connection.
 */
export async function updateEntityLinkStatus(
  db: DbClient,
  id: number,
  fields: {
    title?: string | null;
    statusText?: string | null;
    statusColor?: string | null;
    key?: string | null;
    externalId?: string | null;
  },
): Promise<void> {
  await db
    .update(entityLinks)
    .set({ ...fields, unfurledAt: new Date(), updatedAt: new Date() })
    .where(eq(entityLinks.id, id));
}
