import { getDatabase } from '../../../database';
import { requireAuth } from '../../../utils/auth';
import { removeProfilePicture } from '../../../utils/profile-picture';
import { requireRouteId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Users'],
    summary: "Remove a user's profile picture",
    description:
      "Deletes the profile picture a user uploaded; their sign-in provider's picture, if any, shows again. Answers `{ removed }`, false when there was none; 404 for an unknown user.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'users:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event, 'id', 'user ID');
  return { removed: await removeProfilePicture(await getDatabase(), id) };
});
