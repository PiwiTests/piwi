import { eq } from 'drizzle-orm';
import { createLink, type LinkEntityType } from '#shared/handlers/links';
import { entityLinks, type EntityLink } from '../../database/schema';
import type { DbClient } from '../../database';
import { resolveLinkEntityProjectId, type ProjectScope } from '../project-access';
import { boundConnectionId } from './bound-connection';
import { detectProviderWithConnection } from './link-resolve';
import { unfurlLink } from './link-unfurl';
import { mergeEntityLinkMetadata } from './entity-links';

/**
 * Attach an external URL to an entity, matching it against the connection the
 * entity's project is bound to, then enrich it (title, status) on a best-effort
 * basis. A URL on any other site, another connection's included, stays a plain
 * link. Throws when the entity does not exist. The REST route and the MCP tool
 * both call it.
 *
 * A tracker issue's status category is recorded as the link is made, as for an
 * issue Piwi files, so the status pull counts the issue's first move (to Done,
 * or out of it) and its policies act on it. `readable` is the projects the
 * caller can read, for the unfurl (`unfurlLink`).
 */
export async function createEnrichedLink(
  db: DbClient,
  input: { entityType: LinkEntityType; entityId: number; url: string; title?: string | null },
  readable: ProjectScope,
): Promise<EntityLink | null> {
  const projectId = await resolveLinkEntityProjectId(db, input.entityType, input.entityId);
  const projectConnectionId = await boundConnectionId(db, projectId);
  const { link } = await createLink(db, input, (u) => detectProviderWithConnection(db, u, projectConnectionId));
  if (!link) return null;

  // Through the project's connection when the link matched it, otherwise the
  // rich provider / OpenGraph path.
  const { title, statusText, statusColor, statusCategory, assignee } = await unfurlLink(
    db,
    link,
    readable,
    projectConnectionId,
  );
  if (statusCategory) await mergeEntityLinkMetadata(db, link.id, { statusCategory, assignee: assignee ?? null });
  if (!title && !statusText) return link;
  await db
    .update(entityLinks)
    .set({
      title: title ?? link.title,
      statusText: statusText ?? null,
      statusColor: statusColor ?? null,
      unfurledAt: new Date(),
    })
    .where(eq(entityLinks.id, link.id));
  const [updated] = await db.select().from(entityLinks).where(eq(entityLinks.id, link.id));
  return updated ?? link;
}
