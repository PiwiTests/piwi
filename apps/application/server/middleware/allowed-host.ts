// With authentication off every caller is an administrator, so the server answers
// only requests addressed to one of its local names, to the host of PIWI_SITE_URL or
// to a name PIWI_ALLOWED_HOSTS lists.
// A page on any other domain that resolves to this server's address would
// otherwise reach the API as same-origin. Reads `Host` alone, never
// `X-Forwarded-Host`. Runs before every other middleware (files run in name order).
import { HOST_REFUSED_MESSAGE, isAllowedHostWithoutAuth } from '../utils/allowed-host';
import { isAuthEnabled } from '../utils/auth';
import { configuredSiteUrl } from '../utils/public-base-url';

export default defineEventHandler((event) => {
  if (isAuthEnabled(event)) return;
  const allowance = { siteUrl: configuredSiteUrl(event), allowedHosts: process.env.PIWI_ALLOWED_HOSTS };
  if (isAllowedHostWithoutAuth(getRequestHeader(event, 'host'), allowance)) return;
  setResponseStatus(event, 403);
  setResponseHeaders(event, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  return HOST_REFUSED_MESSAGE;
});
