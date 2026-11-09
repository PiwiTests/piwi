import { extractClusterCases } from '#shared/handlers/failure-clusters';
import { isTriageNoteInput } from '#shared/inbox-queues';
import { requireResolvedProjectAccess, requireRouteId, resolveClusterProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Move test cases to a new failure cluster',
    description:
      'Moves the selected tests’ executions out of a failure cluster into a new cluster, which receives the optional triage note. Their later failures with the same error join the new cluster, and the two clusters are never merged automatically. The source cluster’s triage note gains a line naming the move. Returns the new cluster’s id (`clusterId`), null when none of the tests has an execution in the cluster.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'triage:write',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'cluster ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveClusterProjectId, 'Failure cluster');

  const body = await readBody(event);
  const testCaseIds: number[] | undefined = body?.testCaseIds;
  if (!testCaseIds || !Array.isArray(testCaseIds) || testCaseIds.length === 0) {
    throw apiError({ statusCode: 400, message: 'testCaseIds must be a non-empty array' });
  }

  const triageNote: unknown = body?.triageNote;
  if (!isTriageNoteInput(triageNote)) {
    throw apiError({ statusCode: 400, message: 'triageNote must be a string' });
  }

  const result = await extractClusterCases(db, id, testCaseIds, triageNote ?? undefined);
  if (!result) {
    throw apiError({ statusCode: 404, message: 'Failure cluster not found' });
  }

  return result;
});
