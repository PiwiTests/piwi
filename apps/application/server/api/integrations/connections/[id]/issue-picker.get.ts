import { apiError } from '../../../../utils/api-error';
import { requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { createTracker } from '../../../../utils/integrations/connections';
import { requireConnectionAccess } from '../../../../utils/integrations/connection-access';
import { issuePickerCache } from '../../../../utils/integrations/picker-cache';
import { CONNECTION_NOT_FOUND } from '#shared/integrations/connection-access';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Search issues for a field',
    description:
      "Issues matching a key or words of their summary, for a create-issue field that points at another issue (a parent, an epic): the tracker project's own first (`project`), then the ones seen lately. An empty `q` lists the recent ones. Cached for a minute. Requires `issue:create` on a project bound to the connection (Contributor and above), `project:manage` on any project (Project admin) or `connections:manage` (administrators); to anyone else the connection answers 404, as a missing one does.",
    'x-required-permission': 'issue:create',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event);
  const db = await requireConnectionAccess(event, id);
  const query = getQuery(event);
  const project = typeof query.project === 'string' ? query.project : '';
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '';

  const cacheKey = `${id}:${project}:${q}`;
  const cached = issuePickerCache.get(cacheKey);
  if (cached) return { issues: cached };

  const tracker = await createTracker(db, id);
  if (!tracker) throw apiError({ statusCode: 404, message: CONNECTION_NOT_FOUND });
  if (!tracker.pickIssues) return { issues: [] };

  const issues = await tracker.pickIssues(q, project || null);
  issuePickerCache.set(cacheKey, issues);
  return { issues };
});
