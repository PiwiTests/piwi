import { apiError } from '../../utils/api-error';
import { requireAuth } from '../../utils/auth';
import { PUBLIC_IMAGE_HEADERS } from '../../utils/public-image';
import { oauthAvatar } from '../../utils/user-avatar';
import { profilePictureVersion } from '#shared/user-avatar';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: "Get the signed-in user's profile picture",
    description:
      "The profile picture the user's Google or GitHub sign-in names, fetched by the server from the provider's image host and served from the instance, so the browser never calls a third party. 404 when the user has none or it is on another host, 502 when the host cannot answer for now. Cached for an hour when `v` is the version of the user's current picture URL, which the dashboard adds; not cached otherwise, so a browser shared by two accounts never keeps one's picture under the other's address.",
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  let image;
  try {
    image = user.avatarUrl ? await oauthAvatar(user.avatarUrl) : null;
  } catch {
    // Unavailable for now (a timeout, a rate limit, a blocked host): not remembered, so the next view asks again.
    throw apiError({ statusCode: 502, message: 'The profile picture host could not answer right now' });
  }
  if (!image) throw apiError({ statusCode: 404, message: 'No profile picture' });

  const current = getQuery(event).v === profilePictureVersion(user.avatarUrl!);
  setResponseHeaders(event, {
    'Content-Type': image.mime,
    'Cache-Control': current ? 'private, max-age=3600' : 'no-store',
    ...PUBLIC_IMAGE_HEADERS,
  });
  return Buffer.from(image.bytes);
});
