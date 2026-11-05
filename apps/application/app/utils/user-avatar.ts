/** Where the dashboard loads the signed-in user's profile picture: the instance's own route, never the sign-in provider's image host. `version` is `avatarVersion` of `GET /api/auth/me`. */
export function profilePictureSrc(baseURL: string, version: string): string {
  return `${baseURL.replace(/\/$/, '')}/api/auth/avatar?v=${encodeURIComponent(version)}`;
}
