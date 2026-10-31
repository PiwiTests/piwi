import { eq } from 'drizzle-orm';
import { getDatabase } from '../../../database';
import { failureClusters } from '../../../database/schema';
import { requireAuth } from '../../../utils/auth';
import { requireProjectPermission, requireRouteId } from '../../../utils/project-access';
import { findFixedBefore } from '../../../utils/cluster-memory';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Resolved clusters this one resembles, and how each was fixed',
    description:
      'Returns up to three resolved failure clusters that resemble this one — matched on the same fingerprint family (error kind, masked message, locator), the same failing locator, the same spec or test, and (when embeddings are configured) semantic similarity — each with when it was resolved, the resolving commit, how long it stayed open, the triage note, owner and diagnosis, and one short reason it matched. Empty when nothing clears the similarity threshold.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const clusterId = requireRouteId(event, 'id', 'cluster ID');
  await requireAuth(event);
  const db = await getDatabase();

  const [cluster] = await db.select().from(failureClusters).where(eq(failureClusters.id, clusterId));
  if (!cluster) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });

  await requireProjectPermission(event, cluster.projectId);

  return { items: await findFixedBefore(db, cluster) };
});
