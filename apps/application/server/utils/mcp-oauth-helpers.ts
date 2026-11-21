// Pure helpers of the OAuth 2.1 authorization server MCP clients sign in through
// (the MCP authorization specification): the metadata documents, redirect URI and
// resource checks, PKCE, and the `WWW-Authenticate` challenge. Free of h3 and
// database context so they can be unit-tested; `mcp-oauth.ts` owns the I/O.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { cleanClientLabel } from './client-label';
import { base64url } from './oauth-helpers';
import { timingSafeEqualStr } from './timing-safe';

/** The one scope a token carries: the MCP tools, with the user's role and project access. */
export const MCP_OAUTH_SCOPE = 'mcp';

export const CLIENT_ID_PREFIX = 'mcpc_';
export const CLIENT_SECRET_PREFIX = 'mcps_';
export const AUTHORIZATION_CODE_PREFIX = 'pda_';
export const ACCESS_TOKEN_PREFIX = 'pdo_';
export const REFRESH_TOKEN_PREFIX = 'pdr_';

/** How long the consent page waits for an answer. */
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
/** How long an issued code stays redeemable. */
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Each refresh starts the period again, so a client used at least monthly never signs in twice. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long a refresh token that was just exchanged still answers, with the
 * tokens it was exchanged for: two requests of one client refreshing at once,
 * or a retry after a lost response. Presented later, it ends the grant.
 */
export const REFRESH_GRACE_MS = 60 * 1000;
/** A registered client that has no grant and made no request for this long is deleted. */
export const IDLE_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Per client address and window. Failed consent-page lookups count per user, as for the extension connect page. */
export const MCP_OAUTH_RATE_LIMITS = {
  register: { limit: 20, windowMs: 10 * 60 * 1000 },
  authorize: { limit: 60, windowMs: 10 * 60 * 1000 },
  token: { limit: 120, windowMs: 10 * 60 * 1000 },
  lookupMiss: { limit: 20, windowMs: 10 * 60 * 1000 },
} as const;

// ---------------------------------------------------------------------------
// Endpoints and metadata
// ---------------------------------------------------------------------------

/** Every URL a client discovers, from the instance's public base URL. */
export function mcpOAuthUrls(baseUrl: string) {
  return {
    issuer: baseUrl,
    resource: `${baseUrl}/mcp`,
    resourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    authorization: `${baseUrl}/oauth/authorize`,
    token: `${baseUrl}/oauth/token`,
    registration: `${baseUrl}/oauth/register`,
    revocation: `${baseUrl}/oauth/revoke`,
  };
}

/** OAuth 2.0 Protected Resource Metadata (RFC 9728) of the MCP endpoint. */
export function protectedResourceMetadata(baseUrl: string) {
  const urls = mcpOAuthUrls(baseUrl);
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: [MCP_OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Piwi Dashboard MCP server',
  };
}

const CLIENT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414). `clientMetadataDocuments`
 * says whether a client may name its metadata document as its `client_id`.
 */
export function authorizationServerMetadata(baseUrl: string, opts: { clientMetadataDocuments?: boolean } = {}) {
  const urls = mcpOAuthUrls(baseUrl);
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorization,
    token_endpoint: urls.token,
    registration_endpoint: urls.registration,
    revocation_endpoint: urls.revocation,
    scopes_supported: [MCP_OAUTH_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    ...(opts.clientMetadataDocuments ? { client_id_metadata_document_supported: true } : {}),
  };
}

/**
 * The `WWW-Authenticate` value of a 401 from the MCP endpoint: where to find the
 * resource metadata (RFC 9728 §5.1), and, for a token that was presented but
 * refused, `invalid_token` (RFC 6750 §3.1) so the client refreshes it.
 */
