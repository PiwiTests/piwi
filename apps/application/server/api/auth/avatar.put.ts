import { apiError } from '../../utils/api-error';
import { getRequestWebStream } from 'h3';
import { getDatabase } from '../../database';
import { isAuthEnabled, requireSessionAuth } from '../../utils/auth';
import { readStreamWithin } from '../../utils/body-limit';
import { saveProfilePicture } from '../../utils/profile-picture';
import { PROFILE_PICTURE_MAX_BYTES, PROFILE_PICTURE_TOO_HEAVY } from '#shared/profile-picture';
import { uploadedPictureVersion } from '#shared/user-avatar';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Upload your profile picture',
    description:
      "Sets the signed-in user's profile picture from the request body: the image's bytes, PNG, JPEG or WebP, under 1 MB and at most 1000 × 1000 pixels (the format is read from the bytes, never from `Content-Type`). The server re-encodes it as a 256 × 256 WebP with no metadata and serves it in place of the sign-in provider's picture. Answers `{ avatarVersion }`, the `v` of the new picture's address. 400 for another format or larger dimensions, 413 over 1 MB, 409 when other uploads kept replacing the picture meanwhile, 503 when the server cannot decode images; refused with authentication off (400) and for an API key (403).",
    requestBody: {
      required: true,
      content: {
        'image/png': { schema: { type: 'string', format: 'binary' } },
        'image/jpeg': { schema: { type: 'string', format: 'binary' } },
        'image/webp': { schema: { type: 'string', format: 'binary' } },
      },
    },
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireSessionAuth(event);
  if (!isAuthEnabled(event)) {
    throw apiError({ statusCode: 400, message: 'Profile pictures need authentication turned on' });
  }
  const bytes = await readStreamWithin(getRequestWebStream(event), PROFILE_PICTURE_MAX_BYTES);
  if (!bytes) throw apiError({ statusCode: 413, message: PROFILE_PICTURE_TOO_HEAVY });

  const key = await saveProfilePicture(await getDatabase(), user.id, Buffer.from(bytes));
  return { avatarVersion: uploadedPictureVersion(key) };
});
