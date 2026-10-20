import { getDatabase } from '../../../../database';
import { apiError } from '../../../../utils/api-error';
import { requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { createTracker } from '../../../../utils/integrations/connections';
import { fetchExternalAvatar, isExternalAvatarUrl, isJiraIconPath } from '../../../../utils/integrations/jira/icons';
import { iconCache } from '../../../../utils/integrations/picker-cache';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Read a tracker icon',
    description:
      "An icon the tracker serves behind its own sign-in — an issue type's, a project's avatar — fetched through the connection, so the create-issue modal shows it to a reader who is not signed in to Jira. `path` is the icon's path on the site, as the pickers return it; only Jira's icon and avatar paths are served. A person's avatar on Atlassian's public avatar service or Gravatar is passed as its URL and fetched without the connection's credentials, so the browser never calls a third party. Cached for an hour. Requires `issue:create` on at least one project (Contributor and above).",
    'x-required-permission': 'issue:create',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event);
  const query = getQuery(event);
  const path = typeof query.path === 'string' ? query.path : '';
  const external = isExternalAvatarUrl(path);
  if (!external && !isJiraIconPath(path)) throw apiError({ statusCode: 400, message: 'path is not a tracker icon' });

  const cacheKey = `${id}:${path}`;
  let icon = iconCache.get(cacheKey);
  if (icon === undefined && external) {
    icon = await fetchExternalAvatar(path).catch(() => null);
    iconCache.set(cacheKey, icon);
  } else if (icon === undefined) {
    const db = await getDatabase();
    const tracker = await createTracker(db, id);
    if (!tracker) throw apiError({ statusCode: 404, message: 'Connection not found or has no credentials' });
    try {
      icon = (await tracker.fetchIcon?.(path)) ?? null;
    } catch {
      icon = null;
    }
    iconCache.set(cacheKey, icon);
  }
  if (!icon) throw apiError({ statusCode: 404, message: 'Icon not found' });

  setResponseHeaders(event, {
    'Content-Type': icon.mime,
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    // Jira serves most icons as SVG: opened on its own, one never runs a script here.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  return Buffer.from(icon.bytes);
});
