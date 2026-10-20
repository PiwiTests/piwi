import { publicBaseUrl } from './public-base-url';
import type { H3Event } from 'h3';
import { apiError } from './api-error';
import { getDatabase } from '../database';
import { users } from '../database/schema';
import { eq, and, inArray } from 'drizzle-orm';
import type { DrizzleDB } from '#shared/handlers/db';
import { findUserByEmail } from '#shared/handlers/users';
import { setUserSession, isAuthEnabled, getCurrentUser } from './auth';
import type { SessionData } from './auth';
import type { User } from '../database/schema';
import {
  safeReturnPath,
  generateState,
  generateCodeVerifier,
  codeChallengeS256,
  buildRedirectUri,
  parseAllowList,
  isEmailDomainAllowed,
  isGoogleEmailVerified,
  isOrgAllowed,
  resolveProvisioningAction,
  resolveLinkAction,
  resolveUnlink,
  validEmailAddress,
  firstFreeUsername,
  type OAuthProfile,
} from './oauth-helpers';

// ---------------------------------------------------------------------------
// Provider configurations
// ---------------------------------------------------------------------------

/** A provider's profile, as read from its user info endpoint. */
interface ProviderUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  avatar: string;
  login?: string;
}

interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  // Whether the provider supports Authorization Code flow with PKCE. Google
  // does; GitHub OAuth Apps do not, so we only attach a PKCE challenge when the
  // provider can verify it.
  pkce: boolean;
  extraParams?: Record<string, string>;
  mapUser: (raw: Record<string, unknown>) => ProviderUser;
}

