import { requireResolvedProjectAccess, requireRouteId, resolveLinkProjectId } from '../../utils/project-access';
import { deleteLink } from '#shared/handlers/links';

defineRouteMeta({
  openAPI: {
    tags: ['Links'],
    summary: 'Delete an entity link',
    description: 'Remove an entity link by ID.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'link:write',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'link ID');

  const { db } = await requireResolvedProjectAccess(event, id, resolveLinkProjectId, 'Link');

  try {
    return await deleteLink(db, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete link';
    const statusCode = message === 'Link not found' ? 404 : 400;
    throw apiError({ statusCode, message });
  }
});
