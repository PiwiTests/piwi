import { randomBytes } from 'node:crypto';
import { and, eq, inArray, lt, ne, notExists, or } from 'drizzle-orm';
import type { H3Event } from 'h3';
import { apiKeys, oauthAuthorizationRequests, oauthClients, oauthGrants, users } from '../database/schema';
import type { OAuthClient, OAuthGrant, User } from '../database/schema';
import type { DbClient } from '../database';
import { generateApiKey, getUserAccessCached, isAuthEnabled, requireAuth } from './auth';
import { bearerToken } from './bearer';
import { getDatabase } from '../database';
import { publicBaseUrl } from './public-base-url';
import { timingSafeEqualStr } from './timing-safe';
import { hashToken } from './token-hash';
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_PREFIX,
  AUTHORIZATION_CODE_TTL_MS,
  AUTHORIZATION_REQUEST_TTL_MS,
  CLIENT_ID_PREFIX,
  CLIENT_SECRET_PREFIX,
  IDLE_CLIENT_TTL_MS,
  MCP_OAUTH_SCOPE,
  REFRESH_TOKEN_PREFIX,
  REFRESH_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
  cleanClientName,
  cleanClientUri,
  describeRedirectTarget,
  isCodeChallenge,
  mcpOAuthUrls,
  parseRedirectUris,
  pkceVerifies,
  redirectUriMatches,
  resourceMatches,
  wantsClientSecret,
  withQueryParams,
  mcpWwwAuthenticate,
  openWithToken,
  sealWithToken,
  type ClientCredentials,
  type RedirectTarget,
} from './mcp-oauth-helpers';

/**
 * The OAuth 2.1 authorization server MCP clients sign in through, as the MCP
 * authorization specification describes it: dynamic client registration
 * (RFC 7591), the authorization code flow with PKCE, and short-lived access
 * tokens renewed with rotating refresh tokens. The user answers on the consent
 * page of this instance, signed in as usual. Each grant owns an API key row
 * named after the client, which is what carries the user's access, what the
 * agents' write log names and what the user revokes. Codes, tokens and client
 * secrets are stored as SHA-256 hashes; the one copy of a token response, kept
 * for the refresh grace period, is sealed with a key only the replaced refresh
 * token derives. Access tokens authenticate the MCP endpoint and nothing else.
 */

/** Expired authorization requests older than this are deleted by {@link pruneMcpOAuth}. */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
/** The longest `state` an authorization request may carry. */
const MAX_STATE_LENGTH = 2000;
/** `last_used_at` of the grant's API key is written at most this often. */
const LAST_USED_WRITE_INTERVAL_MS = 60 * 60 * 1000;

const randomToken = (prefix: string) => `${prefix}${randomBytes(32).toString('hex')}`;

/** An OAuth error answer (RFC 6749 §5.2): the code a client branches on and a sentence for its logs. */
export interface OAuthError {
  status: 400 | 401;
  error: string;
  description: string;
}

const oauthError = (error: string, description: string, status: 400 | 401 = 400): OAuthError => ({
  status,
  error,
  description,
});

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

export interface ClientRegistration {
  client_id: string;
  client_id_issued_at: number;
  client_secret?: string;
  client_secret_expires_at?: number;
  client_name: string;
  client_uri?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
}

/**
 * Registers a client, after {@link pruneMcpOAuth}: registration is open to
 * anyone, so it is what keeps the client table bounded. A client that asks
 * for `client_secret_post` or `client_secret_basic` receives a secret; any
 * other is public.
 */
export async function registerClient(
  db: DbClient,
  metadata: Record<string, unknown>,
  now = new Date(),
): Promise<ClientRegistration | OAuthError> {
  const redirect = parseRedirectUris(metadata.redirect_uris);
  if ('problem' in redirect) return oauthError('invalid_redirect_uri', redirect.problem);
  const grantTypes = metadata.grant_types ?? ['authorization_code'];
  if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code')) {
    return oauthError('invalid_client_metadata', 'grant_types must include authorization_code');
  }
  if (grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    return oauthError('invalid_client_metadata', 'only authorization_code and refresh_token are supported');
  }
  const responseTypes = metadata.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
    return oauthError('invalid_client_metadata', 'only the code response type is supported');
  }

  await pruneMcpOAuth(db, now);

  const clientId = `${CLIENT_ID_PREFIX}${randomBytes(16).toString('hex')}`;
  const secret = wantsClientSecret(metadata.token_endpoint_auth_method) ? randomToken(CLIENT_SECRET_PREFIX) : null;
  const clientName = cleanClientName(metadata.client_name);
  const clientUri = cleanClientUri(metadata.client_uri);
  await db.insert(oauthClients).values({
    clientId,
    clientSecretHash: secret ? hashToken(secret) : null,
    clientName,
    clientUri,
    redirectUris: redirect.uris,
    createdAt: now,
    lastUsedAt: now,
  });

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: clientName,
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: redirect.uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: secret ? (metadata.token_endpoint_auth_method as string) : 'none',
    scope: MCP_OAUTH_SCOPE,
  };
}

