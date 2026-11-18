import { deleteEnvironment } from '#shared/handlers/environments';
import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: "Delete a project's environment",
    description:
      'Its runs, run requests and markers keep their label and lose their environment, and a project whose default environment it was reads every environment. A later run reporting the same label creates a discovered environment again: archive an environment to keep its label from coming back. Refused with 409 while a URL pattern or a CI action names it, since they would then apply to every environment: archive it, or move them to another environment first.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'environmentId', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'project:manage',
    responses: {
      200: { description: 'Deleted' },
      404: { description: 'No such environment of the project' },
      409: { description: 'A URL pattern or a CI action names it' },
    },
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  const environmentId = requireRouteId(event, 'environmentId', 'environment ID');
  await requireProjectAccess(event, id);
  const result = await deleteEnvironment(await getDatabase(), id, environmentId);
  if (!result.ok) throw apiError({ statusCode: result.statusCode, message: result.problems.join(' ') });
  return { deleted: true };
});
