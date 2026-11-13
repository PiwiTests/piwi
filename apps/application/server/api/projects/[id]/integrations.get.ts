import { getDatabase } from '../../../database';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { readProjectIntegration } from '../../../utils/integrations/binding';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Get the project tracker binding',
    description:
      'The resolved project-integration binding — connection, Jira project key, issue type, the issue types linked from test tags, labels, default assignee, ticket language, title prefix (null inherits the default of the connection), include toggles, sync policies, owner routes and the auto-create fields. Returns the defaults when no binding is stored. Requires `project:manage` (Project admin on the project).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const db = await getDatabase();
  return await readProjectIntegration(db, id);
});
