import { getProjectScope, requireProjectAccess, resolveLinkEntityProjectId } from '../../utils/project-access';
import { getDatabase } from '../../database';
import { createLinkSchema } from '#shared/handlers/links';
import { createEnrichedLink } from '../../utils/integrations/link-create';

defineRouteMeta({
  openAPI: {
    tags: ['Links'],
    summary: 'Create an entity link',
    description:
      'Attach an external URL to a run, test-case run, test case, or failure cluster. Provider is auto-detected from the URL.',
    'x-required-permission': 'link:write',
  },
});

export default eventHandler(async (event) => {
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

  const projectId = await resolveLinkEntityProjectId(db, entityType, entityId);
  if (!projectId) throw apiError({ statusCode: 404, message: 'Entity not found' });
  const user = await requireProjectAccess(event, projectId);
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
