import { getDatabase } from '../../../../database';
import { apiError } from '../../../../utils/api-error';
import { requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { createTracker } from '../../../../utils/integrations/connections';
import { issuePickerCache } from '../../../../utils/integrations/picker-cache';

defineRouteMeta({
  openAPI: {
    tags: ['Integrations'],
    summary: 'Search issues for a field',
    description:
      "Issues matching a key or words of their summary, for a create-issue field that points at another issue (a parent, an epic): the tracker project's own first (`project`), then the ones seen lately. An empty `q` lists the recent ones. Cached for a minute. Requires `issue:create` on at least one project (Contributor and above).",
    'x-required-permission': 'issue:create',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event);
  const query = getQuery(event);
  const project = typeof query.project === 'string' ? query.project : '';
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '';

  const cacheKey = `${id}:${project}:${q}`;
  const cached = issuePickerCache.get(cacheKey);
  if (cached) return { issues: cached };

  const db = await getDatabase();
  const tracker = await createTracker(db, id);
  if (!tracker) throw apiError({ statusCode: 404, message: 'Connection not found or has no credentials' });
  if (!tracker.pickIssues) return { issues: [] };

  const issues = await tracker.pickIssues(q, project || null);
  issuePickerCache.set(cacheKey, issues);
  return { issues };
});
