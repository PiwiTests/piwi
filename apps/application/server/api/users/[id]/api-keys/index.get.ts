import { getDatabase } from '../../../../database';
import { listUserApiKeys } from '#shared/handlers/users';
import { getRequestAccess, requireAuth } from '../../../../utils/auth';
import { can } from '#shared/permissions';
import { requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'List API keys for a user',
    description:
      'Returns API keys belonging to a specific user. Anyone but an administrator can only list their own keys.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const currentUser = await requireAuth(event);

  const targetId = requireRouteId(event, 'id', 'user ID');

  // Non-administrators can only list their own keys
  if (!can(await getRequestAccess(event), 'users:manage') && currentUser.id !== targetId) {
    throw apiError({ statusCode: 403, message: 'Insufficient permissions' });
  }

  return { items: (await listUserApiKeys(await getDatabase(), targetId)).apiKeys };
});
