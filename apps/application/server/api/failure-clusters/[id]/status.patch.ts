import { patchClusterStatus } from '#shared/handlers/failure-clusters';
import { CLUSTER_STATUSES, isClusterStatus, isTriageNoteInput } from '#shared/inbox-queues';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Update failure cluster status or triage note',
    description:
      'Updates the status (open, resolved, ignored) of a failure cluster, its triage note, or both. An omitted `status` keeps it. A `triageNote` string replaces the note (empty clears it), `null` clears it, and an omitted one keeps it. A body with neither answers 400.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'triage:write',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  const body = await readBody(event);
  const status = body?.status;

  if (status !== undefined && !isClusterStatus(status)) {
    throw apiError({ statusCode: 400, message: `Invalid status. Must be one of: ${CLUSTER_STATUSES.join(', ')}` });
  }

  const triageNote = body?.triageNote;
  if (!isTriageNoteInput(triageNote)) {
    throw apiError({ statusCode: 400, message: 'triageNote must be a string or null' });
  }
  if (status === undefined && triageNote === undefined) {
    throw apiError({ statusCode: 400, message: 'Send a status, a triageNote or both' });
  }
  const result = await patchClusterStatus(db, id, status, triageNote);
  if (!result) {
    throw apiError({ statusCode: 404, message: 'Failure cluster not found' });
  }

  return result;
});