async function findClient(db: DbClient, clientId: unknown): Promise<OAuthClient | null> {
  if (typeof clientId !== 'string' || !clientId.startsWith(CLIENT_ID_PREFIX)) return null;
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  return client ?? null;
}

/**
 * The client a token or revocation request comes from, or why it is refused:
 * an unknown client, or a confidential one without its secret.
 */
async function authenticateClient(db: DbClient, creds: ClientCredentials): Promise<OAuthClient | OAuthError> {
  const client = await findClient(db, creds.clientId);
  if (!client) return oauthError('invalid_client', 'Unknown client; register again', 401);
  if (client.clientSecretHash) {
    if (!creds.clientSecret || !timingSafeEqualStr(hashToken(creds.clientSecret), client.clientSecretHash)) {
      return oauthError('invalid_client', 'Client authentication failed', 401);
    }
  }
  return client;
}

async function touchClient(db: DbClient, client: OAuthClient, now: Date): Promise<void> {
  await db.update(oauthClients).set({ lastUsedAt: now }).where(eq(oauthClients.id, client.id));
}

// ---------------------------------------------------------------------------
// Authorization request and consent
// ---------------------------------------------------------------------------

/** Why the authorize endpoint refuses a request; the consent page explains each one. */
export type AuthorizationStartError =
  | 'invalid_client'
  | 'invalid_redirect_uri'
  | 'unsupported_response_type'
  | 'invalid_request'
  | 'invalid_target';

/** What the authorize endpoint does with a request. */
export type AuthorizationStart =
  /** Ask the user: send the browser to the consent page with this request id. */
  | { kind: 'consent'; requestId: string }
  /** Show the error on the consent page. */
  | { kind: 'refused'; error: AuthorizationStartError };

/**
 * Checks an authorization request (RFC 6749 §4.1.1, PKCE required) and stores
 * it for the consent page. A request it refuses is never sent back to the
 * client's redirect URI: anyone can register one, so redirecting there before
 * the user answers would turn this instance into an open redirector
 * (RFC 9700 §4.11.2). The consent page shows the error instead.
 */
export async function startAuthorization(
  db: DbClient,
  query: Record<string, unknown>,
  baseUrl: string,
  now = new Date(),
): Promise<AuthorizationStart> {
  const client = await findClient(db, query.client_id);
  if (!client) return { kind: 'refused', error: 'invalid_client' };
  const requested = typeof query.redirect_uri === 'string' ? query.redirect_uri : null;
  const redirectUri = requested ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return { kind: 'refused', error: 'invalid_redirect_uri' };
  }

  const urls = mcpOAuthUrls(baseUrl);
  const refuse = (error: AuthorizationStartError): AuthorizationStart => ({ kind: 'refused', error });
  // The state goes back unchanged, so one too long to store is refused rather than cut.
  const state = typeof query.state === 'string' ? query.state : null;
  if (state !== null && state.length > MAX_STATE_LENGTH) return refuse('invalid_request');
  if (query.response_type !== 'code') return refuse('unsupported_response_type');
  if (query.code_challenge_method !== 'S256' || !isCodeChallenge(query.code_challenge)) {
    return refuse('invalid_request');
  }
  if (query.resource !== undefined && !resourceMatches(query.resource, urls.resource)) return refuse('invalid_target');

  const requestId = randomBytes(32).toString('hex');
  await db.insert(oauthAuthorizationRequests).values({
    requestIdHash: hashToken(requestId),
    clientId: client.id,
    redirectUri,
    state,
    codeChallenge: query.code_challenge,
    scope: MCP_OAUTH_SCOPE,
    resource: urls.resource,
    status: 'pending',
    expiresAt: new Date(now.getTime() + AUTHORIZATION_REQUEST_TTL_MS),
    createdAt: now,
  });
  await touchClient(db, client, now);
  return { kind: 'consent', requestId };
}

