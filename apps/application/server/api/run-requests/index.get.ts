import { parseRouteId } from '#shared/route-id';
import { listOwnRequests } from '#shared/handlers/run-requests';
import { getDatabase } from '../../database';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { endStaleRequests, requireSignInForRunRequests } from '../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'List your run requests',
    description:
      'Answers the caller’s own run requests, newest first, at most 20: of one project with `projectId`, else of every project they can read. Each is read as `GET /api/run-requests/{id}` answers it. Anyone else’s requests are never listed.',
    parameters: [{ name: 'projectId', in: 'query', required: false, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
    responses: {
      200: { description: 'The requests, as `items`' },
      400: { description: '`projectId` is not a project id' },
    },
  },
});

export default eventHandler(async (event) => {
  requireSignInForRunRequests(event);
  const user = await requireAuth(event);
  const raw = getQuery(event).projectId;
  let projectId: number | undefined;
  if (raw !== undefined) {
    const parsed = parseRouteId(typeof raw === 'string' ? raw : null);
    if (parsed == null) throw apiError({ statusCode: 400, message: 'projectId must be a project id' });
    projectId = parsed;
  }
  const db = await getDatabase();
  await endStaleRequests(db);
  return { items: await listOwnRequests(db, user.id, await getRequestAccess(event), { projectId }) };
});
