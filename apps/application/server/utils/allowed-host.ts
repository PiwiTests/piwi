import { isIPv4, isIPv6 } from 'node:net';

/** The text of the 403 a server with authentication off answers to a request for another host. */
export const HOST_REFUSED_MESSAGE =
  'With authentication off, this dashboard answers only on its local addresses (an IP address, localhost, a name ' +
  'with no dot such as a container name, a name under .localhost) and the host set in PIWI_SITE_URL. Open it at one ' +
  'of those, set PIWI_SITE_URL to the address you use, or turn authentication on (PIWI_AUTH_ENABLED=true).';

const BRACKETED_HOST = /^\[([^\]]+)\](?::\d{1,5})?$/;
const NAMED_HOST = /^([a-z0-9._-]+)(?::\d{1,5})?$/;

/**
 * Whether a server running with authentication off answers a request whose `Host`
 * header is `host`: an IP address (IPv6 in brackets), a name with no dot
 * (`localhost`, a container name), a name under `.localhost`, or the host of
 * `siteUrl` (`PIWI_SITE_URL`). Any other name is one a browser reached through DNS,
 * which may point a site's own name at this server. A request with no `Host` comes
 * from no browser and is answered.
 */
export function isAllowedHostWithoutAuth(host: string | null | undefined, siteUrl?: string | null): boolean {
  if (host === undefined || host === null) return true;
  const value = host.trim().toLowerCase();
  const bracketed = BRACKETED_HOST.exec(value);
  if (bracketed) return isIPv6(bracketed[1]!);
  const name = NAMED_HOST.exec(value)?.[1];
  if (!name) return false;
  if (isIPv4(name) || !name.includes('.') || name.endsWith('.localhost')) return true;
  return name === siteHostname(siteUrl);
}

/** The hostname of `siteUrl`, lowercased, or null when it is unset or not a URL. */
function siteHostname(siteUrl: string | null | undefined): string | null {
  if (!siteUrl) return null;
  try {
    return new URL(siteUrl).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
