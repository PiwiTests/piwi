/**
 * Jira's icons — an issue type's, a project's avatar — are served by the site
 * behind its own sign-in, so a browser that is not signed in to Jira cannot
 * load them. Piwi keeps only the icon's path on the site and serves it through
 * the connection; nothing but these image paths can be fetched that way.
 */

/** The site paths Jira serves icons and avatars from. */
const ICON_PATH =
  /^\/(?:rest\/api\/[23]\/universal_avatar\/view\/|images\/icons\/|secure\/viewavatar|secure\/projectavatar)/;

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
