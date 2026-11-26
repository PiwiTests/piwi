import { patchClusterBaseCommit } from '#shared/handlers/failure-clusters';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Update manual base commit for a cluster',
    description: 'Persists a manual baseline commit SHA for a failure cluster used in AI diagnosis context.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'triage:write',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  const body = await readBody<{ commit?: unknown }>(event);
  const commit = typeof body?.commit === 'string' ? body.commit.trim() : null;

  const result = await patchClusterBaseCommit(db, id, commit);
  if (!result) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });

  return result;
});
