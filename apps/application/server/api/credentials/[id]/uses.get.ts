import { getDatabase } from '../../../database';
import { getRequestAccess, requireAuth } from '../../../utils/auth';
import { requireRouteId } from '../../../utils/project-access';
import {
  canManageCredential,
  listCredentialUses,
  loadCredentialRecord,
  parseCredentialUsesFilter,
} from '#shared/handlers/credentials';
import { can } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Read a credential’s log',
    description:
      'Returns the uses of a credential, newest first, 50 at a time: `{ items, nextCursor }`, `nextCursor` passed back as `before`. A row says which feature used it (`ci-dispatch`, `ci-check`), for which project, who started it (`actor`, and `apiKey` when it came through one), what it was about (`subjectType` and `subjectId`, a CI action), where it went (`destination`, the origin and path of the request), and how it ended (`result`: `sent`, `ok`, `failed` or `refused`, with its `reason`, the secret masked). A read (`ci-check`) is counted in one row per project, result and hour (`count`); every other use is a row of its own. `projectId`, `feature` and `result` filter the rows. Someone who holds `credentials:manage` reads every credential’s log; a Project admin the logs of those they created that are shared only with projects they manage. Any other answers 404.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'projectId', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'feature', in: 'query', required: false, schema: { type: 'string', enum: ['ci-dispatch', 'ci-check'] } },
      {
        name: 'result',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['sent', 'ok', 'failed', 'refused'] },
      },
      { name: 'before', in: 'query', required: false, schema: { type: 'integer' } },
    ],
    'x-required-permission': ['credentials:manage', 'project:manage'],
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const id = requireRouteId(event, 'id', 'credential ID');
  const access = await getRequestAccess(event);
  // The virtual administrator of an instance without sign-in is id 0, no user row.
  const viewer = { access, userId: user.id || null };
  const db = await getDatabase();
  const record = await loadCredentialRecord(db, id);
  if (!record || !(can(access, 'credentials:manage') || canManageCredential(viewer, record))) {
    throw apiError({ statusCode: 404, message: 'Credential not found' });
  }
  return listCredentialUses(db, id, parseCredentialUsesFilter(getQuery(event)));
});