export function mcpWwwAuthenticate(baseUrl: string, invalidToken?: string): string {
  const parts = [`resource_metadata="${mcpOAuthUrls(baseUrl).resourceMetadata}"`, `scope="${MCP_OAUTH_SCOPE}"`];
  if (invalidToken) parts.unshift('error="invalid_token"', `error_description="${invalidToken.replace(/"/g, "'")}"`);
  return `Bearer ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

const MAX_REDIRECT_URI_LENGTH = 2000;
const MAX_REDIRECT_URIS = 10;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/**
 * Schemes a browser runs or reads locally instead of handing them to an
 * application, and operating system handlers that open files or run programs
 * (Windows search, Android intents). Every `ms-` scheme (the troubleshooters,
 * Office, the settings) is refused too.
 */
const REFUSED_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
  'ws:',
  'wss:',
  'ftp:',
  'view-source:',
  'jar:',
  'mhtml:',
  'its:',
  'mk:',
  'res:',
  'shell:',
  'search:',
  'search-ms:',
  'intent:',
  'chrome:',
  'filesystem:',
  'mailto:',
  'tel:',
  'sms:',
]);

/**
 * Why a redirect URI cannot be registered, or null when it can: `https`, `http`
 * on a loopback host (RFC 8252 §7.3), or an application's own scheme such as
 * `cursor://` or `vscode://` (RFC 8252 §7.1). Never a fragment.
 */
export function redirectUriProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'a redirect URI must be a non-empty string';
  if (value.length > MAX_REDIRECT_URI_LENGTH) return `a redirect URI is at most ${MAX_REDIRECT_URI_LENGTH} characters`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${value} is not an absolute URI`;
  }
  if (url.hash || value.includes('#')) return `${value} has a fragment`;
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname) ? null : `${value} uses http on a host other than this computer`;
  }
  if (REFUSED_SCHEMES.has(url.protocol) || url.protocol.startsWith('ms-')) {
    return `${value} uses a scheme that cannot receive a code`;
  }
  return null;
}

/** The registered redirect URIs of a registration request, or why they cannot be registered. */
export function parseRedirectUris(value: unknown): { uris: string[] } | { problem: string } {
  if (!Array.isArray(value) || value.length === 0) return { problem: 'redirect_uris must be a non-empty array' };
  if (value.length > MAX_REDIRECT_URIS) return { problem: `at most ${MAX_REDIRECT_URIS} redirect URIs` };
  for (const uri of value) {
    const problem = redirectUriProblem(uri);
    if (problem) return { problem };
  }
  return { uris: [...new Set(value as string[])] };
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Whether a requested redirect URI is one the client registered: the same
 * string, or for a loopback `http` URI the same one on another port, since a
 * native client listens on whatever port is free (RFC 8252 §7.3).
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(want)) return false;
  return registered.some((uri) => {
    const have = new URL(uri);
    return (
      isLoopback(have) &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}

/** Where a decision sends the browser, for the consent page: a web site, this computer, or an application. */
export interface RedirectTarget {
  kind: 'web' | 'loopback' | 'app';
  /** The web site's host, or the application's scheme; empty for this computer. */
  label: string;
}

export function describeRedirectTarget(uri: string): RedirectTarget {
  const url = new URL(uri);
  if (isLoopback(url)) return { kind: 'loopback', label: '' };
  if (url.protocol === 'https:') return { kind: 'web', label: url.host };
  return { kind: 'app', label: url.protocol.replace(/:$/, '') };
}

/** `uri` with `params` added to its query, keeping what it already carries. */
export function withQueryParams(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Resource indicators (RFC 8707)
// ---------------------------------------------------------------------------

/**
 * Whether a client's `resource` names this instance's MCP endpoint: same
 * origin and path, a trailing slash aside. The query is ignored, since the
 * endpoint URL a client was given may carry `?modules=`.
 */
export function resourceMatches(resource: unknown, expected: string): boolean {
  if (typeof resource !== 'string') return false;
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return false;
  }
  if (url.hash) return false;
  const want = new URL(expected);
  const path = (p: string) => p.replace(/\/+$/, '');
  return url.origin === want.origin && path(url.pathname) === path(want.pathname);
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636), S256 only
// ---------------------------------------------------------------------------

const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export function isCodeChallenge(value: unknown): value is string {
  return typeof value === 'string' && CODE_CHALLENGE_RE.test(value);
}

export function pkceVerifies(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !CODE_VERIFIER_RE.test(verifier)) return false;
  return timingSafeEqualStr(base64url(createHash('sha256').update(verifier).digest()), challenge);
}

// ---------------------------------------------------------------------------
// The refresh grace period: the last response, sealed with the replaced token
// ---------------------------------------------------------------------------

/**
 * AES-256-GCM key derived from a refresh token. It is an HMAC, unlike the
 * plain SHA-256 stored as the token's hash, so the database holds nothing
 * that opens the sealed response: only the token itself does.
 */
function graceKey(refreshToken: string): Buffer {
  return createHmac('sha256', refreshToken).update('piwi-oauth-refresh-grace').digest();
}

/** `plaintext` sealed so that only `refreshToken` opens it: `iv.tag.ciphertext`, base64url. */
export function sealWithToken(refreshToken: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', graceKey(refreshToken), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(base64url).join('.');
}

/** What {@link sealWithToken} sealed, or null when `refreshToken` is not the one it was sealed with. */
export function openWithToken(refreshToken: string, sealed: string): string | null {
  const [iv, tag, ciphertext] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !ciphertext) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', graceKey(refreshToken), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Client registration and authentication
// ---------------------------------------------------------------------------

/** A self-asserted client name, as the consent page and the API key show it. */
export const cleanClientName = (value: unknown) => cleanClientLabel(value, 'MCP client', 60);

/** A registered `client_uri`, kept only when it is an `https` URL. */
export function cleanClientUri(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_REDIRECT_URI_LENGTH) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Why a client's `grant_types` and `response_types` cannot be served, or null:
 * the authorization code grant (with refresh tokens) and the `code` response
 * type alone. Absent, they default to those.
 */
export function clientTypesProblem(metadata: Record<string, unknown>): string | null {
  const grantTypes = metadata.grant_types ?? ['authorization_code'];
  if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code')) {
    return 'grant_types must include authorization_code';
  }
  if (grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    return 'only authorization_code and refresh_token are supported';
  }
  const responseTypes = metadata.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
    return 'only the code response type is supported';
  }
  return null;
}

/** Whether a registration asks for a client secret: any method but `none`. */
export function wantsClientSecret(method: unknown): boolean {
  return method === 'client_secret_post' || method === 'client_secret_basic';
}

export interface ClientCredentials {
  clientId: string | null;
  clientSecret: string | null;
  /** Whether they came in an `Authorization: Basic` header, which a refusal answers with a challenge. */
  basic: boolean;
}

/** The client's credentials from `Authorization: Basic` (RFC 6749 §2.3.1) or from the body. */
export function readClientCredentials(authorization: string | null | undefined, body: Record<string, unknown>) {
  const match = authorization?.match(/^Basic\s+(.+)$/i);
  if (match) {
    const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon > 0) {
      // RFC 6749 §2.3.1 form-encodes both values before joining them.
      const formDecode = (v: string) => {
        try {
          return decodeURIComponent(v.replace(/\+/g, ' '));
        } catch {
          return v;
        }
      };
      return {
        clientId: formDecode(decoded.slice(0, colon)),
        clientSecret: formDecode(decoded.slice(colon + 1)),
        basic: true,
      } satisfies ClientCredentials;
    }
  }
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    clientId: str(body.client_id),
    clientSecret: str(body.client_secret),
    basic: false,
  } satisfies ClientCredentials;
}
