import { getDatabase } from '../../../database';
import { requireSessionAuth } from '../../../utils/auth';
import { finishUserAuthorization, OAUTH_CALLBACK_PATH } from '../../../utils/credential-oauth';
import { publicBaseUrl } from '../../../utils/public-base-url';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Come back from authorizing a per-user source control credential',
    description:
      'Where GitLab or Bitbucket sends a person back after `GET /api/credentials/:id/authorize`, with `code` and `state` (or `error`). The state is taken once, and only for the signed-in person who started it: an unknown, expired, used or someone else’s state saves nothing. The code is exchanged at the host, the token tested at its user endpoint and saved as the person’s, with the account it names. Redirects to `/authorized` with `credential`, `result` (`ok` or `error`), `message` when it failed (never the host’s text) and `returnTo`. Refuses an API key (403).',
    parameters: [
      { name: 'code', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'error', in: 'query', required: false, schema: { type: 'string' } },
    ],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireSessionAuth(event);
  const query = getQuery(event);
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const outcome = user.id
    ? await finishUserAuthorization(await getDatabase(), user.id, {
        state: text(query.state),
        code: text(query.code) || null,
        error: text(query.error) || null,
        redirectUri: `${publicBaseUrl(event)}${OAUTH_CALLBACK_PATH}`,
      })
    : { ok: false, credentialId: null, returnTo: null, message: 'An authorization needs sign-in.' };
  const target = new URLSearchParams({ result: outcome.ok ? 'ok' : 'error' });
  if (outcome.credentialId != null) target.set('credential', String(outcome.credentialId));
  if (outcome.message) target.set('message', outcome.message);
  if (outcome.returnTo) target.set('returnTo', outcome.returnTo);
  return sendRedirect(event, `/authorized?${target.toString()}`, 302);
});
