/**
 * The OAuth authorization of a per-user SCM credential, for one person: the
 * start, which keeps a single-use `state` on the server, bound to the person,
 * the credential, the PKCE verifier and the page to go back to, and sends the
 * person to the host; the return, which takes that state once, for the same
 * person only, exchanges the code, tests the token and saves it; and the test
 * of a saved or new token at the host's user endpoint.
 */
import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { credentialAuthorizations } from '../database/schema';
import type { DbClient } from '../database';
import { decryptSecret, encryptSecret, getEncryptionKey } from './crypto';
import {
  CredentialRefusedError,
  exchangeOAuthCode,
  saveUserToken,
  withCredential,
  type CredentialActor,
} from './credentials';
import { configuredGitlabHosts } from './scm/gitlab-hosts';
import { loadCredentialRecord, type CredentialRecord } from '#shared/handlers/credentials';
import { readOAuthUser, USER_TOKEN_TEST_REASONS, type UserTokenTestResult } from '#shared/credentials';
import { oauthEndpoints } from '#shared/scm-urls';

/** How long a person has to authorize at the host once they started. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** The one callback every per-user SCM credential's OAuth application registers. */
export const OAUTH_CALLBACK_PATH = '/api/credentials/oauth/callback';

/** How long the host has to answer a token test. */
const TEST_TIMEOUT_MS = 10_000;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Start a person's authorization of a per-user SCM credential: keep its state
 * on the server and answer the host's authorization URL to send them to.
 * Expired states are dropped on the way.
 */
