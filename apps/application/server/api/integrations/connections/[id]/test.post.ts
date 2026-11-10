import { getDatabase } from '../../../../database';
import { requireAuth } from '../../../../utils/auth';
import { connectionPausedUntil } from '../../../../utils/integrations/actions';
import { testConnection } from '../../../../utils/integrations/connections';
import { requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Test an integration connection',
    description:
      'Verifies the connection with its provider’s own sign-in (Jira `whoAmI`; Zephyr Scale reads one project from its region’s host) and records the outcome. Soft-fail: a reachable provider that rejects the credentials returns HTTP 200 with `{ ok: false, error }`, and so does a connection the provider rate limited, which is not called until its pause ends.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'connections:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event, 'id', 'connection ID');

  const db = await getDatabase();
  const paused = connectionPausedUntil(id, new Date());
  if (paused)
    return { ok: false, error: `Paused until ${paused.toISOString()}: the provider rate limited this connection` };
  const result = await testConnection(db, id);
  if (!result) throw apiError({ statusCode: 404, message: 'Connection not found' });
  return result;
});
