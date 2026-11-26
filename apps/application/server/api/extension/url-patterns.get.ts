import { getDatabase } from '../../database';
import { getRequestAccess, isAuthEnabled, requireAuth } from '../../utils/auth';
import { getProjectScope } from '../../utils/project-access';
import { getProjectMenu } from '#shared/handlers/projects';
import { listVisibleUrlPatterns } from '#shared/handlers/url-patterns';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Extension'],
    summary: 'URL patterns for the browser extension',
    description:
      'Every URL pattern of every project the caller can see, with its environment (`environment`, the label as written, `environmentId` and `environmentName`, the environment it resolves to and the name Piwi Picker shows), branch and both path prefixes, in the order Piwi Picker tries them (by project, then each project’s own order), with each visible project and whether the caller may add patterns to it (`project:manage` on it), and the caller’s name. Piwi Picker reads it when it connects and when its settings open.',
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const scope = await getProjectScope(db, user);
  const [items, menu] = await Promise.all([listVisibleUrlPatterns(db, scope), getProjectMenu(db, scope)]);
  const access = await getRequestAccess(event);
  return {
    user: isAuthEnabled() ? { name: user.name || user.username } : null,
    items,
    projects: menu.map((p) => ({ id: p.id, label: p.label || p.name, canEdit: can(access, 'project:manage', p.id) })),
  };
});
