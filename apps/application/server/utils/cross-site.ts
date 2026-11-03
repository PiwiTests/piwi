const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//;
const HOST_HEADER = /^[a-z0-9._~[\]:-]+$/i;

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
 * method whose `Sec-Fetch-Site` is `cross-site` or `same-site`. A browser that sends
 * no `Sec-Fetch-Site` is judged by its `Origin`: one whose host and port are not
 * those of the `Host` header, whatever its scheme, and that is not the origin of
 * `PIWI_SITE_URL` (`siteUrl`), is another site, and so is an opaque or unparsable
 * one. Browser extensions (Piwi Picker) are allowed by their origin. Requests from
 * servers, the reporter and other tools carry neither header and are never refused
 * here.
 */
export function isCrossSiteWrite(request: {
  method: string;
  secFetchSite?: string | null;
  origin?: string | null;
  /** The `Host` header. */
  host?: string | null;
  /** `PIWI_SITE_URL`, when set. */
  siteUrl?: string | null;
}): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (request.origin && EXTENSION_ORIGIN.test(request.origin)) return false;
  if (request.secFetchSite) return request.secFetchSite === 'cross-site' || request.secFetchSite === 'same-site';
  if (!request.origin) return false;
  const from = parseOrigin(request.origin);
  if (!from) return true;
  if (isOwnHost(from, request.host)) return false;
  const site = request.siteUrl ? parseOrigin(request.siteUrl) : null;
  return site?.origin !== from.origin;
}
