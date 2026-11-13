import { eq } from 'drizzle-orm';
import { failureClusters } from '../../../database/schema';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';
import { ciRerunAvailability } from '../../../utils/ci-rerun';
import type { ClusterRerunDispatch } from '#shared/ci-rerun';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'CI re-run availability for a cluster',
    description:
      "Whether this cluster can be re-run in CI (feature enabled, a CI action that re-runs tests for the repository's provider, a token present), with a reason when it cannot, the CI action that would run, and the most recent dispatch.",
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
      lastRerunDispatch: failureClusters.lastRerunDispatch,
    })
    .from(failureClusters)
    .where(eq(failureClusters.id, id));
  if (!cluster) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });

  const availability = await ciRerunAvailability(db, cluster.projectId, cluster.lastSeenRunId);
  return {
    ...availability,
    lastDispatch: (cluster.lastRerunDispatch as ClusterRerunDispatch | null) ?? null,
  };
});
