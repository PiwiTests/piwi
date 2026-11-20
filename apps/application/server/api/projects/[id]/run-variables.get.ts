import { parseRouteId } from '#shared/route-id';
import { can } from '#shared/permissions';
import { environmentRunSettings } from '#shared/handlers/environments';
import { getDatabase } from '../../../database';
import { getRequestAccess } from '../../../utils/auth';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: "Get a project's run variables",
    description:
      'The run variables a run Piwi starts for the project gets, `{ runVariables: [{ name, value }], environment }` (an empty list for none), and every command it gives to copy starts with. With `?environment=<id>`, the project’s and that environment’s merged, the environment’s value taking a name both set, and `environment` as `{ id, key, name, protected, requiredTags, envFile }`: the program sets `PIWI_ENVIRONMENT` to its key and limits a protected environment’s run to its required tags. Without it, the project’s alone and `environment: null`. They are plain values, never secrets. A program that applies them checks each one again with the rules of `PATCH /api/projects/:id`, and runs nothing when one fails.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'environment', in: 'query', required: false, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'project:read',
    responses: {
      200: { description: 'The run variables, and the environment' },
      403: { description: 'No access, or the environment is protected and the caller does not manage the project' },
      404: { description: 'No such project, or no such environment of it (an archived one included)' },
      409: { description: 'The merged list or the environment no longer pass the rules' },
    },
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const raw = getQuery(event).environment;
  let environmentId: number | null = null;
  if (raw !== undefined && raw !== '') {
    environmentId = parseRouteId(String(raw));
    if (environmentId === null) throw apiError({ statusCode: 400, message: 'Invalid environment ID' });
  }
  const canManage = can(await getRequestAccess(event), 'project:manage', id);
  const settings = await environmentRunSettings(await getDatabase(), id, environmentId, { canManage });
  if (!settings.ok) throw apiError({ statusCode: settings.statusCode, message: settings.message });
  return { runVariables: settings.runVariables, environment: settings.environment };
});
