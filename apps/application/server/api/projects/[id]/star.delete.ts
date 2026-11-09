import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { requireStarrableProject } from '../../../utils/project-star-route';
import { unstarProject } from '#shared/handlers/project-stars';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Unstar a project',
    description:
      "Removes the caller's star from the project and returns `{ starred: false }`. Unstarring a project that has no star changes nothing. 404 for a project that does not exist; 409 with authentication off, when the dashboard keeps the stars in the browser.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  const user = await requireProjectAccess(event, projectId);
  const db = await requireStarrableProject(event, projectId);
  await unstarProject(db, user.id, projectId);
  return { starred: false };
});
