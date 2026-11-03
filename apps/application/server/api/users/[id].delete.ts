import { getDatabase } from '../../database';
import { accessRefusal, deleteUserAccount } from '#shared/handlers/project-access';
import { requireAuth, isAuthEnabled } from '../../utils/auth';
import { requireRouteId } from '../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Delete a user',
    description:
      'Deletes a user by ID, with their API keys, role bindings and group memberships. Refuses deleting your own account and the last administrator (400).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'users:manage',
  },
});

export default eventHandler(async (event) => {
  const currentUser = await requireAuth(event);

  const id = requireRouteId(event, 'id', 'user ID');

  try {
    // The lockout guards are only meaningful when authentication is enabled.
    return await deleteUserAccount(await getDatabase(), id, currentUser.id, { guard: isAuthEnabled(event) });
  } catch (err) {
    const refusal = accessRefusal(err);
    if (refusal) throw apiError(refusal);
    throw err;
  }
});
