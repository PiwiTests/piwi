import { eq } from 'drizzle-orm';
import { failureClusters } from '../../../database/schema';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';
import { ciRerunAvailability } from '../../../utils/ci-rerun';
import { clusterRerunCases } from '#shared/handlers/cluster-rerun-cases';
import { clusterLastDispatch } from '#shared/handlers/ci-dispatches';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'CI re-run availability for a cluster',
    description:
      "Whether this cluster can be re-run in CI (feature enabled, a CI action that re-runs tests for the repository's provider, a token present, and a test with a file path a re-run can name), with a reason when it cannot, the CI action that would run, and the most recent dispatch the provider took, with the run that answered it and that run's result.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  const [cluster] = await db
    .select({
      projectId: failureClusters.projectId,
      lastSeenRunId: failureClusters.lastSeenRunId,
    })
    .from(failureClusters)
    .where(eq(failureClusters.id, id));
  if (!cluster) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });

  const availability = await ciRerunAvailability(db, cluster.projectId, cluster.lastSeenRunId, null, () =>
    clusterRerunCases(db, id),
  );
  return { ...availability, lastDispatch: await clusterLastDispatch(db, id) };
});
