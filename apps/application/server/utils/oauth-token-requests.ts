/**
 * The requests a per-user SCM credential sends to its host's OAuth endpoints:
 * a code or a refresh token exchanged for tokens, and a token revoked. The
 * client secret is handed in by `credentials.ts`, the one module that opens
 * it; nothing here reads a secret column. GitLab takes the client in the body,
 * Bitbucket in a Basic header. No redirect is followed, and a host's answer is
 * never shown: a failure says only whether the host refused or could not be
 * reached.
 */
import type { OAuthEndpoints } from '#shared/scm-urls';

/** How long a host has to answer a token request. */
const OAUTH_TIMEOUT_MS = 10_000;

/** An OAuth application, its secret opened for one request. */
export interface OAuthClient {
  id: string;
  secret: string;
}

/** The tokens a host answered: the access token, the refresh token, and when the access token expires (epoch ms). */
export interface OAuthTokens {
  access: string;
  refresh: string | null;
  expiresAt: number | null;
}

/**
 * A token request's outcome: the tokens, or why there are none: the host
 * refused the grant (a code or a refresh token it no longer takes), refused
 * the client (the OAuth application's id or secret), or could not be reached.
 */
export type OAuthTokenAnswer =
  | { ok: true; tokens: OAuthTokens }
  | { ok: false; reason: 'refused' | 'client' | 'unreachable' };

function clientRequest(endpoints: OAuthEndpoints, client: OAuthClient, params: Record<string, string>) {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'piwi-dashboard',
  };
  if (endpoints.host === 'bitbucket') {
    headers.Authorization = `Basic ${Buffer.from(`${client.id}:${client.secret}`, 'utf8').toString('base64')}`;
  } else {
    body.set('client_id', client.id);
    body.set('client_secret', client.secret);
  }
  return { headers, body: body.toString() };
}

/** Exchange a code (`grant_type: authorization_code`) or a refresh token (`refresh_token`) for tokens at the host. */
export async function requestOAuthTokens(
  endpoints: OAuthEndpoints,
  client: OAuthClient,
  params: Record<string, string>,
  now = Date.now(),
): Promise<OAuthTokenAnswer> {
  let res: Response;
  try {
    res = await fetch(endpoints.token, {
      method: 'POST',
      ...clientRequest(endpoints, client, params),
      redirect: 'manual',
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (res.status >= 500 || (res.status >= 300 && res.status < 400)) return { ok: false, reason: 'unreachable' };
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  const access = typeof json?.access_token === 'string' ? json.access_token : '';
  if (res.status === 401 || json?.error === 'invalid_client' || json?.error === 'unauthorized_client') {
    return { ok: false, reason: 'client' };
  }
  if (!res.ok || !access) return { ok: false, reason: 'refused' };
  const refresh = typeof json?.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null;
  const seconds = Number(json?.expires_in);
  return {
    ok: true,
    tokens: { access, refresh, expiresAt: Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : null },
  };
}

/** Revoke a token at a host that offers revocation; false when it does not, or did not answer that it did. */
export async function revokeOAuthToken(
  endpoints: OAuthEndpoints,
  client: OAuthClient,
  token: string,
): Promise<boolean> {
  if (!endpoints.revoke) return false;
  try {
    const res = await fetch(endpoints.revoke, {
      method: 'POST',
      ...clientRequest(endpoints, client, { token }),
      redirect: 'manual',
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
