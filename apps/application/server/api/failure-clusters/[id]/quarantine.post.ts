import { quarantineClusterTests } from '#shared/handlers/failure-clusters';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: "Quarantine a failure cluster's tests",
    description:
      'Quarantine every test currently in the cluster (the same exit-ramp quarantine the cluster page\'s "Quarantine all affected" button applies). Idempotent per test.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'quarantine:write',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db, user } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  const body = await readBody(event).catch(() => ({}));
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : undefined;

  const result = await quarantineClusterTests(db, id, { createdBy: user?.id ?? null, reason });
  if (!result) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });
  return result;
});
