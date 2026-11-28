import { getDatabase } from '../../../../database';
import { requireSessionAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { loadCredentialRecord } from '#shared/handlers/credentials';
import { revokeUserTokens } from '../../../../utils/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Remove one person’s token for a per-user credential',
    description:
      'Removes from Piwi the token one person gave for a per-user credential, so they must give it again before an action on it runs in their name. An OAuth token is revoked at its host first where the host offers it (GitLab); a CI server API token, or a Bitbucket one, stays valid there. Answers `{ removed }` (0 or 1). 404 for a credential that is not per-user. Refuses an API key (403): only a signed-in session reaches people’s tokens.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'userId', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'credentials:manage',
  },
});

export default eventHandler(async (event) => {
  await requireSessionAuth(event);
  const id = requireRouteId(event, 'id', 'credential ID');
  const userId = requireRouteId(event, 'userId', 'user ID');
  const db = await getDatabase();
  const record = await loadCredentialRecord(db, id);
  if (!record?.perUser) throw apiError({ statusCode: 404, message: 'Credential not found' });
  return { removed: await revokeUserTokens(db, record, userId) };
});
