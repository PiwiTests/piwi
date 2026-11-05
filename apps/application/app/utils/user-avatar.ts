/** Where the dashboard loads the signed-in user's profile picture: the instance's own route, never the sign-in provider's image host. `version` is `avatarVersion` of `GET /api/auth/me`. */
export function profilePictureSrc(baseURL: string, version: string): string {
  return `${baseURL.replace(/\/$/, '')}/api/auth/avatar?v=${encodeURIComponent(version)}`;
}

/**
 * The picture an account's avatar shows: the signed-in account's own, when it
 * has one; the instance serves no other. `avatarVersion` is for a page showing
 * the account `GET /api/auth/me` answered, the one the picture route serves:
 * its version wins over the auth state, whose account id it needs no check
 * against.
 */
export function accountPictureSrc(
  baseURL: string,
  signedIn: { id: number; avatarVersion?: string | null } | null | undefined,
  accountId: number,
  avatarVersion?: string | null,
): string | undefined {
  const version =
    avatarVersion !== undefined ? avatarVersion : signedIn?.id === accountId ? signedIn.avatarVersion : null;
  return version ? profilePictureSrc(baseURL, version) : undefined;
}
