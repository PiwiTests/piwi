import type { H3Event } from 'h3';

/**
 * The dashboard's version, from the private runtime config: never in the public settings every page carries, so a
 * visitor not signed in does not learn it.
 */
export function dashboardVersion(event?: H3Event): string {
  const config = event ? useRuntimeConfig(event) : useRuntimeConfig();
  return String(config.appVersion ?? '');
}
