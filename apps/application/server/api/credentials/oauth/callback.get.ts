import { getDatabase } from '../../../database';
import { requireSessionAuth } from '../../../utils/auth';
import { authorizedPagePath, finishUserAuthorization, OAUTH_CALLBACK_PATH } from '../../../utils/credential-oauth';
import { publicBaseUrl } from '../../../utils/public-base-url';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Come back from authorizing a per-user source control credential',
    description:
      'Where GitLab or Bitbucket sends a person back after `GET /api/credentials/:id/authorize`, with `code` and `state` (or `error`). The state is taken once, and only for the signed-in person who started it: an unknown, expired, used or someone else’s state saves nothing. The code is exchanged at the host, the token tested at its user endpoint and saved as the person’s, with the account it names. Redirects to `/authorized` with `credential`, `result` (`ok` or `error`), `reason` when it failed (`expired`, `someone-else`, `sign-in` (no session, or it expired at the host), `unavailable`, `disabled`, `denied`, `refused`, `client`, `unreachable`, `account-taken`, `changed`; never the host’s text) and `returnTo`. An API key gets `sign-in`.',
    parameters: [
      { name: 'code', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'error', in: 'query', required: false, schema: { type: 'string' } },
    ],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const base = useRuntimeConfig(event).app.baseURL;
  const query = getQuery(event);
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  // A session that expired while the person was at the host lands on the return page, which asks them to sign in.
  const user = await requireSessionAuth(event).catch((e: { statusCode?: number }) => {
    if (e.statusCode === 401 || e.statusCode === 403) return null;
    throw e;
  });
  const outcome = user?.id
    ? await finishUserAuthorization(await getDatabase(), user.id, {
        state: text(query.state),
        code: text(query.code) || null,
        error: text(query.error) || null,
        redirectUri: `${publicBaseUrl(event)}${OAUTH_CALLBACK_PATH}`,
      })
    : { ok: false, credentialId: null, returnTo: null, reason: 'sign-in' as const };
  return sendRedirect(event, authorizedPagePath(base, outcome), 302);
});
