import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { requireStarrableProject } from '../../../utils/project-star-route';
import { starProject } from '#shared/handlers/project-stars';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Star a project',
    description:
      "Stars the project for the caller, in every browser, and returns `{ starred: true }`: it leads their sidebar and Home's Project health. Starring it again changes nothing. A star changes order only, never access. 404 for a project that does not exist; 409 with authentication off, when the dashboard keeps the stars in the browser.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  const user = await requireProjectAccess(event, projectId);
  const db = await requireStarrableProject(event, projectId);
  await starProject(db, user.id, projectId);
  return { starred: true };
});
