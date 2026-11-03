import { getDatabase } from '../../../../database';
import { requireAuth } from '../../../../utils/auth';
import { testConnection } from '../../../../utils/integrations/connections';
import { requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Test an integration connection',
    description:
      'Verifies the connection by resolving the authenticated account (Jira `whoAmI`) and records the outcome. Soft-fail: a reachable provider that rejects the credentials returns HTTP 200 with `{ ok: false, error }`.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'connections:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event, 'id', 'connection ID');

  const db = await getDatabase();
  const result = await testConnection(db, id);
  if (!result) throw apiError({ statusCode: 404, message: 'Connection not found' });
  return result;
});
