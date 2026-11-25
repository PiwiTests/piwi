import { authorizedPagePath, startUserAuthorization, OAUTH_CALLBACK_PATH } from '../../../utils/credential-oauth';
import { CredentialRefusedError } from '../../../utils/credentials';
import { publicBaseUrl } from '../../../utils/public-base-url';
import { limitUserAuthorizations, requireUserTokenRoute } from '../../../utils/user-tokens';
import { canEncryptSecrets } from '../../../utils/crypto';
import { safeReturnPath } from '#shared/return-path';
import { parseRouteId } from '#shared/route-id';
import type { AuthorizationFailure } from '#shared/credentials';

defineRouteMeta({
  openAPI: {
    tags: ['Credentials'],
    summary: 'Authorize a per-user source control credential',
    description:
      'Starts the caller’s OAuth authorization of a per-user GitLab or Bitbucket credential: keeps a single-use `state` on the server, bound to the caller, the credential, a PKCE verifier (GitLab) and the page to go back to (`returnTo`, a path of this site), for 10 minutes, and redirects to the host’s authorization page. The host sends the caller back to `GET /api/credentials/oauth/callback`. Opened in the caller’s window, it answers a refusal with a redirect to `/authorized` and its `reason`, never a JSON body: `sign-in` (no session, an API key or no sign-in), `unavailable` (a credential that is not per-user, that the caller may not use, or that takes a typed token), `disabled`, `rate-limited` (past 10 starts per person and credential in 10 minutes), `no-secret-key` (while `PIWI_SECRET_KEY` is unset) or `cross-site` (a request another site started).',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'returnTo', in: 'query', required: false, schema: { type: 'string' } },
    ],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const credentialId = parseRouteId(getRouterParam(event, 'id'));
  const returnTo = safeReturnPath(getQuery(event).returnTo);
  const base = useRuntimeConfig(event).app.baseURL;
  // A browser opened this window: every refusal lands on the return page, which says why.
  const refuse = (reason: AuthorizationFailure) =>
    sendRedirect(event, authorizedPagePath(base, { ok: false, credentialId, returnTo, reason }), 302);
  // The person's window starts it from a page of this site; another site never sends it to the host in their name.
  if (getHeader(event, 'sec-fetch-site') === 'cross-site') return refuse('cross-site');
  let route: Awaited<ReturnType<typeof requireUserTokenRoute>>;
  try {
    route = await requireUserTokenRoute(event);
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404) return refuse('unavailable');
    if (status === 400 || status === 401 || status === 403) return refuse('sign-in');
    throw e;
  }
  const { db, viewer, record, entry } = route;
  if (!entry.usable || entry.method !== 'oauth') return refuse('unavailable');
  if (entry.disabled) return refuse('disabled');
  // The token the host answers is saved encrypted: without the key, nobody is sent to the host.
  if (!canEncryptSecrets()) return refuse('no-secret-key');
  try {
    limitUserAuthorizations(event, viewer.userId, record.id);
  } catch {
    return refuse('rate-limited');
  }
  let url: string;
  try {
    url = await startUserAuthorization(db, record, viewer.userId, {
      redirectUri: `${publicBaseUrl(event)}${OAUTH_CALLBACK_PATH}`,
      returnTo,
    });
  } catch (e) {
    if (e instanceof CredentialRefusedError) return refuse('unavailable');
    throw e;
  }
  return sendRedirect(event, url, 302);
});
