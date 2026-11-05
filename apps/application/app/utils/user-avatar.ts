/** Where the dashboard loads the signed-in user's profile picture: the instance's own route, never the sign-in provider's image host. `version` is `avatarVersion` of `GET /api/auth/me`. */
export function profilePictureSrc(baseURL: string, version: string): string {
  return `${baseURL.replace(/\/$/, '')}/api/auth/avatar?v=${encodeURIComponent(version)}`;
}

/** The picture an account's avatar shows: the signed-in account's own, when it has one; the instance serves no other. */
export function accountPictureSrc(
  baseURL: string,
  signedIn: { id: number; avatarVersion?: string | null } | null | undefined,
  accountId: number,
): string | undefined {
  if (!signedIn?.avatarVersion || signedIn.id !== accountId) return undefined;
  return profilePictureSrc(baseURL, signedIn.avatarVersion);
}
