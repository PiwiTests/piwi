// Refuses state-changing requests a browser sends from another site. Without it,
// any page the user visits could submit a form or a `text/plain` POST (neither
// needs a CORS preflight) to an instance running with authentication off, where
// every caller is an administrator, or ride a signed-in session from a sibling
// subdomain.
import { isAuthEnabled } from '../utils/auth';
import { CROSS_SITE_REFUSED_WITHOUT_AUTH_MESSAGE, isCrossSiteWrite } from '../utils/cross-site';
import { configuredSiteUrl } from '../utils/public-base-url';

export default defineEventHandler((event) => {
  const authEnabled = isAuthEnabled(event);
  const crossSite = isCrossSiteWrite({
    method: event.method,
    secFetchSite: getRequestHeader(event, 'sec-fetch-site'),
    origin: getRequestHeader(event, 'origin'),
    authEnabled,
    host: getRequestHeader(event, 'host'),
    siteUrl: configuredSiteUrl(event),
    allowedHosts: process.env.PIWI_ALLOWED_HOSTS,
  });
  if (!crossSite) return;
  const message = authEnabled ? 'Cross-site requests are not accepted' : CROSS_SITE_REFUSED_WITHOUT_AUTH_MESSAGE;
  throw apiError({ statusCode: 403, message });
});
