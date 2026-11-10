import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { readTestManagementBinding } from '../../../../utils/integrations/test-management/binding';
import { listTestManagementConnections } from '../../../../utils/integrations/connections';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Get the project test management binding',
    description:
      'The resolved test management binding — connection, provider project key, enabled and dry run, key sources, run scope, run policy, status names and options — and the test management connections the project may be bound to. Returns the defaults (no connection) when no binding is stored. Requires `project:manage` (Project admin on the project).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const db = await getDatabase();
  return { binding: await readTestManagementBinding(db, id), connections: await listTestManagementConnections(db) };
});
