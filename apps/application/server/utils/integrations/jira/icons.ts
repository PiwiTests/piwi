/**
 * Jira's icons — an issue type's, a project's avatar — are served by the site
 * behind its own sign-in, so a browser that is not signed in to Jira cannot
 * load them. Piwi keeps only the icon's path on the site and serves it through
 * the connection; nothing but these image paths can be fetched that way.
 *
 * A person's avatar is usually not on the site but on Atlassian's public avatar
 * service or Gravatar. Piwi serves those too, so the browser never calls a third
 * party, fetched without the connection's credentials and from those hosts only.
 */

/** The site paths Jira serves icons and avatars from. */
const ICON_PATH =
  /^\/(?:rest\/api\/[23]\/universal_avatar\/view\/|images\/icons\/|secure\/viewavatar|secure\/projectavatar|secure\/useravatar)/;

/** The gateway prefix a scoped token's URLs carry before the site path. */
const GATEWAY_PREFIX = /^\/ex\/jira\/[^/]+(?=\/)/;

/** The most bytes an icon may weigh. */
export const MAX_ICON_BYTES = 256 * 1024;

/** Whether a path is one Jira serves icons from, with no way out of it. */
export function isJiraIconPath(path: string): boolean {
  return ICON_PATH.test(path) && !path.includes('..') && !path.includes('\\') && !path.startsWith('//');
}

/**
 * The site path of an icon Jira names (absolute on the site or the gateway, or
 * relative), or null for one hosted elsewhere or not an icon.
 */
export function jiraIconPath(url: string | null | undefined, siteUrl: string): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url, siteUrl);
  } catch {
    return null;
  }
  const site = new URL(siteUrl);
  let path = parsed.pathname;
  if (parsed.host === 'api.atlassian.com') path = path.replace(GATEWAY_PREFIX, '');
  else if (parsed.host !== site.host) return null;
  const full = `${path}${parsed.search}`;
  return isJiraIconPath(full) ? full : null;
}

/** The public hosts Jira Cloud serves people's avatars from. */
function isAvatarHost(host: string): boolean {
  return (
    host === 'secure.gravatar.com' ||
    host === 'avatar-cdn.atlassian.com' ||
    /^avatar-management--avatars\.[a-z0-9-]+\.prod\.public\.atl-paas\.net$/.test(host)
  );
}

/** Whether a URL is a person's avatar on one of the public hosts Jira uses. */
export function isExternalAvatarUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && isAvatarHost(parsed.host);
  } catch {
    return false;
  }
}

/**
 * The avatar a person's `avatarUrls` names, as the icon route takes it: a URL
 * on a public avatar host, else a path on the site, else null.
 */
export function jiraAvatar(url: string | null | undefined, siteUrl: string): string | null {
  if (url && isExternalAvatarUrl(url)) return url;
  return jiraIconPath(url, siteUrl);
}

/** Gravatar redirects to the initials Atlassian draws for a person with none: followed this many times. */
const MAX_AVATAR_REDIRECTS = 3;

/**
 * A person's avatar from a public avatar host, with no credentials, following
 * redirects only while they stay on those hosts. Null when it is not an image,
 * is too large, or leaves them.
 */
export async function fetchExternalAvatar(
  url: string,
  timeoutMs = 10_000,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_AVATAR_REDIRECTS; hop++) {
    if (!isExternalAvatarUrl(current)) return null;
    const response = await fetch(current, {
      redirect: 'manual',
      headers: { Accept: 'image/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      current = new URL(location, current).toString();
      continue;
    }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!response.ok || !mime.startsWith('image/')) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > MAX_ICON_BYTES ? null : { bytes, mime };
  }
  return null;
}
