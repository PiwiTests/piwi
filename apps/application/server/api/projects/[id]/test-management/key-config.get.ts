import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { testManagementKeyConfig } from '#shared/handlers/test-management-summary';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Read how a project reads test case keys',
    description:
      "Reduces the project's test management binding to what a page needs to show the test case behind a key on hover: `projectKey`, the key `pattern` (the project's own, or the default for its test management project) and `keySources` (`tags`, `externalId`). Reads the database only; no connection details are returned. `{ bound: false }` for a project with no binding. Requires `project:read`.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);
  const db = await getDatabase();
  return await testManagementKeyConfig(db, id);
});
