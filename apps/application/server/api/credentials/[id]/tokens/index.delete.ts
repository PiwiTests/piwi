import { getDatabase } from '../../../../database';
import { requireAuth } from '../../../../utils/auth';
import { requireRouteId } from '../../../../utils/project-access';
import { deleteUserTokens, loadCredentialRecord } from '#shared/handlers/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Remove every token of a per-user credential',
    description:
      'Removes from Piwi every token people gave for a per-user credential, so each of them must give theirs again before an action on it runs in their name. A CI server API token stays valid on the CI server. Answers `{ removed }`, how many went. 404 for a credential that is not per-user.',
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
  return { removed: await deleteUserTokens(db, id, null) };
});