/**
 * Deletes what can no longer be used: authorization requests expired for more
 * than a day, grants whose refresh token expired (with their API keys, so the
 * connection leaves the user's list), and clients idle for
 * {@link IDLE_CLIENT_TTL_MS} with no grant. Runs at each registration and in
 * the nightly retention sweep. Returns how many grants it ended.
 */
export async function pruneMcpOAuth(db: DbClient, now = new Date()): Promise<number> {
  await db
    .delete(oauthAuthorizationRequests)
    .where(lt(oauthAuthorizationRequests.expiresAt, new Date(now.getTime() - PRUNE_AFTER_MS)));
  // Deleting the API key deletes its grant.
  const ended = await db
    .delete(apiKeys)
    .where(
      inArray(
        apiKeys.id,
        db.select({ id: oauthGrants.apiKeyId }).from(oauthGrants).where(lt(oauthGrants.refreshExpiresAt, now)),
      ),
    )
    .returning({ id: apiKeys.id });
  await db
    .delete(oauthClients)
    .where(
      and(
        lt(oauthClients.lastUsedAt, new Date(now.getTime() - IDLE_CLIENT_TTL_MS)),
        notExists(db.select({ id: oauthGrants.id }).from(oauthGrants).where(eq(oauthGrants.clientId, oauthClients.id))),
      ),
    );
  return ended.length;
}

export type AuthorizationStatus = 'pending' | 'approved' | 'denied' | 'consumed';

export interface AuthorizationRequestView {
  /** What the client calls itself: self-asserted at registration. */
  clientName: string;
  clientUri: string | null;
  /** Where the answer goes. */
  redirect: RedirectTarget;
  createdAt: string;
  expiresAt: string;
  /** `expired` once past its expiry without an answer; `consumed` once the client redeemed its code. */
  status: AuthorizationStatus | 'expired';
}

async function findRequest(db: DbClient, requestId: unknown) {
  if (typeof requestId !== 'string' || !/^[0-9a-f]{64}$/.test(requestId)) return null;
  const [row] = await db
    .select({ request: oauthAuthorizationRequests, client: oauthClients })
    .from(oauthAuthorizationRequests)
    .innerJoin(oauthClients, eq(oauthAuthorizationRequests.clientId, oauthClients.id))
    .where(eq(oauthAuthorizationRequests.requestIdHash, hashToken(requestId)));
  return row ?? null;
}

/** What the consent page shows for a request id; null when no request has it. */
export async function describeAuthorization(
  db: DbClient,
  requestId: unknown,
  now = new Date(),
): Promise<AuthorizationRequestView | null> {
  const row = await findRequest(db, requestId);
  if (!row) return null;
  const status = row.request.status as AuthorizationStatus;
  const expired = status === 'pending' && row.request.expiresAt.getTime() <= now.getTime();
  return {
    clientName: row.client.clientName,
    clientUri: row.client.clientUri,
    redirect: describeRedirectTarget(row.request.redirectUri),
    createdAt: row.request.createdAt.toISOString(),
    expiresAt: row.request.expiresAt.toISOString(),
    status: expired ? 'expired' : status,
  };
}

export type AuthorizationDecision =
  | { status: 'approved' | 'denied'; redirectTo: string }
  | { status: 'not-found' | 'expired' | 'already-decided' };

/**
 * Records the signed-in user's answer and returns where to send the browser:
 * the client's redirect URI with a code, or with `access_denied`.
 */
