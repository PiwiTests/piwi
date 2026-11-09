import { getDatabase } from '../../../../database';
import { requireAuth } from '../../../../utils/auth';
import { clearWebhookToken, getConnectionRow } from '../../../../utils/integrations/connections';
import { requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Disable the inbound webhook',
    description:
      'Clear the connection webhook secret, turning the inbound webhook off. Requires `connections:manage` (administrators only).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'connections:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event, 'id', 'connection ID');

  const db = await getDatabase();
  const row = await getConnectionRow(db, id);
  if (!row) throw apiError({ statusCode: 404, message: 'Connection not found' });

  await clearWebhookToken(db, id);
  return { success: true };
});
