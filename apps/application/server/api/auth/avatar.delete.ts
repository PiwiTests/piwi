import { apiError } from '../../utils/api-error';
import { getDatabase } from '../../database';
import { isAuthEnabled, requireSessionAuth } from '../../utils/auth';
import { removeProfilePicture } from '../../utils/profile-picture';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Remove your profile picture',
    description:
      "Deletes the profile picture the signed-in user uploaded, so the sign-in provider's picture, if any, shows again. Answers `{ removed }`, false when there was none. Refused with authentication off (400) and for an API key (403).",
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireSessionAuth(event);
  if (!isAuthEnabled(event)) {
    throw apiError({ statusCode: 400, message: 'Profile pictures need authentication turned on' });
  }
  return { removed: await removeProfilePicture(await getDatabase(), user.id) };
});