export async function decideAuthorization(
  db: DbClient,
  opts: { requestId: unknown; userId: number; allow: boolean },
  baseUrl: string,
  now = new Date(),
): Promise<AuthorizationDecision> {
  const row = await findRequest(db, opts.requestId);
  if (!row) return { status: 'not-found' };
  const { request } = row;
  if (request.status !== 'pending') return { status: 'already-decided' };
  if (request.expiresAt.getTime() <= now.getTime()) return { status: 'expired' };

  const code = opts.allow ? randomToken(AUTHORIZATION_CODE_PREFIX) : null;
  const updated = await db
    .update(oauthAuthorizationRequests)
    .set({
      status: opts.allow ? 'approved' : 'denied',
      userId: opts.userId,
      decidedAt: now,
      ...(code ? { codeHash: hashToken(code), expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS) } : {}),
    })
    .where(and(eq(oauthAuthorizationRequests.id, request.id), eq(oauthAuthorizationRequests.status, 'pending')))
    .returning({ id: oauthAuthorizationRequests.id });
  if (updated.length === 0) return { status: 'already-decided' };

  const iss = mcpOAuthUrls(baseUrl).issuer;
  return code
    ? { status: 'approved', redirectTo: withQueryParams(request.redirectUri, { code, state: request.state, iss }) }
    : {
        status: 'denied',
        redirectTo: withQueryParams(request.redirectUri, {
          error: 'access_denied',
          error_description: 'The user denied access',
          state: request.state,
          iss,
        }),
      };
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function newTokens(now: Date) {
  const accessToken = randomToken(ACCESS_TOKEN_PREFIX);
  const refreshToken = randomToken(REFRESH_TOKEN_PREFIX);
  return {
    columns: {
      accessTokenHash: hashToken(accessToken),
      accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
      refreshTokenHash: hashToken(refreshToken),
      refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    },
    body: (scope: string): TokenResponse => ({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.round(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope,
    }),
  };
}

/** Revokes a grant by deleting its API key, which deletes the grant with it. */
async function revokeGrant(db: DbClient, grantId: number): Promise<void> {
  await db
    .delete(apiKeys)
    .where(
      inArray(apiKeys.id, db.select({ id: oauthGrants.apiKeyId }).from(oauthGrants).where(eq(oauthGrants.id, grantId))),
    );
}

/** The token endpoint (RFC 6749 §3.2): redeems a code, or renews a grant's tokens with its refresh token. */
export async function exchangeToken(
  db: DbClient,
  params: Record<string, unknown>,
  creds: ClientCredentials,
  baseUrl: string,
  now = new Date(),
): Promise<TokenResponse | OAuthError> {
  const client = await authenticateClient(db, creds);
  if ('error' in client) return client;
  await touchClient(db, client, now);
  if (params.grant_type === 'authorization_code') return redeemCode(db, client, params, baseUrl, now);
  if (params.grant_type === 'refresh_token') return refreshGrant(db, client, params, now);
  return oauthError('unsupported_grant_type', 'Supported: authorization_code, refresh_token');
}

async function redeemCode(
  db: DbClient,
  client: OAuthClient,
  params: Record<string, unknown>,
  baseUrl: string,
  now: Date,
): Promise<TokenResponse | OAuthError> {
  const invalid = oauthError('invalid_grant', 'The authorization code is invalid, expired or already used');
  if (typeof params.code !== 'string' || !params.code.startsWith(AUTHORIZATION_CODE_PREFIX)) return invalid;
  const [request] = await db
    .select()
    .from(oauthAuthorizationRequests)
    .where(eq(oauthAuthorizationRequests.codeHash, hashToken(params.code)));
  if (!request || request.clientId !== client.id) return invalid;
  // A code presented twice was intercepted, or replayed: the grant it created goes too (RFC 6749 §4.1.2).
  if (request.status === 'consumed') {
    if (request.grantId != null) await revokeGrant(db, request.grantId);
    return invalid;
  }
  if (request.status !== 'approved' || request.userId == null) return invalid;
  if (request.expiresAt.getTime() <= now.getTime()) return invalid;
  if (params.redirect_uri !== undefined && params.redirect_uri !== request.redirectUri) {
    return oauthError('invalid_grant', 'redirect_uri differs from the authorization request');
  }
  if (!pkceVerifies(params.code_verifier, request.codeChallenge)) {
    return oauthError('invalid_grant', 'code_verifier does not match the code_challenge');
  }
  if (params.resource !== undefined && !resourceMatches(params.resource, request.resource)) {
    return oauthError('invalid_target', `This server issues tokens for ${mcpOAuthUrls(baseUrl).resource} only`);
  }

  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.id, request.userId));
  if (!owner) return invalid;

  // The grant is created first and the code claimed with it in one conditional
  // update, so a code presented again always finds the grant to revoke. The
  // grant's API key names the client and carries the user's access; its own
  // value is never handed out.
  const key = generateApiKey();
  const [apiKey] = await db
    .insert(apiKeys)
    .values({ userId: owner.id, name: client.clientName, keyHash: key.hash, keyPrefix: key.prefix, createdAt: now })
    .returning({ id: apiKeys.id });
  const dropKey = () => db.delete(apiKeys).where(eq(apiKeys.id, apiKey!.id));
  const tokens = newTokens(now);
  let grantId: number;
  try {
    const [grant] = await db
      .insert(oauthGrants)
      .values({
        clientId: client.id,
        userId: owner.id,
        apiKeyId: apiKey!.id,
        scope: request.scope,
        resource: request.resource,
        ...tokens.columns,
        createdAt: now,
      })
      .returning({ id: oauthGrants.id });
    grantId = grant!.id;
  } catch (err) {
    await dropKey();
    throw err;
  }
  const claimed = await db
    .update(oauthAuthorizationRequests)
    .set({ status: 'consumed', grantId })
    .where(and(eq(oauthAuthorizationRequests.id, request.id), eq(oauthAuthorizationRequests.status, 'approved')))
    .returning({ id: oauthAuthorizationRequests.id });
  if (claimed.length === 0) {
    // Another request redeemed the code first.
    await dropKey();
    return invalid;
  }

  // Signing in again replaces this client's earlier connection for the user.
  await db.delete(apiKeys).where(
    inArray(
      apiKeys.id,
      db
        .select({ id: oauthGrants.apiKeyId })
        .from(oauthGrants)
        .where(and(eq(oauthGrants.clientId, client.id), eq(oauthGrants.userId, owner.id), ne(oauthGrants.id, grantId))),
    ),
  );
  return tokens.body(request.scope);
}

