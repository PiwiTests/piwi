import { apiError } from '../../utils/api-error';
import { requireAuth } from '../../utils/auth';
import { PUBLIC_IMAGE_HEADERS, type PublicImage } from '../../utils/public-image';
import { readStoredProfilePicture } from '../../utils/profile-picture';
import { oauthAvatar } from '../../utils/user-avatar';
import { accountPictureVersion } from '#shared/user-avatar';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: "Get the signed-in user's profile picture",
    description:
      "The picture the user uploaded, else the one their Google or GitHub sign-in names, fetched by the server from the provider's image host and served from the instance, so the browser never calls a third party. 404 when the user has none or the provider's is on another host, 502 when that host cannot answer for now. Cached when `v` is the version of the user's current picture (`avatarVersion` of `GET /api/auth/me`), which the dashboard adds: for a year for an uploaded picture, whose version changes with its bytes, and for an hour for a provider's. Not cached otherwise, so a browser shared by two accounts never keeps one's picture under the other's address.",
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  let image: PublicImage | null;
  try {
    if (user.avatarKey) image = await readStoredProfilePicture(user.avatarKey);
    else image = user.avatarUrl ? await oauthAvatar(user.avatarUrl) : null;
  } catch {
    // Unavailable for now (a timeout, a rate limit, a blocked host): not remembered, so the next view asks again.
    throw apiError({ statusCode: 502, message: 'The profile picture could not be read right now' });
  }
  if (!image) throw apiError({ statusCode: 404, message: 'No profile picture' });

  const current = getQuery(event).v === accountPictureVersion(user);
  const maxAge = user.avatarKey ? 'private, max-age=31536000, immutable' : 'private, max-age=3600';
  setResponseHeaders(event, {
    'Content-Type': image.mime,
    'Cache-Control': current ? maxAge : 'no-store',
    ...PUBLIC_IMAGE_HEADERS,
  });
  return Buffer.from(image.bytes);
});
