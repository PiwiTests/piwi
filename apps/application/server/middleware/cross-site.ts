// Refuses state-changing requests a browser sends from another site. Without it,
// any page the user visits could submit a form or a `text/plain` POST (neither
// needs a CORS preflight) to an instance running with authentication off, where
// every caller is an administrator, or ride a signed-in session from a sibling
// subdomain.
import { isCrossSiteWrite } from '../utils/cross-site';
import { configuredSiteUrl } from '../utils/public-base-url';

export default defineEventHandler((event) => {
  const crossSite = isCrossSiteWrite({
    method: event.method,
    secFetchSite: getRequestHeader(event, 'sec-fetch-site'),
    origin: getRequestHeader(event, 'origin'),
    host: getRequestHeader(event, 'host'),
    protocol: getRequestProtocol(event),
    siteUrl: configuredSiteUrl(event),
  });
  if (crossSite) throw apiError({ statusCode: 403, message: 'Cross-site requests are not accepted' });
});
