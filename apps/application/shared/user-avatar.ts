/**
 * The version the dashboard adds to a profile picture's address (`v`), from the
 * picture's URL: two accounts never share one, so the browser's cached picture
 * of one account is never shown for another.
 */
export function profilePictureVersion(avatarUrl: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < avatarUrl.length; i++) {
    hash ^= avatarUrl.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
