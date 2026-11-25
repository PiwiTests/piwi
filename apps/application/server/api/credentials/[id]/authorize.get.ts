import { startUserAuthorization, OAUTH_CALLBACK_PATH } from '../../../utils/credential-oauth';
import { CredentialRefusedError } from '../../../utils/credentials';
import { publicBaseUrl } from '../../../utils/public-base-url';
import { requireUserTokenRoute } from '../../../utils/user-tokens';
import { getEncryptionKey } from '../../../utils/crypto';
import { safeReturnPath } from '#shared/return-path';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Authorize a per-user source control credential',
    description:
      'Starts the caller’s OAuth authorization of a per-user GitLab or Bitbucket credential: keeps a single-use `state` on the server, bound to the caller, the credential, a PKCE verifier (GitLab) and the page to go back to (`returnTo`, a path of this site), for 10 minutes, and redirects to the host’s authorization page. The host sends the caller back to `GET /api/credentials/oauth/callback`. Refuses an API key (403); 404 for a credential that is not per-user or that the caller may not use; 400 for a credential that takes a typed token (a CI server’s), a disabled one, or without sign-in; 409 while `PIWI_SECRET_KEY` is unset.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'returnTo', in: 'query', required: false, schema: { type: 'string' } },
    ],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const { db, viewer, record, entry } = await requireUserTokenRoute(event);
  if (!entry.usable) throw apiError({ statusCode: 404, message: 'Credential not found' });
  if (entry.method !== 'oauth') {
    throw apiError({ statusCode: 400, message: 'This credential takes your token in a form, not an authorization.' });
  }
  if (entry.disabled) throw apiError({ statusCode: 400, message: `The credential "${record.name}" is disabled.` });
  // The token the host answers is saved encrypted: without the key, nobody is sent to the host.
  getEncryptionKey();
  let url: string;
  try {
    url = await startUserAuthorization(db, record, viewer.userId, {
      redirectUri: `${publicBaseUrl(event)}${OAUTH_CALLBACK_PATH}`,
      returnTo: safeReturnPath(getQuery(event).returnTo),
    });
  } catch (e) {
    if (e instanceof CredentialRefusedError) throw apiError({ statusCode: 400, message: e.message });
    throw e;
  }
  return sendRedirect(event, url, 302);
});
