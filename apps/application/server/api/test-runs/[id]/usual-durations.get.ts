import { runUsualDurations } from '#shared/handlers/stuck-tests';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'The usual duration of the tests of a run’s project',
    description:
      'For each test of the run’s project and each Playwright project it ran in (`browser`, null for none), its usual duration (`usualMs`): the longest of its last 10 passing executions in runs eligible as a baseline (no Flake Lab or investigation run, no environment incident), the history the Stuck? rule reads. A test with fewer than 2 such passes is left out. The run page’s Timeline draws it behind each running test while the run is live. Read-only.',
    'x-required-permission': 'project:read',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  return runUsualDurations(db, id);
});
