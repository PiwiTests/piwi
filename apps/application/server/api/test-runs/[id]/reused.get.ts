import { getRunReusedResults } from '#shared/handlers/reused-results';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'The tests a run reused from earlier passes',
    description:
      'The tests the run’s pass reuse plan skipped (`piwi run --plan`, experimental), each with the Playwright projects it was skipped in and the earlier pass that stood in for it: its run, an execution of it, its commit and when its run started. A reused result is not an execution: it counts toward the run’s verdict and the CI gate only. `count` is every reused test; `items` lists up to 500, by file and title. Read-only.',
    'x-required-permission': 'project:read',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  return getRunReusedResults(db, id);
});
