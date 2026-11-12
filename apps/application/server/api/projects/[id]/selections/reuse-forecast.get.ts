import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { getReuseForecast } from '#shared/handlers/reuse-forecast';

defineRouteMeta({
  openAPI: {
    tags: ['Selections'],
    summary: 'How much test time pass reuse would save, and how often it would have hidden a failure',
    description:
      "Over the 30 days before the project's latest run, on the default branch and on the other branches: the results that ran code identical to an earlier first-attempt pass of the same test and Playwright project, at most 14 days older (every file version that pass recorded is among the result's, or both ran at the same commit on CI), their test time, and those that failed or passed only on a retry anyway. Lists the tests with such identical-code failures. Reads the coverage already stored: tests without coverage at `functions` or `lines` are never comparable. An upper bound: test-side code and configuration changes are not seen. Read-only.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);

  const db = await getDatabase();
  return getReuseForecast(db, projectId);
});
