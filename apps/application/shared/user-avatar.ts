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

/** The text and background of one letter avatar, for one theme. */
export interface LetterAvatarTint {
  background: string;
  text: string;
}

/** One hue of the letter avatars: a pale tint on a light page, a deep one on a dark page. */
export interface LetterAvatarColor {
  hue: string;
  light: LetterAvatarTint;
  dark: LetterAvatarTint;
}

/**
 * The letter avatars' hues, from Tailwind's palette: shade 200 behind shade 800
 * on a light page, shade 800 behind shade 100 on a dark page. No hue is a test
 * outcome's or a status color's, and none is violet, the accent, or its
 * neighbors indigo and purple, so an avatar never reads as the primary action.
 */
export const LETTER_AVATAR_COLORS: readonly LetterAvatarColor[] = [
  {
    hue: 'orange',
    light: { background: '#ffd6a7', text: '#9f2d00' },
    dark: { background: '#9f2d00', text: '#ffedd4' },
  },
  {
    hue: 'lime',
    light: { background: '#d8f999', text: '#3c6300' },
    dark: { background: '#3c6300', text: '#ecfcca' },
  },
  {
    hue: 'teal',
    light: { background: '#96f7e4', text: '#005f5a' },
    dark: { background: '#005f5a', text: '#cbfbf1' },
  },
  {
    hue: 'cyan',
    light: { background: '#a2f4fd', text: '#005f78' },
    dark: { background: '#005f78', text: '#cefafe' },
  },
  {
    hue: 'sky',
    light: { background: '#b8e6fe', text: '#00598a' },
    dark: { background: '#00598a', text: '#dff2fe' },
  },
];

/**
 * An account's letter avatar color, picked from its id in turn: the same
 * account gets the same color on every screen and every visit, and five
 * consecutive ids get five different colors.
 */
export function letterAvatarColor(accountId: number): LetterAvatarColor {
  const count = LETTER_AVATAR_COLORS.length;
  const id = Number.isFinite(accountId) ? Math.trunc(accountId) : 0;
  return LETTER_AVATAR_COLORS[(((id - 1) % count) + count) % count]!;
}

/** The first letter or digit of a word: one code point, its accent composed by NFC. */
const FIRST_CHARACTER = /[\p{L}\p{N}]/u;

function initialsOf(text: string): string | null {
  const trimmed = text.trim();
  const at = trimmed.indexOf('@');
  const local = at > 0 && !/\s/.test(trimmed) ? trimmed.slice(0, at) : trimmed;
  const initials = local
    .normalize('NFC')
    .toUpperCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/[\s._+-]+/)
    .map((word) => word.match(FIRST_CHARACTER)?.[0])
    .filter((initial): initial is string => Boolean(initial));
  if (initials.length === 0) return null;
  return initials.length === 1 ? initials[0]! : initials[0]! + initials[initials.length - 1]!;
}

/**
 * The letters an account's avatar shows: the first letters of the first and
 * last words of its display name, else of its username (`Jane Doe` and
 * `jane.doe` give `JD`). A name in one word gives one letter, a part in
 * parentheses or brackets is left out, and an email address counts only
 * before its `@`. Null when neither holds a letter or a digit.
 */
export function accountInitials(account: { name: string | null; username: string }): string | null {
  return (account.name ? initialsOf(account.name) : null) ?? initialsOf(account.username);
}
