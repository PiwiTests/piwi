import { getDatabase } from '../../../database';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { optionalIntQuery } from '../../../utils/query-params';
import { listCiDispatches } from '#shared/handlers/ci-dispatches';
import { parseRouteId } from '#shared/route-id';

defineRouteMeta({
  openAPI: {
    tags: ['CI dispatches'],
    summary: "List a project's CI dispatches",
    description:
      "The project's CI dispatches, newest first: who dispatched what, through which action, on which branch, and the run that answered each. `state=open` keeps those still waiting for their run (`dispatched` within the six-hour matching window) and those whose run is going on (`running`); `state=all`, the default, keeps every state, `ended`, `unreported` and `refused` included. `clusterId` keeps a cluster's dispatches, `testCaseId` a test's Flake Lab dispatches. `limit` is 20 by default, at most 100. Each item is a dispatch as `GET /api/ci-dispatches/{id}` answers it. Readable by anyone who reads the project.",
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'state', in: 'query', required: false, schema: { type: 'string', enum: ['open', 'all'] } },
      { name: 'clusterId', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'testCaseId', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
    responses: {
      200: { description: 'The dispatches, as `items`' },
      400: { description: 'A `state`, `clusterId`, `testCaseId` or `limit` that is not one' },
    },
    'x-required-permission': 'project:read',
  },
});

/** An optional id query key: absent, or a positive integer (400 otherwise). */
function idQuery(raw: unknown, name: string): number | null {
  if (raw === undefined || raw === '') return null;
  const id = typeof raw === 'string' ? parseRouteId(raw) : null;
  if (id === null) throw apiError({ statusCode: 400, message: `${name} must be a positive integer` });
  return id;
}

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);
  const query = getQuery(event);
  const state = query.state ?? 'all';
  if (state !== 'open' && state !== 'all') throw apiError({ statusCode: 400, message: 'state must be open or all' });
  const items = await listCiDispatches(await getDatabase(), projectId, {
    state,
    clusterId: idQuery(query.clusterId, 'clusterId'),
    testCaseId: idQuery(query.testCaseId, 'testCaseId'),
    limit: optionalIntQuery(event, 'limit', { default: 20, min: 1, max: 100 }),
  });
  return { items };
});
