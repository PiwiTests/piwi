import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { getProjectScope, requireProjectPermission, resolveLinkEntityProjectId } from '../../utils/project-access';
import { createLinkSchema } from '#shared/handlers/links';
import { createEnrichedLink } from '../../utils/integrations/link-create';

defineRouteMeta({
  openAPI: {
    tags: ['Links'],
    summary: 'Create an entity link',
    description:
      "Attach an external URL to a run, test-case run, test case, failure cluster or bug report. Provider is auto-detected from the URL. A tracker issue on the site of the connection the entity's project is bound to is read through that connection (title, status) and kept in sync; any other URL, one on another connection's site included, is stored as a plain link that Piwi never reads or writes through a connection.",
    'x-required-permission': 'link:write',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const body = await readBody(event);
  const validation = createLinkSchema.safeParse(body);

  if (!validation.success) {
    throw apiError({
      statusCode: 400,
      message: 'Invalid request body',
      data: validation.error.issues,
    });
  }

  const { entityType, entityId, url, title } = validation.data;
  const db = await getDatabase();
  const projectId = await resolveLinkEntityProjectId(db, entityType, entityId, user.id);
  if (!projectId) throw apiError({ statusCode: 404, message: 'Entity not found' });
  await requireProjectPermission(event, projectId);
  const readable = await getProjectScope(db, user, 'project:read');

  let link: Awaited<ReturnType<typeof createEnrichedLink>>;
  try {
    link = await createEnrichedLink(db, { entityType, entityId, url, title }, readable);
  } catch (err) {
    throw apiError({
      statusCode: 404,
      message: err instanceof Error ? err.message : 'Failed to create link',
    });
  }
  if (!link) {
    throw apiError({ statusCode: 500, message: 'Failed to create link' });
  }

  return { success: true, link };
});
