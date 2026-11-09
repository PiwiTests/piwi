import type { H3Event } from 'h3';
import { resolvePublicBaseUrl } from './oauth-helpers';

/**
 * The public base URL of this instance, without a trailing slash:
 * `PIWI_SITE_URL` when set (stable behind a reverse proxy), else the origin of
 * the request.
 */
export function publicBaseUrl(event: H3Event): string {
  const siteUrl = (useRuntimeConfig(event).public as { siteUrl?: string })?.siteUrl;
  const url = getRequestURL(event);
  return resolvePublicBaseUrl(siteUrl, `${url.protocol}//${url.host}`);
}

/** `PIWI_SITE_URL` from the environment, else from the runtime config; null when it is unset. */
export function configuredSiteUrl(event: H3Event): string | null {
  const fromConfig = (useRuntimeConfig(event).public as { siteUrl?: string })?.siteUrl;
  return process.env.PIWI_SITE_URL?.trim() || fromConfig?.trim() || null;
}
