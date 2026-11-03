const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//;

/** The serialized origin of `url`, or null when it has none (`null`, an unparsable value). */
function originOf(url: string): string | null {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Whether a browser sent this state-changing request from another site: an unsafe
 * method whose `Sec-Fetch-Site` is `cross-site` or `same-site`. A browser that sends
 * no `Sec-Fetch-Site` is judged by its `Origin`: anything but the request's own origin
 * (`protocol` and `Host`) or the origin of `PIWI_SITE_URL` (`siteUrl`) is another site.
 * Browser extensions (Piwi Picker) are allowed by their origin. Requests from servers,
 * the reporter and other tools carry neither header and are never refused here.
 */
export function isCrossSiteWrite(request: {
  method: string;
  secFetchSite?: string | null;
  origin?: string | null;
  /** The `Host` header. */
  host?: string | null;
  /** The request's scheme: `http` or `https`. */
  protocol?: string | null;
  /** `PIWI_SITE_URL`, when set. */
  siteUrl?: string | null;
}): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (request.origin && EXTENSION_ORIGIN.test(request.origin)) return false;
  if (request.secFetchSite) return request.secFetchSite === 'cross-site' || request.secFetchSite === 'same-site';
  if (!request.origin) return false;
  const from = originOf(request.origin);
  if (!from) return true;
  const own = request.host ? originOf(`${request.protocol || 'http'}://${request.host}`) : null;
  const site = request.siteUrl ? originOf(request.siteUrl) : null;
  return from !== own && from !== site;
}