/**
 * The response a refresh token already exchanged still gets during
 * {@link REFRESH_GRACE_MS}: the tokens it was exchanged for, opened from the
 * sealed copy only that token opens. Null once the period is over.
 */
function graceResponse(grant: OAuthGrant, refreshToken: string, now: Date): TokenResponse | null {
  if (!grant.previousTokenResponse || !grant.refreshedAt) return null;
  if (now.getTime() - grant.refreshedAt.getTime() > REFRESH_GRACE_MS) return null;
  const opened = openWithToken(refreshToken, grant.previousTokenResponse);
  if (!opened) return null;
  const { access_token, refresh_token } = JSON.parse(opened) as { access_token: string; refresh_token: string };
  return {
    access_token,
    token_type: 'Bearer',
    expires_in: Math.max(0, Math.round((grant.accessExpiresAt.getTime() - now.getTime()) / 1000)),
    refresh_token,
    scope: grant.scope,
  };
}

async function refreshGrant(
  db: DbClient,
  client: OAuthClient,
  params: Record<string, unknown>,
  now: Date,
): Promise<TokenResponse | OAuthError> {
  const invalid = oauthError('invalid_grant', 'The refresh token is invalid, expired or revoked');
  const token = params.refresh_token;
  if (typeof token !== 'string' || !token.startsWith(REFRESH_TOKEN_PREFIX)) return invalid;
  const hash = hashToken(token);
  const [grant] = await db
    .select()
    .from(oauthGrants)
    .where(or(eq(oauthGrants.refreshTokenHash, hash), eq(oauthGrants.previousRefreshTokenHash, hash)));
  if (!grant || grant.clientId !== client.id) return invalid;
  if (grant.refreshTokenHash !== hash) {
    // The token was exchanged a moment ago (two requests refreshing at once, or a
    // lost response): answer as that exchange did. Later, it was copied, and the
    // grant ends for whoever holds it (OAuth 2.1 §4.3.1).
    const replay = graceResponse(grant, token, now);
    if (replay) return replay;
    await revokeGrant(db, grant.id);
    return invalid;
  }
  if (grant.refreshExpiresAt.getTime() <= now.getTime()) {
    await revokeGrant(db, grant.id);
    return invalid;
  }

  const tokens = newTokens(now);
  const body = tokens.body(grant.scope);
  const sealed = sealWithToken(
    token,
    JSON.stringify({ access_token: body.access_token, refresh_token: body.refresh_token }),
  );
  const rotated = await db
    .update(oauthGrants)
    .set({ ...tokens.columns, previousRefreshTokenHash: hash, previousTokenResponse: sealed, refreshedAt: now })
    .where(and(eq(oauthGrants.id, grant.id), eq(oauthGrants.refreshTokenHash, hash)))
    .returning({ id: oauthGrants.id });
  if (rotated.length > 0) return body;
  // Another request exchanged the same token between the read and the update.
  const [current] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, grant.id));
  return (current?.previousRefreshTokenHash === hash ? graceResponse(current, token, now) : null) ?? invalid;
}

/**
 * Token revocation (RFC 7009): a client's access or refresh token ends its
 * grant. Unknown tokens, and tokens of another client, are ignored.
 */
