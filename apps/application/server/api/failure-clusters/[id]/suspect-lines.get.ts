import { suspectLinesForCluster } from '../../../utils/suspect-lines';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Get the changed lines the cluster’s failing tests executed (suspect lines)',
    description:
      'Reads the newest run in which the cluster has failing executions with coverage (`runId`, null when none has), joins the lines changed between the last green run and that run (from the project’s source control) with the coverage of those executions (at most 50), and ranks each changed hunk they executed by how many passing executions of the run executed it too (at most 200 read; the Ochiai score of spectrum-based fault localization). The answer has the shape of the execution endpoint’s, `GET /api/test-run-cases/{id}/suspect-lines`, plus `runId`; `failing` counts the cluster’s failing executions that executed a hunk. Answers are kept for five minutes.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'Failure cluster id' },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'failure cluster ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');
  return suspectLinesForCluster(db, id);
});
