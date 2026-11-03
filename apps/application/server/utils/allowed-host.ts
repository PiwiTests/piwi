import { isIPv4, isIPv6 } from 'node:net';

/** The text of the 403 a server with authentication off answers to a request for another host. */
export const HOST_REFUSED_MESSAGE =
  'With authentication off, this dashboard answers only on its local addresses (an IP address, localhost, a name ' +
  'with no dot such as a container name, a name under .localhost), the host set in PIWI_SITE_URL and the names ' +
  'listed in PIWI_ALLOWED_HOSTS. Open it at one of those, add the name you use to PIWI_ALLOWED_HOSTS, or turn ' +
  'authentication on (PIWI_AUTH_ENABLED=true).';

const BRACKETED_HOST = /^\[([^\]]+)\](?::\d{1,5})?$/;
const NAMED_HOST = /^([a-z0-9._-]+)(?::\d{1,5})?$/;
/** A name of `PIWI_ALLOWED_HOSTS`, or a domain when it starts with a dot. */
const ALLOWED_HOST_ENTRY = /^\.?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

/** What a server with authentication off answers besides its local addresses. */
interface HostAllowance {
  /** `PIWI_SITE_URL`: its host is answered. */
  siteUrl?: string | null;
  /** `PIWI_ALLOWED_HOSTS`: comma-separated names, `.example.lan` for a domain and the names under it, `*` for any. */
  allowedHosts?: string | null;
}

/**
 * Whether a server running with authentication off answers a request whose `Host`
 * header is `host`: an IP address (IPv6 in brackets), a name with no dot
 * (`localhost`, a container name), a name under `.localhost`, the host of
 * `PIWI_SITE_URL`, or a name `PIWI_ALLOWED_HOSTS` lists. Any other name is one a
 * browser reached through DNS, which may point a site's own name at this server.
 * A request with no `Host` comes from no browser and is answered. The entry `*` of
 * `PIWI_ALLOWED_HOSTS` answers every host.
 */
export function isAllowedHostWithoutAuth(host: string | null | undefined, allowance: HostAllowance = {}): boolean {
  if (allowedHostEntries(allowance.allowedHosts).includes('*')) return true;
  if (host === undefined || host === null) return true;
  const value = host.trim().toLowerCase();
  const bracketed = BRACKETED_HOST.exec(value);
  if (bracketed) return isIPv6(bracketed[1]!);
  const name = NAMED_HOST.exec(value)?.[1];
  if (!name) return false;
  if (isIPv4(name) || !name.includes('.') || name.endsWith('.localhost')) return true;
  if (name === siteHostname(allowance.siteUrl)) return true;
  return isListedHost(name, allowance.allowedHosts);
}

/**
 * Whether `PIWI_ALLOWED_HOSTS` (`allowedHosts`) allows the host name `name`, given
 * lowercased and without a port: a name it lists, the domain of an entry starting
 * with a dot or a name under it, or any name for the entry `*`.
 */
export function isListedHost(name: string, allowedHosts: string | null | undefined): boolean {
  return allowedHostEntries(allowedHosts).some((entry) => {
    if (entry === '*') return true;
    return entry.startsWith('.') ? name === entry.slice(1) || name.endsWith(entry) : name === entry;
  });
}

/** The entries of `PIWI_ALLOWED_HOSTS`, lowercased and without a port: `*`, names and `.domains`; others are dropped. */
function allowedHostEntries(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) =>
      entry
        .trim()
        .toLowerCase()
        .replace(/:\d{1,5}$/, ''),
    )
    .filter((entry) => entry === '*' || ALLOWED_HOST_ENTRY.test(entry));
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
