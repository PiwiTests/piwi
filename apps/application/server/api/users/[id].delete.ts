import { getDatabase } from '../../database';
import { accessRefusal, deleteUserAccount } from '#shared/handlers/project-access';
import { requireAuth, isAuthEnabled } from '../../utils/auth';
import { requireRouteId } from '../../utils/project-access';
import { deleteUserProfilePictures } from '../../utils/profile-picture';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: 'Delete a user',
    description:
      'Deletes a user by ID, with their API keys, role bindings, group memberships and uploaded profile picture, and revokes the share links they created. Refuses deleting your own account and the last administrator (400).',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'users:manage',
  },
});

export default eventHandler(async (event) => {
  const currentUser = await requireAuth(event);

  const id = requireRouteId(event, 'id', 'user ID');

  try {
    // The lockout guards are only meaningful when authentication is enabled.
    const result = await deleteUserAccount(await getDatabase(), id, currentUser.id, { guard: isAuthEnabled(event) });
    await deleteUserProfilePictures(id);
    return result;
  } catch (err) {
    const refusal = accessRefusal(err);
    if (refusal) throw apiError(refusal);
    throw err;
  }
});