export async function revokeToken(db: DbClient, token: unknown, creds: ClientCredentials): Promise<OAuthError | null> {
  const client = await authenticateClient(db, creds);
  if ('error' in client) return client;
  if (typeof token !== 'string' || token.length === 0) {
    return oauthError('invalid_request', 'token is required');
  }
  const hash = hashToken(token);
  const [grant] = await db
    .select({ id: oauthGrants.id, clientId: oauthGrants.clientId })
    .from(oauthGrants)
    .where(or(eq(oauthGrants.accessTokenHash, hash), eq(oauthGrants.refreshTokenHash, hash)));
  if (grant && grant.clientId === client.id) await revokeGrant(db, grant.id);
  return null;
}

// ---------------------------------------------------------------------------
// Access tokens on the MCP endpoint
// ---------------------------------------------------------------------------

/** Whether a Bearer value is an OAuth access token of this server (rather than an API key). */
export function isOAuthAccessToken(token: string | null | undefined): token is string {
  return !!token?.startsWith(ACCESS_TOKEN_PREFIX);
}

/**
 * The user and the grant's API key behind an access token, or null when it is
 * unknown, expired or revoked. Writes the key's `last_used_at` at most hourly,
 * as an API key's own use does.
 */
export async function resolveOAuthAccessToken(
  db: DbClient,
  token: string,
  now = new Date(),
): Promise<{ user: User; keyId: number } | null> {
  if (!isOAuthAccessToken(token)) return null;
  const [row] = await db
    .select({ grant: oauthGrants, user: users, keyLastUsedAt: apiKeys.lastUsedAt })
    .from(oauthGrants)
    .innerJoin(users, eq(oauthGrants.userId, users.id))
    .innerJoin(apiKeys, eq(oauthGrants.apiKeyId, apiKeys.id))
    .where(eq(oauthGrants.accessTokenHash, hashToken(token)));
  if (!row || row.grant.accessExpiresAt.getTime() <= now.getTime()) return null;
  if (!row.keyLastUsedAt || now.getTime() - row.keyLastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.grant.apiKeyId));
  }
  return { user: row.user, keyId: row.grant.apiKeyId };
}

/**
 * Authenticates a request to the MCP endpoint: an OAuth access token, or what
 * `requireAuth` accepts (an API key, a session). Every 401 carries the
 * `WWW-Authenticate` challenge that points an MCP client at the resource
 * metadata, which is how a client finds out it can sign in.
 */
export async function requireMcpAuth(event: H3Event): Promise<User> {
  if (!isAuthEnabled(event)) return requireAuth(event);
  const token = bearerToken(event);
  if (isOAuthAccessToken(token)) {
    const db = await getDatabase();
    const resolved = await resolveOAuthAccessToken(db, token);
    if (!resolved) {
      setResponseHeader(
        event,
        'WWW-Authenticate',
        mcpWwwAuthenticate(publicBaseUrl(event), 'The access token is invalid or expired'),
      );
      throw apiError({ statusCode: 401, message: 'Invalid or expired access token' });
    }
    event.context.apiKeyId = resolved.keyId;
    event.context.access = await getUserAccessCached(db, resolved.user);
    return resolved.user;
  }
  try {
    return await requireAuth(event);
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode === 401) {
      setResponseHeader(event, 'WWW-Authenticate', mcpWwwAuthenticate(publicBaseUrl(event)));
    }
    throw err;
  }
}

/** 404 when authentication is off: every MCP request is then accepted without a token, so there is nothing to sign in to. */
export function requireMcpOAuthEnabled(event: H3Event): void {
  if (!isAuthEnabled(event)) {
    throw apiError({
      statusCode: 404,
      message: 'Authentication is off on this instance; the MCP server needs no token',
    });
  }
}

/**
 * Answers an OAuth error as RFC 6749 §5.2 shapes it, `{ error, error_description }`,
 * with a `Basic` challenge when the client authenticated through that header.
 */
export function sendOAuthError(event: H3Event, err: OAuthError, basic = false) {
  setResponseStatus(event, err.status);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  if (err.status === 401 && basic) setResponseHeader(event, 'WWW-Authenticate', 'Basic realm="piwi"');
  return { error: err.error, error_description: err.description };
}

/** A token or revocation request's parameters: form-encoded, as RFC 6749 asks, or JSON. */
export async function readOAuthParams(event: H3Event): Promise<Record<string, unknown>> {
  const body = await readBody(event).catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
