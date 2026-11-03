// With authentication off every caller is an administrator, so the server answers
// only requests addressed to one of its local names or to the host of PIWI_SITE_URL.
// A page on any other domain that resolves to this server's address would
// otherwise reach the API as same-origin. Reads `Host` alone, never
// `X-Forwarded-Host`. Runs before every other middleware (files run in name order).
import { HOST_REFUSED_MESSAGE, isAllowedHostWithoutAuth } from '../utils/allowed-host';
import { isAuthEnabled } from '../utils/auth';
import { configuredSiteUrl } from '../utils/public-base-url';

export default defineEventHandler((event) => {
  if (isAuthEnabled(event)) return;
  if (isAllowedHostWithoutAuth(getRequestHeader(event, 'host'), configuredSiteUrl(event))) return;
  setResponseStatus(event, 403);
  setResponseHeaders(event, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  return HOST_REFUSED_MESSAGE;
});
