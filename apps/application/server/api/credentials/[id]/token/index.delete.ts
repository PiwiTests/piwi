import { requireUserTokenRoute } from '../../../../utils/user-tokens';
import { revokeUserTokens } from '../../../../utils/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Remove my token for a per-user credential',
    description:
      'Removes the token the caller gave for a per-user credential, from Piwi: actions on it are then refused to them until they give one again. An OAuth token is revoked at its host first where the host offers it (GitLab); a CI server API token, or a Bitbucket one, stays valid there: revoke it there too (the credential’s `tokenHelpUrl` links to where). Answers `{ removed }`, the number of tokens removed (0 or 1). Refuses an API key (403); 404 for a credential that is not per-user or that the caller’s Account page does not list; 400 without sign-in.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const { db, viewer, record } = await requireUserTokenRoute(event);
  return { removed: await revokeUserTokens(db, record, viewer.userId) };
});