export async function startUserAuthorization(
  db: DbClient,
  record: CredentialRecord,
  userId: number,
  options: { redirectUri: string; returnTo: string | null },
  now = Date.now(),
): Promise<string> {
  const endpoints = oauthEndpoints(record.destination, configuredGitlabHosts());
  if (!record.perUser || !endpoints || !record.oauthClientId) {
    throw new CredentialRefusedError(`The credential "${record.name}" authorizes nobody through OAuth.`);
  }
  await db.delete(credentialAuthorizations).where(lt(credentialAuthorizations.expiresAt, new Date(now)));
  const state = randomBytes(32).toString('base64url');
  const verifier = endpoints.pkce ? randomBytes(48).toString('base64url') : '';
  await db.insert(credentialAuthorizations).values({
    stateHash: sha256(state),
    credentialId: record.id,
    userId,
    verifier: encryptSecret(verifier, getEncryptionKey()),
    returnTo: options.returnTo,
    createdAt: new Date(now),
    expiresAt: new Date(now + OAUTH_STATE_TTL_MS),
  });
  const url = new URL(endpoints.authorize);
  url.searchParams.set('client_id', record.oauthClientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  if (endpoints.scopes) url.searchParams.set('scope', endpoints.scopes);
  if (verifier) {
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/** What a person's return from the host came to: the credential and the page to go back to, and whether it worked. */
export interface AuthorizationOutcome {
  ok: boolean;
  credentialId: number | null;
  returnTo: string | null;
  /** What the person is told when it did not work; never the host's text. */
  message: string | null;
}

/**
 * Finish a person's authorization when the host sends them back: take the
 * state once (an unknown, expired or someone else's state is refused), then
 * exchange the code, test the token at the host's user endpoint and save it
 * as the person's, with the account it names.
 */
export async function finishUserAuthorization(
  db: DbClient,
  userId: number,
  answer: { state: string; code: string | null; error: string | null; redirectUri: string },
  now = Date.now(),
): Promise<AuthorizationOutcome> {
  const [row] = answer.state
    ? await db
        .delete(credentialAuthorizations)
        .where(eq(credentialAuthorizations.stateHash, sha256(answer.state)))
        .returning()
    : [];
  const fail = (message: string, keep: Partial<AuthorizationOutcome> = {}): AuthorizationOutcome => ({
    ok: false,
    credentialId: null,
    returnTo: null,
    message,
    ...keep,
  });
  if (!row) return fail('This authorization expired or was already used: start it again.');
  const where = { credentialId: row.credentialId, returnTo: row.returnTo ?? null };
  // A state is the person's who started it: another person's session never saves a token through it.
  if (row.userId !== userId) return fail('This authorization was started by someone else: start your own.');
  if (new Date(row.expiresAt).getTime() < now) return fail('This authorization expired: start it again.', where);
  const record = await loadCredentialRecord(db, row.credentialId);
  const endpoints = record ? oauthEndpoints(record.destination, configuredGitlabHosts()) : null;
  if (!record || !record.perUser || !endpoints) return fail('This credential no longer takes an authorization.', where);
  if (answer.error || !answer.code) return fail(`${endpoints.label} did not authorize Piwi.`, where);
  if (record.disabled) return fail(`The credential "${record.name}" is disabled.`, where);

  let verifier: string | null = null;
  try {
    verifier = decryptSecret(row.verifier, getEncryptionKey()) || null;
  } catch {
    return fail('This authorization cannot be read: start it again.', where);
  }
  const exchanged = await exchangeOAuthCode(db, record, userId, {
    code: answer.code,
    verifier,
    redirectUri: answer.redirectUri,
  });
  if (!exchanged.ok) {
    return fail(
      exchanged.reason === 'refused'
        ? `${endpoints.label} refused the authorization: start it again.`
        : `${endpoints.label} could not be reached.`,
      where,
    );
  }
  const tokens = exchanged.tokens;
  const tested = await testScmUserToken(db, record, { userId, apiKeyId: null }, { user: null, secret: tokens.access });
  if (!tested.ok) return fail(USER_TOKEN_TEST_REASONS[tested.reason], where);
  const saved = await saveUserToken(
    db,
    { credentialId: record.id, userId, destination: record.destination, remoteUser: tested.remoteUser },
    { user: null, secret: tokens.access, refresh: tokens.refresh, expiresAt: tokens.expiresAt },
  );
  if (!saved.saved) return fail(saved.message, where);
  return { ok: true, message: null, ...where };
}

/**
 * Test a person's token for a per-user SCM credential at the host's user
 * endpoint, with the token just exchanged (`candidate`) or the one they saved,
 * which is refreshed first when it is about to expire: through
 * `withCredential`, which checks, masks and logs it. The answer names the
 * account, or only why it failed.
 */
export async function testScmUserToken(
  db: DbClient,
  record: CredentialRecord,
  actor: CredentialActor,
  candidate?: { user: string | null; secret: string },
): Promise<UserTokenTestResult> {
  const endpoints = oauthEndpoints(record.destination, configuredGitlabHosts());
  if (!endpoints) throw new CredentialRefusedError(`The credential "${record.name}" authorizes nobody through OAuth.`);
  let answer: { status: number; json: unknown };
  try {
    answer = await withCredential(
      db,
      {
        credentialId: record.id,
        feature: 'credential-test',
        projectId: null,
        url: endpoints.user,
        custom: false,
        actor,
        ...(candidate ? { candidate } : {}),
      },
      async (opened) => {
        const res = await fetch(endpoints.user, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${opened.secret}`,
            'User-Agent': 'piwi-dashboard',
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }
        return { status: res.status, json };
      },
      (sent) => {
        if (sent.status < 200 || sent.status >= 300) return `${endpoints.label} answered ${sent.status}`;
        return readOAuthUser(endpoints.host, sent.json) ? null : `${endpoints.label} named no account`;
      },
      { unauthorized: (sent) => sent.status === 401 },
    );
  } catch (e) {
    if (e instanceof CredentialRefusedError) throw e;
    return { ok: false, reason: 'unreachable' };
  }
  if (answer.status === 401 || answer.status === 403) return { ok: false, reason: 'refused' };
  if (answer.status < 200 || answer.status >= 300) return { ok: false, reason: 'unreachable' };
  const remoteUser = readOAuthUser(endpoints.host, answer.json);
  return remoteUser ? { ok: true, remoteUser } : { ok: false, reason: 'anonymous' };
}
