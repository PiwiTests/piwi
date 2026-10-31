import { apiError } from '../../../../../../utils/api-error';
import { requireAuth } from '../../../../../../utils/auth';
import { requireRouteId } from '../../../../../../utils/project-access';
import { createTracker } from '../../../../../../utils/integrations/connections';
import { requireConnectionAccess } from '../../../../../../utils/integrations/connection-access';
import { issueTypesCache } from '../../../../../../utils/integrations/picker-cache';
import { CONNECTION_NOT_FOUND } from '#shared/integrations/connection-access';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: "List a project's issue types",
    description:
      'Issue types for a tracker project, for the create-issue modal. Cached for five minutes. Requires `issue:create` on a project bound to the connection (Contributor and above), `project:manage` on any project (Project admin) or `connections:manage` (administrators); to anyone else the connection answers 404, as a missing one does.',
    'x-required-permission': 'issue:create',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event);
  const db = await requireConnectionAccess(event, id);
  const key = getRouterParam(event, 'key');
  if (!key) throw apiError({ statusCode: 400, message: 'project key is required' });

  const cacheKey = `${id}:${key}`;
  const cached = issueTypesCache.get(cacheKey);
  if (cached) return { issueTypes: cached };

  const tracker = await createTracker(db, id);
  if (!tracker) throw apiError({ statusCode: 404, message: CONNECTION_NOT_FOUND });

  const issueTypes = await tracker.listIssueTypes(key);
  issueTypesCache.set(cacheKey, issueTypes);
  return { issueTypes };
});
