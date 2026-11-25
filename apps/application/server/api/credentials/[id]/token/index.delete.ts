import { requireUserTokenRoute } from '../../../../utils/user-tokens';
import { deleteUserTokens } from '#shared/handlers/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Remove my token for a per-user credential',
    description:
      'Removes the token the caller gave for a per-user credential, from Piwi: actions on it are then refused to them until they give one again. A CI server API token stays valid on the CI server: revoke it there too (the credential’s `tokenHelpUrl` links to where). Answers `{ removed }`, the number of tokens removed (0 or 1). Refuses an API key (403); 404 for a credential that is not per-user or that the caller’s Account page does not list; 400 without sign-in.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const { db, viewer, record } = await requireUserTokenRoute(event);
  return { removed: await deleteUserTokens(db, record.id, viewer.userId) };
});
