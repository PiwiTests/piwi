import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { deleteConnection, getConnectionRow } from '../../../utils/integrations/connections';
import { requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Delete an integration connection',
    description:
      'Deletes a connection. Linked records keep their URL and have their connection cleared. Environment-managed connections are read-only.',
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
  if (row.managedBy === 'env') {
    throw apiError({
      statusCode: 403,
      message: 'This connection is managed through environment variables and cannot be deleted here.',
    });
  }

  await deleteConnection(db, id);
  return { success: true };
});
