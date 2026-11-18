import { deleteEnvironment } from '#shared/handlers/environments';
import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: "Delete a project's environment",
    description:
      'Its runs keep their label and lose their environment. A later run reporting the same label creates a discovered environment again: archive an environment to keep its label from coming back.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'environmentId', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  const environmentId = requireRouteId(event, 'environmentId', 'environment ID');
  await requireProjectAccess(event, id);
  if (!(await deleteEnvironment(await getDatabase(), id, environmentId))) {
    throw apiError({ statusCode: 404, message: 'No environment of this project has this id' });
  }
  return { deleted: true };
});
