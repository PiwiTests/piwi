import { fnv1a32 } from '@piwitests/core/hash';

/**
 * The version the dashboard adds to a profile picture's address (`v`), from the
 * picture's URL: two accounts never share one, so the browser's cached picture
 * of one account is never shown for another.
 */
export function profilePictureVersion(avatarUrl: string): string {
  return Number.parseInt(fnv1a32(avatarUrl), 16).toString(36);
}

/**
 * The version of a picture the user uploaded: its file name, random and never
 * used twice, so no other picture ever has it.
 */
export function uploadedPictureVersion(avatarKey: string): string {
  return avatarKey.slice(avatarKey.lastIndexOf('/') + 1).replace(/\.webp$/, '');
}

/**
 * The version of the picture an account shows: its uploaded picture's, else its
 * sign-in provider's; null when it has neither.
 */
export function accountPictureVersion(user: { avatarKey: string | null; avatarUrl: string | null }): string | null {
  if (user.avatarKey) return uploadedPictureVersion(user.avatarKey);
  return user.avatarUrl ? profilePictureVersion(user.avatarUrl) : null;
}
