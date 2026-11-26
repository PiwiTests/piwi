import { patchClusterAssignee } from '#shared/handlers/failure-clusters';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Assign a failure cluster',
    description:
      "Set or clear the cluster's assignee (a name or email). The assignee overrides the owner derived from the test's annotation and drives the inbox's Mine queue. Send an empty value to unassign.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'triage:write',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  const body = await readBody<{ assignee?: unknown }>(event);
  const assignee = body?.assignee;
  if (assignee != null && typeof assignee !== 'string') {
    throw apiError({ statusCode: 400, message: 'assignee must be a string or null' });
  }

  const result = await patchClusterAssignee(db, id, assignee ?? null);
  if (!result) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });
  return result;
});
