import { getDatabase } from '../../../database';
import { readProjectRunVariables } from '#shared/handlers/run-variables';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: "Get a project's run variables",
    description:
      'The project’s run variables, `{ runVariables: [{ name, value }] }` (an empty list for none): the environment variables every run Piwi starts for the project gets, and every command it gives to copy starts with. They are plain values, never secrets. A program that applies them checks each one again with the rules of `PATCH /api/projects/:id`, and runs nothing when one fails.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const runVariables = await readProjectRunVariables(await getDatabase(), id);
  if (!runVariables) throw apiError({ statusCode: 404, message: 'Project not found' });
  return { runVariables };
});
