import {
  requireResolvedProjectAccess,
  requireRouteId,
  resolveTestRunCaseProjectId,
} from '../../../utils/project-access';
import { executionRerunInfo } from '../../../utils/ci-rerun';

defineRouteMeta({
  openAPI: {
    tags: ['Test Run Cases'],
    summary: 'CI re-run availability for an execution',
    description:
      "Whether this execution's test can be re-run in CI (feature enabled, a target configured for the repository's provider, a token present), with a reason when it cannot, plus its cluster's id and most recent dispatch.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run case ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveTestRunCaseProjectId, 'Test run case');
  const info = await executionRerunInfo(db, id);
  if (!info) throw apiError({ statusCode: 404, message: 'Test run case not found' });
  return info;
});
