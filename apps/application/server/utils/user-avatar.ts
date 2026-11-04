import { fetchPublicImage, type PublicImage } from './public-image';
import { TtlCache } from './ttl-cache';

/** The most bytes a profile picture may weigh. */
const MAX_AVATAR_BYTES = 512 * 1024;

/** An hour, and a missing one (null) is remembered too. */
const avatarCache = new TtlCache<PublicImage | null>(60 * 60 * 1000, 500);

/** Whether a URL is a profile picture on the host GitHub or Google serves sign-in pictures from. */
export function isOAuthAvatarUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      (parsed.host === 'avatars.githubusercontent.com' || /^lh\d+\.googleusercontent\.com$/.test(parsed.host))
    );
  } catch {
    return false;
  }
}

/** GitHub's picture at the size the menu shows it (its default is the full upload, often hundreds of kilobytes). */
function menuSize(url: string): string {
  const parsed = new URL(url);
  if (parsed.host !== 'avatars.githubusercontent.com') return url;
  parsed.searchParams.set('s', '96');
  return parsed.toString();
}

/**
 * The profile picture a sign-in provider named, fetched by the server so the
 * browser never calls the provider's image host. Null for a URL off those hosts
 * or an answer that is no image; throws when the host cannot answer for now, so
 * the miss is not remembered.
 */
export async function oauthAvatar(url: string): Promise<PublicImage | null> {
  if (!isOAuthAvatarUrl(url)) return null;
  const cached = avatarCache.get(url);
  if (cached !== undefined) return cached;
  const image = await fetchPublicImage(menuSize(url), isOAuthAvatarUrl, { maxBytes: MAX_AVATAR_BYTES });
  avatarCache.set(url, image);
  return image;
}
