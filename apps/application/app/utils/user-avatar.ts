import { profilePictureVersion } from '#shared/user-avatar';

/** Where the dashboard loads the signed-in user's profile picture: the instance's own route, never the sign-in provider's image host. */
export function profilePictureSrc(baseURL: string, avatarUrl: string): string {
  return `${baseURL.replace(/\/$/, '')}/api/auth/avatar?v=${profilePictureVersion(avatarUrl)}`;
}
