import { getProjectScope, requireResolvedProjectAccess, resolveLinkProjectId } from '../../../utils/project-access';
import { entityLinks } from '../../../database/schema';
import { eq } from 'drizzle-orm';
import { refreshLinkMeta } from '#shared/handlers/links';
import { detectProviderWithConnections } from '../../../utils/integrations/link-resolve';
import { unfurlLink } from '../../../utils/integrations/link-unfurl';

defineRouteMeta({
  openAPI: {
    tags: ['Links'],
    summary: 'Refresh entity link enrichment',
    description: 'Re-run provider detection, key extraction, and unfurl (fetch title) for a link.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'link:write',
  },
});

export default eventHandler(async (event) => {
  const id = parseInt(getRouterParam(event, 'id') || '0');
  if (!id) {
    throw apiError({ statusCode: 400, message: 'Invalid link ID' });
  }

  const { db, user } = await requireResolvedProjectAccess(event, id, resolveLinkProjectId, 'Link');

  let result: { link: any };
  try {
    result = await refreshLinkMeta(db, id, (u) => detectProviderWithConnections(db, u));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to refresh link';
    const statusCode = message === 'Link not found' ? 404 : 400;
    throw apiError({ statusCode, message });
  }

  const link = result.link;
  if (!link) {
    throw apiError({ statusCode: 500, message: 'Failed to refresh link' });
  }

  // Unfurl enrichment (server-only) — through the connection when one matched,
  // otherwise the rich provider / OpenGraph path.
  const readable = await getProjectScope(db, user, 'project:read');
  const { title, statusText, statusColor } = await unfurlLink(db, link, readable);

  await db
    .update(entityLinks)
    .set({
      title: title ?? link.title,
      statusText: statusText ?? link.statusText,
      statusColor: statusColor ?? link.statusColor,
      unfurledAt: title || statusText ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(entityLinks.id, id));

  const updated = await db.select().from(entityLinks).where(eq(entityLinks.id, id));
  return { link: updated[0] };
});
