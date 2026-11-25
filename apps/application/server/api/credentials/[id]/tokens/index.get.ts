import { getDatabase } from '../../../../database';
import { requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { listUserTokens, loadCredentialRecord } from '#shared/handlers/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'List the tokens people gave for a per-user credential',
    description:
      'The people who gave their own token for a per-user credential: `{ items }`, each `{ userId, userName, remoteUser, state, createdAt, testedAt, lastUsedAt }`, `remoteUser` being their account on the service as the test named it and `state` `ready` or `invalid`. Never a token. 404 for a credential that is not per-user.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'credentials:manage',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const id = requireRouteId(event, 'id', 'credential ID');
  const db = await getDatabase();
  const record = await loadCredentialRecord(db, id);
  if (!record?.perUser) throw apiError({ statusCode: 404, message: 'Credential not found' });
  return { items: await listUserTokens(db, id) };
});
