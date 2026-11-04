import { fnv1a32 } from '@piwitests/core/hash';

/**
 * The version the dashboard adds to a profile picture's address (`v`), from the
 * picture's URL: two accounts never share one, so the browser's cached picture
 * of one account is never shown for another.
 */
export function profilePictureVersion(avatarUrl: string): string {
  return Number.parseInt(fnv1a32(avatarUrl), 16).toString(36);
}
