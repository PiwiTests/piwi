import { apiError } from '../../../../utils/api-error';
import { requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { createTracker } from '../../../../utils/integrations/connections';
import { requireConnectionAccess } from '../../../../utils/integrations/connection-access';
import { assignableCache } from '../../../../utils/integrations/picker-cache';
import { CONNECTION_NOT_FOUND } from '#shared/integrations/connection-access';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Search assignable users',
    description:
      'Assignable users for a tracker project, for the create-issue modal. Cached for five minutes. Requires `issue:create` on a project bound to the connection (Contributor and above), `project:manage` on any project (Project admin) or `connections:manage` (administrators); to anyone else the connection answers 404, as a missing one does.',
    'x-required-permission': 'issue:create',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event);
  const db = await requireConnectionAccess(event, id);
  const query = getQuery(event);
  const project = typeof query.project === 'string' ? query.project : '';
  const q = typeof query.q === 'string' ? query.q : '';
  if (!project) throw apiError({ statusCode: 400, message: 'project is required' });

  const cacheKey = `${id}:${project}:${q}`;
  const cached = assignableCache.get(cacheKey);
  if (cached) return { users: cached };

  const tracker = await createTracker(db, id);
  if (!tracker) throw apiError({ statusCode: 404, message: CONNECTION_NOT_FOUND });

  const users = await tracker.searchAssignable(project, q);
  assignableCache.set(cacheKey, users);
  return { users };
});
