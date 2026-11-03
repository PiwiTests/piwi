import { isListedHost } from './allowed-host';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//;
const HOST_HEADER = /^[a-z0-9._~[\]:-]+$/i;

/** The message of the 403 a refused write gets while authentication is off. */
export const CROSS_SITE_REFUSED_WITHOUT_AUTH_MESSAGE =
  'Cross-site requests are not accepted. With authentication off, a write from a browser that sends no ' +
  'Sec-Fetch-Site header (a page served over plain HTTP) is accepted only from the address the request names, the ' +
  'host of PIWI_SITE_URL or a name PIWI_ALLOWED_HOSTS lists: set PIWI_SITE_URL to the address you open the ' +
  'dashboard at, or add its name to PIWI_ALLOWED_HOSTS.';

/** `url` parsed, or null when it is unparsable or has an opaque (`null`) origin. */
function parseOrigin(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? null : parsed;
  } catch {
    return null;
  }
}

/** Whether `host` (a `Host` header) names the host and port of `origin`, its default port left out or written. */
function isOwnHost(origin: URL, host: string | null | undefined): boolean {
  if (!host || !HOST_HEADER.test(host)) return false;
  return parseOrigin(`${origin.protocol}//${host}`)?.host === origin.host;
}

/**
 * Whether a browser sent this state-changing request from another site: an unsafe
 * method whose `Sec-Fetch-Site` is `cross-site` or `same-site`. Browser extensions
 * (Piwi Picker) are allowed by their origin. Requests from servers, the reporter and
 * other tools carry no browser metadata and are never refused here.
 *
 * With authentication on, `Sec-Fetch-Site` alone decides: the `SameSite=Lax`
 * session cookie is withheld from a cross-site write. With authentication off, a
 * browser that sends no `Sec-Fetch-Site` (Safari before 16.4, and every browser to
 * a plain-HTTP address that is not a loopback one) is judged by its `Origin`. It
 * is accepted when its host and port are those of the `Host` header or of
 * `PIWI_SITE_URL` (`siteUrl`), whatever the scheme, or when `PIWI_ALLOWED_HOSTS`
 * (`allowedHosts`) names its host name (its entry `*` names none); any other
 * origin, an opaque or unparsable one included, is another site.
 */
export function isCrossSiteWrite(request: {
  method: string;
  secFetchSite?: string | null;
  origin?: string | null;
  /** Whether authentication is on. */
  authEnabled?: boolean;
  /** The `Host` header. */
  host?: string | null;
  /** `PIWI_SITE_URL`, when set. */
  siteUrl?: string | null;
  /** `PIWI_ALLOWED_HOSTS`, when set. */
  allowedHosts?: string | null;
}): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (request.origin && EXTENSION_ORIGIN.test(request.origin)) return false;
  if (request.secFetchSite) return request.secFetchSite === 'cross-site' || request.secFetchSite === 'same-site';
  if (request.authEnabled || !request.origin) return false;
  const from = parseOrigin(request.origin);
  if (!from) return true;
  if (isOwnHost(from, request.host)) return false;
  const site = request.siteUrl ? parseOrigin(request.siteUrl) : null;
  if (site?.host === from.host) return false;
  return !isListedHost(from.hostname, request.allowedHosts, { wildcard: false });
}
