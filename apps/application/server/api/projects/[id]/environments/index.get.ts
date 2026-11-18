import { can } from '#shared/permissions';
import { listProjectEnvironments } from '#shared/handlers/environments';
import { getDatabase } from '../../../../database';
import { getRequestAccess } from '../../../../utils/auth';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: "List a project's environments",
    description:
      'The project’s environments in their order, `{ environments: [{ id, key, name, description, aliases, runVariables, appFromCheckout, protected, requiredTags, envFile, position, discovered, archived }] }`: the deployments its tests run against. A run’s label resolves to one by its key or an alias, ignoring case, and a label nothing takes creates a `discovered` one. `runVariables` are set over the project’s on the runs Piwi starts for the environment; a protected environment’s are listed only to the project’s managers. Every picker of the dashboard reads this list.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const canManage = can(await getRequestAccess(event), 'project:manage', id);
  return { environments: await listProjectEnvironments(await getDatabase(), id, { canManage }) };
});