function getProviderConfig(event: H3Event, provider: string): OAuthProviderConfig | null {
  const config = useRuntimeConfig(event).oauth as unknown as
    | Record<string, { clientId?: string; clientSecret?: string } | string | undefined>
    | undefined;
  const providerConfig = config?.[provider];
  if (
    !providerConfig ||
    typeof providerConfig === 'string' ||
    !providerConfig.clientId ||
    !providerConfig.clientSecret
  ) {
    return null;
  }

  switch (provider) {
    case 'google': {
      return {
        clientId: providerConfig.clientId,
        clientSecret: providerConfig.clientSecret,
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
        scopes: ['openid', 'email', 'profile'],
        pkce: true,
        extraParams: { access_type: 'offline', prompt: 'consent' },
        mapUser: (raw) => ({
          id: String(raw.id),
          email: String(raw.email ?? ''),
          emailVerified: isGoogleEmailVerified(raw),
          name: String(raw.name ?? raw.email ?? ''),
          avatar: String(raw.picture ?? ''),
        }),
      };
    }
    case 'github': {
      return {
        clientId: providerConfig.clientId,
        clientSecret: providerConfig.clientSecret,
        authorizationUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userInfoUrl: 'https://api.github.com/user',
        scopes: ['read:user', 'user:email'],
        pkce: false,
        mapUser: (raw) => ({
          id: String(raw.id),
          email: typeof raw.email === 'string' ? raw.email : '',
          emailVerified: false, // Overridden by /user/emails call in fetchProviderUser
          name: String(raw.name ?? raw.login ?? ''),
          avatar: String(raw.avatar_url ?? ''),
          login: typeof raw.login === 'string' ? raw.login : undefined,
        }),
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Access-control allowlists (optional, from runtime config)
// ---------------------------------------------------------------------------

function getAllowedEmailDomains(event: H3Event): string[] {
  return parseAllowList((useRuntimeConfig(event).oauth as { allowedDomains?: string })?.allowedDomains);
}

function getGithubAllowedOrgs(event: H3Event): string[] {
  return parseAllowList((useRuntimeConfig(event).oauth as { githubAllowedOrgs?: string })?.githubAllowedOrgs);
}

// ---------------------------------------------------------------------------
// Ephemeral cookie helpers (state, PKCE verifier, link intent)
// ---------------------------------------------------------------------------

const STATE_COOKIE = 'oauth_state';
const VERIFIER_COOKIE = 'oauth_verifier';
const LINK_COOKIE = 'oauth_link';
const RETURN_COOKIE = 'oauth_return';
const STATE_EXPIRY_SEC = 600; // 10 minutes

function ephemeralCookieOptions(event: H3Event) {
  const url = getRequestURL(event);
  return {
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: STATE_EXPIRY_SEC,
  };
}

function setEphemeralCookie(event: H3Event, name: string, value: string): void {
  setCookie(event, name, value ?? '', ephemeralCookieOptions(event));
}

function clearEphemeralCookie(event: H3Event, name: string): void {
  deleteCookie(event, name, { path: '/' });
}

// ---------------------------------------------------------------------------
// Build redirect URI for the callback
// ---------------------------------------------------------------------------

/**
 * Public base URL of this instance. Prefers PIWI_SITE_URL so the redirect_uri
 * stays stable and matches the value registered with the provider even when the
 * app sits behind a reverse proxy (where the request Host/proto can differ).
 * Falls back to the request URL when PIWI_SITE_URL is unset.
 */
function getRedirectUri(event: H3Event, provider: string): string {
  const base = publicBaseUrl(event);
  return buildRedirectUri(base, provider);
}

// ---------------------------------------------------------------------------
// Initiate OAuth: generate state (+ PKCE), set cookies, return redirect URL
// ---------------------------------------------------------------------------

export function initiateOAuth(
  event: H3Event,
  provider: string,
  opts: { link?: boolean; returnTo?: string | null } = {},
): string | null {
  if (!isAuthEnabled(event)) {
    return null;
  }

  const providerCfg = getProviderConfig(event, provider);
  if (!providerCfg) {
    return null;
  }

  const state = generateState();
  setEphemeralCookie(event, STATE_COOKIE, state);

  // Request org scope only when a GitHub org allowlist is configured.
  const scopes = [...providerCfg.scopes];
  if (provider === 'github' && getGithubAllowedOrgs(event).length > 0 && !scopes.includes('read:org')) {
    scopes.push('read:org');
  }

  const params = new URLSearchParams({
    client_id: providerCfg.clientId,
    redirect_uri: getRedirectUri(event, provider),
    response_type: 'code',
    scope: scopes.join(' '),
    state,
  });

  // PKCE (RFC 7636): bind the authorization request to a server-held secret so a
  // stolen authorization code cannot be redeemed without the verifier.
  if (providerCfg.pkce) {
    const verifier = generateCodeVerifier();
    setEphemeralCookie(event, VERIFIER_COOKIE, verifier);
    params.set('code_challenge', codeChallengeS256(verifier));
    params.set('code_challenge_method', 'S256');
  } else {
    clearEphemeralCookie(event, VERIFIER_COOKIE);
  }

  // Link intent: connect this provider to the already-signed-in user rather than
  // signing in / creating an account.
  if (opts.link) {
    setEphemeralCookie(event, LINK_COOKIE, '1');
  } else {
    clearEphemeralCookie(event, LINK_COOKIE);
  }

  // Where a sign-in lands afterwards: a same-origin path, such as the browser
  // extension's connect page that sent the user to sign in.
  const returnTo = safeReturnPath(opts.returnTo);
  if (returnTo && !opts.link) {
    setEphemeralCookie(event, RETURN_COOKIE, returnTo);
  } else {
    clearEphemeralCookie(event, RETURN_COOKIE);
  }

  if (providerCfg.extraParams) {
    for (const [key, value] of Object.entries(providerCfg.extraParams)) {
      params.set(key, value);
    }
  }

  return `${providerCfg.authorizationUrl}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Exchange authorization code for access token
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

async function exchangeCode(
  event: H3Event,
  provider: string,
  code: string,
  codeVerifier?: string,
): Promise<TokenResponse> {
  const providerCfg = getProviderConfig(event, provider);
  if (!providerCfg) {
    throw apiError({ statusCode: 400, message: `Unknown OAuth provider: ${provider}` });
  }

  const body = new URLSearchParams({
    client_id: providerCfg.clientId,
    client_secret: providerCfg.clientSecret,
    code,
    redirect_uri: getRedirectUri(event, provider),
    grant_type: 'authorization_code',
  });

  // Only send the verifier for providers we issued a challenge to.
  if (providerCfg.pkce && codeVerifier) {
    body.set('code_verifier', codeVerifier);
  }

  const res = await fetch(providerCfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw apiError({ statusCode: 502, message: `Token exchange failed: ${res.status} ${text}` });
  }

  return res.json() as Promise<TokenResponse>;
}

// ---------------------------------------------------------------------------
// Fetch user info from the provider
// ---------------------------------------------------------------------------

async function fetchProviderUser(event: H3Event, provider: string, accessToken: string): Promise<ProviderUser> {
  const providerCfg = getProviderConfig(event, provider);
  if (!providerCfg) {
    throw apiError({ statusCode: 400, message: `Unknown OAuth provider: ${provider}` });
  }

  const res = await fetch(providerCfg.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw apiError({ statusCode: 502, message: `Failed to fetch user info: ${res.status} ${text}` });
  }

  const raw = (await res.json()) as Record<string, unknown>;
  const user = providerCfg.mapUser(raw);

  // For GitHub, the primary user info endpoint may return an unverified public email.
  // Fetch the verified emails list from /user/emails and use the primary verified one.
  if (provider === 'github') {
    try {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
        const primaryVerified = emails.find((e) => e.primary && e.verified);
        if (primaryVerified) {
          user.email = primaryVerified.email;
          user.emailVerified = true;
        } else {
          user.emailVerified = false;
        }
      }
    } catch {
      // Fall back to the public email from the user info endpoint
    }
  }

  return user;
}

// ---------------------------------------------------------------------------
// Allowlist enforcement (email domain + GitHub org)
// ---------------------------------------------------------------------------

async function fetchGithubOrgLogins(accessToken: string): Promise<string[]> {
  try {
    const res = await fetch('https://api.github.com/user/orgs', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      return [];
    }
    const orgs = (await res.json()) as Array<{ login: string }>;
    return orgs.map((o) => String(o.login).toLowerCase());
  } catch {
    return [];
  }
}

async function enforceAllowlists(
  event: H3Event,
  provider: string,
  providerUser: { email: string; emailVerified: boolean },
  accessToken: string,
): Promise<void> {
  const allowedDomains = getAllowedEmailDomains(event);
  if (!isEmailDomainAllowed(providerUser.email, providerUser.emailVerified, allowedDomains)) {
    throw apiError({
      statusCode: 403,
      data: { oauthError: 'domain-not-allowed' },
      message: 'A verified email in an allowed domain is required to sign in.',
    });
  }

  if (provider === 'github') {
    const allowedOrgs = getGithubAllowedOrgs(event);
    if (allowedOrgs.length > 0) {
      const memberOf = await fetchGithubOrgLogins(accessToken);
      if (!isOrgAllowed(memberOf, allowedOrgs)) {
        throw apiError({
          statusCode: 403,
          data: { oauthError: 'org-not-allowed' },
          message: 'You are not a member of an allowed GitHub organization.',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Find existing OAuth user or create a new one
// ---------------------------------------------------------------------------

/**
 * The account a provider sign-in opens: the one linked to this identity, the
 * one linked by a verified email, or a new one (`resolveProvisioningAction`
 * decides which). A new account takes the first free username.
 */
export async function findOrCreateOAuthUser(profile: OAuthProfile, db: DrizzleDB): Promise<User> {
  const { provider, providerId } = profile;

  // Look up the two candidate accounts the decision depends on: one already
  // linked to this provider identity, and another one that owns the provider's
  // address. Matching email on the dedicated `email` column — not `username` —
  // lets accounts created with a non-email username still link, and keeps
  // linking symmetric with the account/admin UIs and notifications.
  const identityMatch = (
    await db
      .select()
      .from(users)
      .where(and(eq(users.oauthProvider, provider), eq(users.oauthProviderId, providerId)))
  )[0];

  const email = validEmailAddress(profile.email);
  const emailMatch = email ? await findUserByEmail(db, email, identityMatch?.id) : undefined;

  const action = resolveProvisioningAction(profile, identityMatch, emailMatch);

  switch (action.kind) {
    case 'conflict':
      // Never hijack an account already linked to a *different* provider
      // identity — the single-provider schema cannot represent both.
      throw apiError({
        statusCode: 409,
        data: { oauthError: 'account-exists' },
        message: 'This email is already linked to a different sign-in method.',
      });

    case 'unverified':
      // The matching account never proved it owns the address, so it may not be
      // the signer's: its owner links the provider from their account settings.
      throw apiError({
        statusCode: 409,
        data: { oauthError: 'email-unverified' },
        message: 'This email belongs to an account that has not verified it.',
      });

    case 'refresh':
    case 'link': {
      const updated = await db
        .update(users)
        .set({ ...action.set, updatedAt: new Date() })
        .where(eq(users.id, action.userId))
        .returning();
      return updated[0]!;
    }

    case 'create': {
      const taken = await db
        .select({ username: users.username })
        .from(users)
        .where(inArray(users.username, action.usernames));
      const username = firstFreeUsername(
        action.usernames,
        taken.map((row) => row.username),
      );
      const result = await db
        .insert(users)
        .values({ ...action.values, username } as typeof users.$inferInsert)
        .returning();
      const user = result[0];
      if (!user) {
        throw apiError({ statusCode: 500, message: 'Failed to create user' });
      }
      // Signal for operators: a brand-new account was auto-provisioned via OAuth.
      console.info(`[OAuth] New account provisioned: ${user.username} via ${provider} (role: ${user.role})`);
      return user;
    }
  }
}

// ---------------------------------------------------------------------------
// Link a provider identity to an already-signed-in user
// ---------------------------------------------------------------------------

export async function linkProviderToUser(userId: number, profile: OAuthProfile, database?: DrizzleDB): Promise<User> {
  const db = database ?? (await getDatabase());
  const { provider, providerId } = profile;

  const current = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!current) {
    throw apiError({ statusCode: 404, message: 'User not found' });
  }

  // The provider identity must not already belong to a different account.
  const identityTakenBy = (
    await db
      .select()
      .from(users)
      .where(and(eq(users.oauthProvider, provider), eq(users.oauthProviderId, providerId)))
  )[0];

  const email = validEmailAddress(profile.email);
  const emailTakenBy = email ? await findUserByEmail(db, email, userId) : undefined;

  const action = resolveLinkAction(current, profile, identityTakenBy, emailTakenBy);
  if (action.kind === 'conflict') {
    throw apiError({
      statusCode: 409,
      data: { oauthError: 'already-linked' },
      message: 'That provider account is already linked to another user.',
    });
  }

  const updated = await db
    .update(users)
    .set({ ...action.set, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();

  return updated[0]!;
}

// ---------------------------------------------------------------------------
// Unlink a provider from the current user (callable from the unlink endpoint)
// ---------------------------------------------------------------------------

export async function unlinkProvider(userId: number, provider: string): Promise<void> {
  const db = await getDatabase();
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];

  const decision = resolveUnlink(u, provider);
  if (!decision.ok) {
    throw apiError({
      statusCode: 400,
      message:
        decision.reason === 'no-password'
          ? 'Set a password before disconnecting your only sign-in method.'
          : 'That provider is not linked to your account.',
    });
  }

  await db
    .update(users)
    .set({ oauthProvider: null, oauthProviderId: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// Handle OAuth callback: validate state, exchange code, sign in or link,
// set session, return redirect URL
// ---------------------------------------------------------------------------

export async function handleOAuthCallback(event: H3Event, provider: string): Promise<string> {
  if (!isAuthEnabled(event)) {
    return '/login?error=auth-disabled';
  }

  // Check provider is configured before proceeding
  if (!getProviderConfig(event, provider)) {
    return '/login?error=invalid-provider';
  }

  const query = getQuery(event) as { code?: string; state?: string; error?: string };

  const isLink = getCookie(event, LINK_COOKIE) === '1';
  // Link failures belong on the account page; sign-in failures on /login.
  const failBase = isLink ? '/settings/account' : '/login';

  // Read then clear all ephemeral cookies up front.
  const savedState = getOAuthState(event);
  const verifier = getCookie(event, VERIFIER_COOKIE) || undefined;
  clearEphemeralCookie(event, STATE_COOKIE);
  clearEphemeralCookie(event, VERIFIER_COOKIE);
  clearEphemeralCookie(event, LINK_COOKIE);
  const returnTo = safeReturnPath(getCookie(event, RETURN_COOKIE));
  clearEphemeralCookie(event, RETURN_COOKIE);

  // User denied the authorization request
  if (query.error) {
    return `${failBase}?error=access-denied`;
  }

  // Validate state to prevent CSRF
  if (!query.state || !savedState || query.state !== savedState) {
    return `${failBase}?error=invalid-state`;
  }

  if (!query.code) {
    return `${failBase}?error=missing-code`;
  }

  try {
    // Exchange code for access token (with PKCE verifier when present)
    const token = await exchangeCode(event, provider, query.code, verifier);

    // Fetch user info from provider
    const providerUser = await fetchProviderUser(event, provider, token.access_token);

    // Enforce optional access-control allowlists before provisioning a session.
    await enforceAllowlists(event, provider, providerUser, token.access_token);

    const profile: OAuthProfile = {
      provider,
      providerId: providerUser.id,
      email: providerUser.email,
      emailVerified: providerUser.emailVerified,
      name: providerUser.name,
      avatar: providerUser.avatar,
      login: providerUser.login,
    };

    if (isLink) {
      // Connect this provider to the already-signed-in user.
      const current = await getCurrentUser(event);
      if (!current) {
        return '/login?error=link-requires-login';
      }
      await linkProviderToUser(current.id, profile);
      return '/settings/account?linked=1';
    }

    // Find or create local user
    const user = await findOrCreateOAuthUser(profile, await getDatabase());

    // Set session
    const sessionData: SessionData = {
      userId: user.id,
      sessionEpoch: user.sessionEpoch,
    };
    await setUserSession(event, sessionData);

    return returnTo ?? '/';
  } catch (err) {
    console.error(`[OAuth] ${provider} callback failed:`, err);
    const oauthError = (err as { data?: { oauthError?: string } })?.data?.oauthError;
    return `${failBase}?error=${oauthError ?? 'oauth-failed'}`;
  }
}

function getOAuthState(event: H3Event): string | null {
  return getCookie(event, STATE_COOKIE) ?? null;
}
