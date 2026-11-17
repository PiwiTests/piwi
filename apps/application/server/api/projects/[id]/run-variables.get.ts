import { getDatabase } from '../../../database';
import { getProjectRunVariables } from '#shared/handlers/projects';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: "Get a project's run variables",
    description:
      'The project’s run variables, `{ runVariables: [{ name, value }] }` (an empty list for none): the environment variables every run Piwi starts for the project gets, and every command it gives to copy starts with. They are plain values, never secrets. A program that applies them checks each name again with the rules of `PATCH /api/projects/:id`, and runs nothing when one fails.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  try {
    return { runVariables: await getProjectRunVariables(await getDatabase(), id) };
  } catch (e) {
    if (e instanceof Error && e.message === 'Project not found') {
      throw apiError({ statusCode: 404, message: 'Project not found' });
    }
    throw e;
  }
});
