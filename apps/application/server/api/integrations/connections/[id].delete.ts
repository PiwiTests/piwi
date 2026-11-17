import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { deleteConnection, getConnectionRow } from '../../../utils/integrations/connections';
import { requireRouteId } from '../../../utils/project-access';
import { deleteCredentialIfUnused } from '#shared/handlers/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Delete an integration connection',
    description:
      'Deletes a connection. Linked records keep their URL and have their connection cleared. Environment-managed connections are read-only. With `deleteCredential=true`, the credential the connection named is deleted too, unless something else names it or the environment sets it (`credentialDeleted` says which).',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'deleteCredential', in: 'query', required: false, schema: { type: 'boolean' } },
    ],
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
  const credentialDeleted =
    getQuery(event).deleteCredential === 'true' && row.credentialId != null
      ? await deleteCredentialIfUnused(db, row.credentialId)
      : false;
  return { success: true, credentialDeleted };
});
