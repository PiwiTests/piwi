import { eq } from 'drizzle-orm';
import { getDatabase } from '../../../../database';
import { runTargets } from '../../../../database/schema';
import { publishToRunTarget } from '../../../../utils/run-target-events';
import { deleteUserApiKeyRecord } from '#shared/handlers/users';
import { getRequestAccess, requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Delete an API key',
    description:
      'Revokes an API key by ID. Anyone but an administrator can only revoke their own keys. Revoking the key of a connected app (Connected apps) disconnects it: its stream closes at once and its next request answers 401.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'keyId', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const currentUser = await requireAuth(event);

  const targetId = requireRouteId(event, 'id', 'user ID');
  const keyId = requireRouteId(event, 'keyId', 'key ID');

  // Non-administrators can only revoke their own keys
  if (!can(await getRequestAccess(event), 'users:manage') && currentUser.id !== targetId) {
    throw apiError({ statusCode: 403, message: 'Insufficient permissions' });
  }

  try {
    const db = await getDatabase();
    const [target] = await db.select({ id: runTargets.id }).from(runTargets).where(eq(runTargets.apiKeyId, keyId));
    const deleted = await deleteUserApiKeyRecord(db, targetId, keyId);
    // A connected app's stream closes as its key goes.
    if (target) publishToRunTarget(target.id, { type: 'revoked' });
    return deleted;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete API key';
    const statusCode = message === 'API key not found' ? 404 : 400;
    throw apiError({ statusCode, message });
  }
});
