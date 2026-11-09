import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { getUserProjectRoles } from '#shared/handlers/project-access';
import { requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: "Get a user's project roles",
    description:
      "Returns the user's own role bindings: `allProjects`, the project role held on every project, current and future (null for none), and `projects`, the roles held on one project each. `groups` lists the groups the user belongs to, whose bindings add to these (see `GET /api/project-access`). An administrator opens every project whatever this says.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'users:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);

  const id = requireRouteId(event, 'id', 'user ID');

  const roles = await getUserProjectRoles(await getDatabase(), id);
  if (!roles) throw apiError({ statusCode: 404, message: 'User not found' });
  return roles;
});
