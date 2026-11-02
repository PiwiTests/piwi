import { patchClusterStatus } from '#shared/handlers/failure-clusters';
import { CLUSTER_STATUSES, isClusterStatus, isTriageNoteInput } from '#shared/inbox-queues';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Update failure cluster status',
    description:
      'Updates the status (open, resolved, ignored) of a failure cluster. A `triageNote` string replaces the note (empty clears it), `null` clears it, and an omitted one keeps it.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'triage:write',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  const body = await readBody(event);
  const status = body?.status;

  if (!isClusterStatus(status)) {
    throw apiError({ statusCode: 400, message: `Invalid status. Must be one of: ${CLUSTER_STATUSES.join(', ')}` });
  }

  const triageNote = body?.triageNote;
  if (!isTriageNoteInput(triageNote)) {
    throw apiError({ statusCode: 400, message: 'triageNote must be a string or null' });
  }
  const result = await patchClusterStatus(db, id, status, triageNote);
  if (!result) {
    throw apiError({ statusCode: 404, message: 'Failure cluster not found' });
  }

  return result;
});
