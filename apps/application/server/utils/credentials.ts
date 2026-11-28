/**
 * The credential manager's secrets: sealing one with its destination, opening
 * it for one use after the checks, recording every use, the credential the
 * environment sets, and the import of the project CI server tokens
 * (`projects.ci_server_token`) and of the SCM tokens (`projects.scm_token`,
 * the `scm_token` app setting).
 *
 * `withCredential` is the one way to a secret. It refuses a use the
 * credential's rules do not allow (`credentialRefusal`), records the refusal,
 * the send and its outcome, and masks the secret in any text it keeps.
 * `tests/unit/credential-secret-access.test.ts` fails on any other code that
 * reads the secret column.
 */
import { and, eq, gte, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import {
  appSettings,
  credentialProjects,
  credentials,
  credentialAuthorizations,
  credentialUserTokens,
  credentialUses,
  projects,
} from '../database/schema';
import type { DbClient } from '../database';
import { decryptSecret, encryptSecret, getEncryptionKey } from './crypto';
import { isUniqueViolation } from './db-errors';
import { isReadOnly } from './operator-limits';
import {
  CREDENTIAL_READ_FEATURES,
  credentialLogDestination,
  credentialRefusal,
  isCredentialSecretEnv,
  userTokenActorRefusal,
  userTokenMissingMessage,
  userTokenTestUrl,
  type CredentialFeature,
  type CredentialService,
  type CredentialUseResult,
  type UserTokenRefusalCode,
} from '#shared/credentials';
import {
  freeCredentialName,
  INSTANCE_SCM_CREDENTIALS_SETTING,
  loadCredentialRecord,
  readInstanceScmCredentialIds,
  type CredentialRecord,
} from '#shared/handlers/credentials';
import {
  oauthEndpoints,
  SCM_API_DESTINATIONS,
  scmApiDestination,
  scmDestinationHost,
  type OAuthEndpoints,
} from '#shared/scm-urls';
import { requestOAuthTokens, revokeOAuthToken, type OAuthClient, type OAuthTokenAnswer } from './oauth-token-requests';
import { configuredGitlabHosts } from './scm/gitlab-hosts';
import { isUnderBaseUrl, normalizeCiServerBaseUrl } from '#shared/ci-server';
import { resolveCiActionsSettings } from '#shared/ci-actions';

const ENCRYPTED_PREFIX = 'v1:';
/** The most of a reason the log keeps. */
const MAX_REASON = 500;
const HOUR_MS = 60 * 60 * 1000;
const MS_PER_DAY = 24 * HOUR_MS;

/** Days the log is kept when `PIWI_RETENTION_CREDENTIAL_LOG_DAYS` is unset. */
export const DEFAULT_CREDENTIAL_LOG_DAYS = 365;

/** A secret sealed with the destination it may be sent under, as `credentials.secret` stores it. */
export function sealCredentialSecret(destination: string, secret: string): string {
  return encryptSecret(JSON.stringify({ destination, secret }), getEncryptionKey());
}

/**
 * The name of the `PIWI_CREDENTIAL_*` variable a secret is read from, sealed
 * with the destination it may be sent under, so a row edited in the database
 * to another destination or variable does not open.
 */
export function sealCredentialEnv(destination: string, env: string): string {
  return encryptSecret(JSON.stringify({ destination, env }), getEncryptionKey());
}

/** A variable's value, trimmed, or null when it is unset or empty. */
function readSecretEnv(name: string): string | null {
  return process.env[name]?.trim() || null;
}

/**
 * An AI key variable's value: `PIWI_AI_…`, else the `NUXT_AI_…` override the
 * runtime configuration also reads, or null when neither is set.
 */
export function readAiKeyEnv(name: string): string | null {
  return readSecretEnv(name) ?? readSecretEnv(name.replace(/^PIWI_/, 'NUXT_'));
}

/**
 * The secret of a stored credential, or why it cannot be had: the seal opens
 * for its destination and its variable, and the variable it names is set.
 */
function openStoredSecret(
  stored: string | null,
  destination: string,
  secretEnv: string | null,
  name: string,
): { secret: string } | { refusal: string } {
  const unopened = { refusal: `The credential "${name}" cannot be opened: save its secret again.` };
  if (!stored?.startsWith(ENCRYPTED_PREFIX)) return unopened;
  let value: { destination?: unknown; secret?: unknown; env?: unknown };
  try {
    value = JSON.parse(decryptSecret(stored, getEncryptionKey())) as typeof value;
  } catch {
    return unopened;
  }
  if (value.destination !== destination) return unopened;
  if (secretEnv !== null || value.env !== undefined) {
    if (value.env !== secretEnv || !secretEnv || !isCredentialSecretEnv(secretEnv)) return unopened;
    const secret = readSecretEnv(secretEnv);
    return secret ? { secret } : { refusal: credentialEnvRefusal({ name, secretEnv })! };
  }
  return typeof value.secret === 'string' && value.secret ? { secret: value.secret } : unopened;
}

/** Why a credential cannot be used on this server before anything is sent, or null: the variable its secret is read from is unset. */
export function credentialEnvRefusal(credential: { name: string; secretEnv: string | null }): string | null {
  if (!credential.secretEnv || readSecretEnv(credential.secretEnv) !== null) return null;
  return `The credential "${credential.name}" reads its secret from ${credential.secretEnv}, which is not set on the server.`;
}

/** A credential as an answer shows it, with whether the variable its secret is read from is set on this server. */
export function withSecretEnvState<T extends { secretEnv: string | null; secretEnvSet: boolean | null }>(
  credential: T,
): T {
  return {
    ...credential,
    secretEnvSet: credential.secretEnv ? readSecretEnv(credential.secretEnv) !== null : null,
  };
}

/** The variables an AI role's key is read from when the environment manages AI. */
export const AI_KEY_ENV_VARS = [
  'PIWI_AI_API_KEY',
  'PIWI_AI_RESEARCH_API_KEY',
  'PIWI_AI_EMBEDDING_API_KEY',
  'PIWI_AI_ASSISTANT_API_KEY',
] as const;

/**
 * The secret of a credential the environment sets: the CI server's token, the
 * Jira or Zephyr Scale token, or the AI key variable its row names, one of
 * {@link AI_KEY_ENV_VARS} alone.
 */
function envSecret(service: CredentialService, variable: string | null): string | null {
  if (service === 'jira') return readSecretEnv('PIWI_JIRA_API_TOKEN');
  if (service === 'zephyr-scale') return readSecretEnv('PIWI_ZEPHYR_API_TOKEN');
  if (service === 'ai') {
    return variable && (AI_KEY_ENV_VARS as readonly string[]).includes(variable) ? readAiKeyEnv(variable) : null;
  }
  return envCredential(service)?.secret ?? null;
}

/** The credential the environment sets for a service, as its row holds it, or null when its variables are unset. */
function envCredential(service: CredentialService): {
  name: string;
  destination: string;
  user: string | null;
  secret: string;
  allowedInputs: string[];
} | null {
  if (service !== 'ci-server') return null;
  const destination = normalizeCiServerBaseUrl(process.env.PIWI_CI_SERVER_URL);
  const secret = process.env.PIWI_CI_SERVER_TOKEN?.trim();
  if (!destination || !secret) return null;
  return {
    name: 'CI server (environment)',
    destination,
    user: process.env.PIWI_CI_SERVER_USER?.trim() || null,
    secret,
    allowedInputs: instanceCiServerAllowedInputs(),
  };
}

/** The action inputs a request carrying the instance's CI server credential may send (`PIWI_CI_SERVER_ALLOWED_INPUTS`). */
export function instanceCiServerAllowedInputs(): string[] {
  return (process.env.PIWI_CI_SERVER_ALLOWED_INPUTS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Bring the credentials the environment sets in line with its variables: the
 * CI server's when `PIWI_CI_SERVER_URL` and `PIWI_CI_SERVER_TOKEN` are set,
 * removed when they are not, and left as they are while the instance is
 * read-only. Its secret stays in the environment, so the row
 * holds none; it is shared with all projects, never goes with a Custom request,
 * and sends only the inputs of `PIWI_CI_SERVER_ALLOWED_INPUTS`.
 */
export async function ensureEnvCredentials(db: DbClient): Promise<void> {
  if (isReadOnly()) return;
  const service: CredentialService = 'ci-server';
  const env = envCredential(service);
  const [existing] = await db
    .select({
      id: credentials.id,
      destination: credentials.destination,
      user: credentials.userName,
      allowedInputs: credentials.allowedInputs,
    })
    .from(credentials)
    .where(and(eq(credentials.service, service), eq(credentials.managedBy, 'env')));
  if (!env) {
    if (existing) await db.delete(credentials).where(eq(credentials.id, existing.id));
    return;
  }
  const fields = {
    destination: env.destination,
    userName: env.user,
    allowedInputs: env.allowedInputs,
    allProjects: true,
    customRequests: false,
    disabled: false,
  };
  if (existing) {
    const same =
      existing.destination === env.destination &&
      (existing.user ?? null) === env.user &&
      JSON.stringify(existing.allowedInputs ?? []) === JSON.stringify(env.allowedInputs);
    if (!same) await db.update(credentials).set(fields).where(eq(credentials.id, existing.id));
    return;
  }
  try {
    await db.insert(credentials).values({
      ...fields,
      name: await freeName(db, env.name),
      service,
      secret: null,
      managedBy: 'env',
    });
  } catch (err) {
    // Two first requests at once: the other one inserted it, under the same name.
    const [inserted] = await db
      .select({ id: credentials.id })
      .from(credentials)
      .where(and(eq(credentials.service, service), eq(credentials.managedBy, 'env')));
    if (!inserted) throw err;
  }
}

/** The credential the environment sets for a service, or null. */
export async function instanceCredential(db: DbClient, service: CredentialService): Promise<CredentialRecord | null> {
  await ensureEnvCredentials(db);
  const [row] = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(eq(credentials.service, service), eq(credentials.managedBy, 'env')));
  return row ? loadCredentialRecord(db, row.id) : null;
}

/** Who started a use: a user, the API key it came through, or nobody (the instance itself). */
export interface CredentialActor {
  userId: number | null;
  apiKeyId: number | null;
}

/**
 * Who a request's uses are logged as: its user, none for the virtual
 * administrator of an instance without sign-in (id 0, no user row), and the
 * API key it came through.
 */
export function requestCredentialActor(
  event: { context?: Record<string, unknown> },
  user: { id: number } | null | undefined,
): CredentialActor {
  return { userId: user?.id || null, apiKeyId: (event.context?.apiKeyId as number | undefined) ?? null };
}

/** One use of a credential, as `withCredential` checks and records it. */
export interface CredentialUse {
  credentialId: number;
  feature: CredentialFeature;
  projectId: number | null;
  /** The URL the secret is sent to. */
  url: string;
  /** Whether the request is a Custom one, which the credential must allow. */
  custom: boolean;
  actor: CredentialActor;
  subject?: { type: string; id: string };
  /**
   * A token not saved yet, which a test of a per-user credential sends instead
   * of the actor's stored one (feature `credential-test`, to the one URL the
   * credential's tokens are tested at).
   */
  candidate?: OpenedCredential;
}

/** What a use opens: the user name and the secret, for this one request. */
export interface OpenedCredential {
  user: string | null;
  secret: string;
}

/**
 * Runs one write of a client that carries a credential (a Jira or Zephyr Scale
 * client), with the credential's check and log row around it. `failure` reads
 * a failure from what the write returned.
 */
export type CredentialWriteGate = <T>(run: () => Promise<T>, failure: (value: T) => string | null) => Promise<T>;

/**
 * A use the credential's rules refuse; its message names the credential and
 * the reason, never the secret. A use of a per-user credential refused for who
 * asked carries a `code` and the credential, so a page can ask the person for
 * their token.
 */
export class CredentialRefusedError extends Error {
  constructor(
    message: string,
    readonly code: UserTokenRefusalCode | null = null,
    readonly credential: { id: number; name: string } | null = null,
  ) {
    super(message);
  }
}

/** A person's token sealed with its credential, its person and the destination it may be sent under. */
export function sealUserToken(
  token: { credentialId: number; userId: number; destination: string },
  opened: UserTokenSecret,
): string {
  return encryptSecret(
    JSON.stringify({
      ...token,
      user: opened.user ?? '',
      secret: opened.secret,
      ...(opened.refresh ? { refresh: opened.refresh } : {}),
      ...(opened.expiresAt ? { expiresAt: opened.expiresAt } : {}),
    }),
    getEncryptionKey(),
  );
}

/**
 * A person's token as sealed: the secret sent, and for an OAuth token its
 * refresh token and when the access token expires (epoch ms).
 */
export interface UserTokenSecret extends OpenedCredential {
  refresh?: string | null;
  expiresAt?: number | null;
}

/** A sealed user token, opened, or null when its seal does not match its credential, person and destination. */
function openUserToken(
  stored: string,
  token: { credentialId: number; userId: number; destination: string },
): UserTokenSecret | null {
  try {
    const value = JSON.parse(decryptSecret(stored, getEncryptionKey())) as Record<string, unknown>;
    if (
      value.credentialId !== token.credentialId ||
      value.userId !== token.userId ||
      value.destination !== token.destination ||
      typeof value.secret !== 'string' ||
      !value.secret
    ) {
      return null;
    }
    return {
      user: typeof value.user === 'string' && value.user ? value.user : null,
      secret: value.secret,
      refresh: typeof value.refresh === 'string' && value.refresh ? value.refresh : null,
      expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : null,
    };
  } catch {
    return null;
  }
}

/** How long before it expires an OAuth access token is refreshed, when it is opened. */
export const OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The one URL a per-user credential's tokens are tested at: Jenkins' `whoAmI`, or the repository host's user endpoint. */
export function perUserTestUrl(record: { service: CredentialService; destination: string }): string | null {
  if (record.service === 'scm') return oauthEndpoints(record.destination, configuredGitlabHosts())?.user ?? null;
  return userTokenTestUrl(record.destination);
}

/**
 * The OAuth application of a per-user SCM credential, its client secret
 * opened for one exchange with the host, sealed with the host's token
 * endpoint; or why it cannot be had.
 */
async function openOAuthClient(
  db: DbClient,
  record: CredentialRecord,
): Promise<{ endpoints: OAuthEndpoints; client: OAuthClient } | { refusal: string }> {
  const endpoints = oauthEndpoints(record.destination, configuredGitlabHosts());
  if (!record.perUser || !endpoints || !record.oauthClientId) {
    return { refusal: `The credential "${record.name}" authorizes nobody through OAuth.` };
  }
  const [row] = await db.select({ secret: credentials.secret }).from(credentials).where(eq(credentials.id, record.id));
  const opened = openStoredSecret(row?.secret ?? null, endpoints.token, null, record.name);
  if (!('secret' in opened)) return { refusal: opened.refusal };
  return { endpoints, client: { id: record.oauthClientId, secret: opened.secret } };
}

/** Log one exchange with a host's OAuth endpoints, counted per person, the client and the tokens never in it. */
async function logOAuthExchange(
  db: DbClient,
  record: CredentialRecord,
  userId: number | null,
  url: string,
  result: CredentialUseResult,
  reason: string | null,
): Promise<void> {
  await countRead(
    db,
    {
      credentialId: record.id,
      credentialName: record.name,
      feature: 'credential-oauth',
      projectId: null,
      userId,
      apiKeyId: null,
      remoteUser: null,
      subjectType: null,
      subjectId: null,
      destination: credentialLogDestination(url),
      result,
      reason,
    },
    true,
  );
}

/**
 * Exchange the code a host sent back after a person authorized a per-user SCM
 * credential's OAuth application, with the PKCE verifier when the host checks
 * one; the client secret is opened for that one request. Logged as an OAuth
 * exchange of the person.
 */
export async function exchangeOAuthCode(
  db: DbClient,
  record: CredentialRecord,
  userId: number,
  grant: { code: string; verifier: string | null; redirectUri: string },
): Promise<OAuthTokenAnswer> {
  const opened = await openOAuthClient(db, record);
  if ('refusal' in opened) return { ok: false, reason: 'client' };
  const answer = await requestOAuthTokens(opened.endpoints, opened.client, {
    grant_type: 'authorization_code',
    code: grant.code,
    redirect_uri: grant.redirectUri,
    ...(grant.verifier ? { code_verifier: grant.verifier } : {}),
  });
  await logOAuthExchange(
    db,
    record,
    userId,
    opened.endpoints.token,
    answer.ok ? 'ok' : 'failed',
    answer.ok ? null : OAUTH_FAILURES[answer.reason],
  );
  return answer;
}

/**
 * A person's OAuth token refreshed at the host, saved in place of the one
 * read (`sealed`) only while that one is still the row's: a refresh another
 * request made first wins, and its token is read again. A refused refresh
 * marks the token `invalid`. Answers the token with its sealed value as the
 * row holds it, or null when it is refused or cannot be had.
 */
async function refreshUserToken(
  db: DbClient,
  record: CredentialRecord,
  token: { id: number; userId: number; sealed: string },
  opened: UserTokenSecret,
): Promise<{ token: UserTokenSecret; sealed: string } | null> {
  const client = await openOAuthClient(db, record);
  if ('refusal' in client || !opened.refresh) return null;
  const answer = await requestOAuthTokens(client.endpoints, client.client, {
    grant_type: 'refresh_token',
    refresh_token: opened.refresh,
  });
  await logOAuthExchange(
    db,
    record,
    token.userId,
    client.endpoints.token,
    answer.ok ? 'ok' : 'failed',
    answer.ok ? null : OAUTH_FAILURES[answer.reason],
  );
  const current = and(eq(credentialUserTokens.id, token.id), eq(credentialUserTokens.secret, token.sealed));
  if (!answer.ok) {
    // Another request refreshed it first, with the refresh token this one sent: its token is the person's now.
    const newer = await reread();
    if (newer) return newer;
    // Only the person's grant refused is theirs to give again; a refused client is the administrator's to fix.
    if (answer.reason === 'refused') {
      await db.update(credentialUserTokens).set({ state: 'invalid' }).where(current);
    }
    return null;
  }
  const next: UserTokenSecret = {
    user: null,
    secret: answer.tokens.access,
    refresh: answer.tokens.refresh ?? opened.refresh,
    expiresAt: answer.tokens.expiresAt,
  };
  const nextSealed = sealUserToken(
    { credentialId: record.id, userId: token.userId, destination: record.destination },
    next,
  );
  const updated = await db
    .update(credentialUserTokens)
    .set({
      secret: nextSealed,
      expiresAt: next.expiresAt ? new Date(next.expiresAt) : null,
      // A refused refresh of another request that raced this one never leaves the new token refused.
      state: 'ready',
    })
    .where(current)
    .returning({ id: credentialUserTokens.id });
  if (updated.length > 0) return { token: next, sealed: nextSealed };
  const newer = await reread();
  if (!newer && (await rowGone())) {
    // The token was removed from Piwi while it was refreshed: the one the host just gave is revoked too.
    if (client.endpoints.revoke)
      await revokeAtHost(db, record, client, [{ userId: token.userId, token: next.refresh ?? next.secret }]);
    return null;
  }
  return newer;

  async function rowGone(): Promise<boolean> {
    const [row] = await db
      .select({ id: credentialUserTokens.id })
      .from(credentialUserTokens)
      .where(eq(credentialUserTokens.id, token.id));
    return !row;
  }

  /** The person's token as the row holds it now, when another request saved a newer one; else null. */
  async function reread(): Promise<{ token: UserTokenSecret; sealed: string } | null> {
    const [row] = await db
      .select({ secret: credentialUserTokens.secret, state: credentialUserTokens.state })
      .from(credentialUserTokens)
      .where(eq(credentialUserTokens.id, token.id));
    if (!row || row.secret === token.sealed || row.state !== 'ready') return null;
    const newer = openUserToken(row.secret, {
      credentialId: record.id,
      userId: token.userId,
      destination: record.destination,
    });
    return newer ? { token: newer, sealed: row.secret } : null;
  }
}

/** What the log says of a failed exchange with a host's OAuth endpoints, never the host's own text. */
const OAUTH_FAILURES: Record<'refused' | 'client' | 'unreachable', string> = {
  refused: 'The host refused the grant.',
  client: 'The host refused the OAuth application: check its client id and secret.',
  unreachable: 'The host could not be reached.',
};

/** How many revocations run at once, and how long a removal waits for them all. */
const REVOCATION_CONCURRENCY = 4;
const REVOCATION_DEADLINE_MS = 15_000;

/** A per-user SCM credential's OAuth client, opened for revocations; null when its host revokes nothing. */
export type RevocationClient = { endpoints: OAuthEndpoints; client: OAuthClient } | null;

/**
 * Open a per-user SCM credential's OAuth client for the revocations of its
 * people's tokens, before anything changes the credential: once its host or
 * its application changes, the stored client secret is no longer the one
 * these tokens were given to.
 */
export async function openRevocationClient(db: DbClient, record: CredentialRecord): Promise<RevocationClient> {
  if (!record.perUser || record.service !== 'scm') return null;
  const client = await openOAuthClient(db, record);
  return 'refusal' in client || !client.endpoints.revoke ? null : client;
}

/**
 * Revoke OAuth tokens at their host, a few at a time, and wait for them at
 * most `REVOCATION_DEADLINE_MS`: a revocation that fails or is still waiting
 * then leaves the token to expire at the host. Each one is logged.
 */
async function revokeAtHost(
  db: DbClient,
  record: CredentialRecord,
  client: NonNullable<RevocationClient>,
  tokens: Array<{ userId: number | null; token: string }>,
): Promise<void> {
  const queue = [...tokens];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const revoked = await revokeOAuthToken(client.endpoints, client.client, next.token);
      await logOAuthExchange(
        db,
        record,
        next.userId,
        client.endpoints.revoke!,
        revoked ? 'ok' : 'failed',
        revoked ? null : 'The host did not revoke the token.',
      ).catch(() => undefined);
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(REVOCATION_CONCURRENCY, tokens.length) }, worker));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, REVOCATION_DEADLINE_MS);
  });
  await Promise.race([
    all.then(
      () => undefined,
      () => undefined,
    ),
    deadline,
  ]);
  clearTimeout(timer);
}

/**
 * Remove people's tokens for a per-user credential (one person's, or every
 * one's when `userId` is null) from Piwi, then revoke the OAuth ones at their
 * host where it offers revocation, with `client` when the caller opened it
 * before changing the credential. Returns how many went.
 */
export async function revokeUserTokens(
  db: DbClient,
  record: CredentialRecord,
  userId: number | null,
  client?: RevocationClient,
): Promise<number> {
  // An authorization still pending would save a token for what the credential no longer is.
  if (userId == null) {
    await db.delete(credentialAuthorizations).where(eq(credentialAuthorizations.credentialId, record.id));
  }
  const revoking = client === undefined ? await openRevocationClient(db, record) : client;
  const removed = await db
    .delete(credentialUserTokens)
    .where(
      userId == null
        ? eq(credentialUserTokens.credentialId, record.id)
        : and(eq(credentialUserTokens.credentialId, record.id), eq(credentialUserTokens.userId, userId)),
    )
    .returning({ userId: credentialUserTokens.userId, secret: credentialUserTokens.secret });
  if (revoking) {
    const tokens = removed.flatMap((row) => {
      const opened = openUserToken(row.secret, {
        credentialId: record.id,
        userId: row.userId,
        destination: record.destination,
      });
      return opened ? [{ userId: row.userId, token: opened.refresh ?? opened.secret }] : [];
    });
    if (tokens.length > 0) await revokeAtHost(db, record, revoking, tokens);
  }
  return removed.length;
}

/**
 * Open the OAuth tokens a person holds, while their account still exists, and
 * answer what revokes them at their hosts once the account is gone: a
 * deletion that is refused (the last administrator) revokes nothing.
 */
export async function prepareUserTokenRevocation(db: DbClient, userId: number): Promise<() => Promise<void>> {
  const held = await db
    .select({ credentialId: credentialUserTokens.credentialId, secret: credentialUserTokens.secret })
    .from(credentialUserTokens)
    .where(eq(credentialUserTokens.userId, userId));
  const revocations: Array<() => Promise<void>> = [];
  for (const row of held) {
    const record = await loadCredentialRecord(db, row.credentialId);
    if (!record) continue;
    const client = await openRevocationClient(db, record);
    const opened = openUserToken(row.secret, { credentialId: record.id, userId, destination: record.destination });
    if (!client || !opened) continue;
    revocations.push(() =>
      revokeAtHost(db, record, client, [{ userId: null, token: opened.refresh ?? opened.secret }]),
    );
  }
  return async () => {
    await Promise.all(revocations.map((revoke) => revoke().catch(() => undefined)));
  };
}

/** The text with every occurrence of the secret, and of the Basic pairs it is sent in, replaced by `****`. */
export function maskCredentialSecret(text: string, opened: OpenedCredential | null): string {
  if (!opened) return text;
  const forms = [
    opened.secret,
    Buffer.from(`${opened.user ?? ''}:${opened.secret}`, 'utf8').toString('base64'),
    Buffer.from(`:${opened.secret}`, 'utf8').toString('base64'),
    encodeURIComponent(opened.secret),
  ];
  let masked = text;
  for (const form of forms) if (form) masked = masked.split(form).join('****');
  return masked;
}

/**
 * An answer's text with the secret masked, as written and, for a JSON answer,
 * in each string once decoded: a JSON escape (`\/`, a `\u` code) hides it from the
 * text alone. A JSON answer comes back serialized again.
 */
export function maskCredentialAnswer(text: string, opened: OpenedCredential): string {
  const masked = maskCredentialSecret(text, opened);
  let json: unknown;
  try {
    json = JSON.parse(masked);
  } catch {
    return masked;
  }
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return maskCredentialSecret(value, opened);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [maskCredentialSecret(key, opened), walk(item)]),
      );
    }
    return value;
  };
  return JSON.stringify(walk(json));
}

const cut = (text: string | null): string | null => (text ? text.slice(0, MAX_REASON) : null);

/**
 * Run `send` with a credential's secret, after the checks, and record the use.
 * A refused use is recorded and throws a {@link CredentialRefusedError} before
 * anything is sent. A use that changes something outside Piwi is one log row,
 * written as `sent` before the request and settled after it; a read
 * (`CREDENTIAL_READ_FEATURES`), refused or not, adds to the row of its
 * credential, feature, project, result and hour once it ends (and person, for a
 * per-user credential). `failure` reads a failure from what
 * `send` returned (a refused answer); a throw is a failure too, rethrown with
 * the secret masked.
 *
 * A per-user credential sends the token of the use's actor: a person in a
 * session, never an API key, whose token is `ready`; `unauthorized` reads from
 * what `send` returned that the service refused it, which marks it `invalid`.
 * A test sends the token not saved yet (`candidate`) to the one URL tokens are
 * tested at (`userTokenTestUrl`).
 */
export async function withCredential<T>(
  db: DbClient,
  use: CredentialUse,
  send: (opened: OpenedCredential) => Promise<T>,
  failure?: (value: T) => string | null,
  options: {
    unauthorized?: (value: T) => boolean;
    /** Whether a thrown error says the service refused the token (401), which marks a person's token `invalid`. */
    unauthorizedError?: (message: string) => boolean;
    refresh?: boolean;
  } = {},
): Promise<T> {
  const [row] = await db
    .select({
      secret: credentials.secret,
      secretEnv: credentials.secretEnv,
      managedBy: credentials.managedBy,
      service: credentials.service,
    })
    .from(credentials)
    .where(eq(credentials.id, use.credentialId));
  const record = row ? await loadCredentialRecord(db, use.credentialId) : null;
  const name = record?.name ?? `#${use.credentialId}`;
  const testing = use.feature === 'credential-test';
  let refusal = !record
    ? 'The credential was deleted: pick another one.'
    : testing
      ? // A test serves no project, and goes to the one URL the credential's tokens are tested at,
        // which a destination narrowed to a folder does not hold.
        (credentialRefusal({ ...record, allProjects: true }, { ...use, url: record.destination }) ??
        (record.perUser && use.url === perUserTestUrl(record)
          ? null
          : `The credential "${name}" tests a token only at ${perUserTestUrl(record) ?? 'its user endpoint'}.`))
      : credentialRefusal(record, use);
  let code: UserTokenRefusalCode | null = null;
  let opened: OpenedCredential | null = null;
  let userToken: { id: number; remoteUser: string; sealed: string } | null = null;
  if (!refusal && record && row) {
    if (record.perUser) {
      const actorRefusal = userTokenActorRefusal(name, use.actor);
      if (actorRefusal) {
        refusal = actorRefusal.message;
        code = actorRefusal.code;
      } else if (use.candidate) {
        // A typed token is sent only to be tested, never with a request that acts.
        if (testing) opened = use.candidate;
        else refusal = `The credential "${name}" sends a typed token only to test it.`;
      } else {
        const [token] = await db
          .select({
            id: credentialUserTokens.id,
            secret: credentialUserTokens.secret,
            state: credentialUserTokens.state,
            remoteUser: credentialUserTokens.remoteUser,
          })
          .from(credentialUserTokens)
          .where(
            and(eq(credentialUserTokens.credentialId, record.id), eq(credentialUserTokens.userId, use.actor.userId!)),
          );
        // A test sends a token the service refused before, to see whether it is taken again.
        const unsealed =
          token && (token.state === 'ready' || testing)
            ? openUserToken(token.secret, {
                credentialId: record.id,
                userId: use.actor.userId!,
                destination: record.destination,
              })
            : null;
        // An OAuth token near its expiry is refreshed as it opens, and not again in a write gate (`refresh: false`),
        // where the provider holds the token opened for its reads.
        let current: UserTokenSecret | null = unsealed;
        let sealed = token?.secret ?? '';
        if (
          unsealed?.expiresAt &&
          token &&
          options.refresh !== false &&
          unsealed.expiresAt - Date.now() < OAUTH_REFRESH_MARGIN_MS
        ) {
          const refreshed = await refreshUserToken(
            db,
            record,
            { id: token.id, userId: use.actor.userId!, sealed: token.secret },
            unsealed,
          );
          // The sealed value goes with the token sent, so a refusal marks that one alone, never a newer one.
          current = refreshed?.token ?? (unsealed.expiresAt > Date.now() ? unsealed : null);
          if (refreshed) sealed = refreshed.sealed;
          const [now] = current
            ? []
            : await db
                .select({ state: credentialUserTokens.state })
                .from(credentialUserTokens)
                .where(eq(credentialUserTokens.id, token.id));
          if (!current && now?.state === 'ready') {
            // The host could not renew it (unreachable, or the OAuth application refused): nothing for the person to do.
            refusal = `The credential "${name}" could not renew your token at its host: try again shortly.`;
          }
        }
        if (!refusal && current && token) {
          opened = { user: current.user, secret: current.secret };
          userToken = { id: token.id, remoteUser: token.remoteUser, sealed };
        } else if (!refusal && unsealed && token) {
          refusal = userTokenMissingMessage(name, 'invalid');
          code = 'user-token-required';
        } else if (!refusal) {
          // A token that no longer opens (another secret key, another destination) is asked for again.
          if (token && token.state === 'ready') {
            await db
              .update(credentialUserTokens)
              .set({ state: 'invalid' })
              .where(and(eq(credentialUserTokens.id, token.id), eq(credentialUserTokens.secret, token.secret)));
          }
          refusal = userTokenMissingMessage(name, token ? 'invalid' : 'missing');
          code = 'user-token-required';
        }
      }
    } else if (use.candidate) {
      refusal = `The credential "${name}" is shared: it holds its own secret.`;
    } else if (row.managedBy === 'env') {
      const secret = envSecret(record.service, row.secretEnv ?? null);
      if (secret) opened = { user: record.user, secret };
      else refusal = `The credential "${name}" is set by environment variables that are unset.`;
    } else {
      const stored = openStoredSecret(row.secret, record.destination, row.secretEnv ?? null, name);
      if ('secret' in stored) opened = { user: record.user, secret: stored.secret };
      else refusal = stored.refusal;
    }
  }
  const base = {
    credentialId: record ? record.id : null,
    credentialName: name,
    feature: use.feature,
    projectId: use.projectId,
    userId: use.actor.userId,
    apiKeyId: use.actor.apiKeyId,
    remoteUser: userToken?.remoteUser ?? null,
    subjectType: use.subject?.type ?? null,
    subjectId: use.subject?.id ?? null,
    destination: credentialLogDestination(use.url),
  };
  const read = CREDENTIAL_READ_FEATURES.includes(use.feature);
  // A per-user credential's reads are counted per person, so a row never names another person's account.
  const perPerson = record?.perUser === true;
  if (refusal || !opened || !record) {
    const refused = { ...base, result: 'refused' as const, reason: cut(refusal) };
    if (read) await countRead(db, refused, perPerson);
    else await db.insert(credentialUses).values(refused);
    throw new CredentialRefusedError(
      refusal ?? `The credential "${name}" cannot be used.`,
      code,
      record ? { id: record.id, name: record.name } : null,
    );
  }

  const [written] = read
    ? [null]
    : await db
        .insert(credentialUses)
        .values({ ...base, result: 'sent' })
        .returning({ id: credentialUses.id });
  const now = new Date();
  await db.update(credentials).set({ lastUsedAt: now }).where(eq(credentials.id, record.id));
  if (userToken) {
    await db.update(credentialUserTokens).set({ lastUsedAt: now }).where(eq(credentialUserTokens.id, userToken.id));
  }

  const used = opened;
  const settle = async (result: CredentialUseResult, reason: string | null) => {
    try {
      const masked = cut(reason ? maskCredentialSecret(reason, used) : null);
      if (written) {
        await db
          .update(credentialUses)
          .set({ result, reason: masked, lastAt: new Date() })
          .where(eq(credentialUses.id, written.id));
      } else {
        await countRead(db, { ...base, result, reason: masked }, perPerson);
      }
    } catch (err) {
      console.error('[credentials] Recording a use failed:', err);
    }
  };

  let value: T;
  try {
    value = await send(used);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await settle('failed', message);
    if (userToken && options.unauthorizedError?.(message)) {
      await db
        .update(credentialUserTokens)
        .set({ state: 'invalid' })
        .where(and(eq(credentialUserTokens.id, userToken.id), eq(credentialUserTokens.secret, userToken.sealed)));
    }
    const masked = maskCredentialSecret(message, used);
    throw masked === message ? e : new Error(masked);
  }
  const failed = failure?.(value) ?? null;
  await settle(failed ? 'failed' : 'ok', failed);
  // A person's token the service refuses is not sent again until they give it anew; one saved since stays as it is.
  if (userToken && options.unauthorized?.(value)) {
    await db
      .update(credentialUserTokens)
      .set({ state: 'invalid' })
      .where(and(eq(credentialUserTokens.id, userToken.id), eq(credentialUserTokens.secret, userToken.sealed)));
  }
  return value;
}

/**
 * Save a person's tested token for a per-user credential, sealed with the
 * credential, the person and its destination, in place of the one they had.
 * Refused when another person already gave a token for the same account
 * (`remoteUser`, ignoring case), so a shared account is never saved as one
 * person's own.
 */
export async function saveUserToken(
  db: DbClient,
  token: {
    credentialId: number;
    userId: number;
    destination: string;
    remoteUser: string;
    /** The OAuth application the token was given to, for an OAuth token. */
    oauthClientId?: string;
  },
  opened: UserTokenSecret,
): Promise<{ saved: true } | { saved: false; reason: 'account-taken' | 'changed'; message: string }> {
  const taken = {
    saved: false as const,
    reason: 'account-taken' as const,
    message: `Another person already gave a token for the account "${token.remoteUser}": each person gives their own.`,
  };
  // The credential's destination or OAuth application changed while the token was tested: it is not saved.
  const [current] = await db
    .select({
      destination: credentials.destination,
      perUser: credentials.perUser,
      oauthClientId: credentials.oauthClientId,
    })
    .from(credentials)
    .where(eq(credentials.id, token.credentialId));
  if (
    !current?.perUser ||
    current.destination !== token.destination ||
    (token.oauthClientId !== undefined && current.oauthClientId !== token.oauthClientId)
  ) {
    return {
      saved: false,
      reason: 'changed',
      message: 'The credential changed while your token was tested: give it again.',
    };
  }
  const holders = await db
    .select({ userId: credentialUserTokens.userId, remoteUser: credentialUserTokens.remoteUser })
    .from(credentialUserTokens)
    .where(eq(credentialUserTokens.credentialId, token.credentialId));
  const account = token.remoteUser.toLowerCase();
  if (holders.some((h) => h.userId !== token.userId && h.remoteUser.toLowerCase() === account)) return taken;
  const now = new Date();
  const fields = {
    remoteUser: token.remoteUser,
    secret: sealUserToken(token, opened),
    state: 'ready',
    testedAt: now,
    expiresAt: opened.expiresAt ? new Date(opened.expiresAt) : null,
  };
  const own = and(
    eq(credentialUserTokens.credentialId, token.credentialId),
    eq(credentialUserTokens.userId, token.userId),
  );
  try {
    if (holders.some((h) => h.userId === token.userId)) {
      await db.update(credentialUserTokens).set(fields).where(own);
      return { saved: true };
    }
    try {
      await db
        .insert(credentialUserTokens)
        .values({ ...fields, credentialId: token.credentialId, userId: token.userId, createdAt: now });
    } catch (err) {
      // Two saves of one person's token at once: the slower one replaces the row the other inserted.
      if (!isUniqueViolation(err)) throw err;
      await db.update(credentialUserTokens).set(fields).where(own);
    }
  } catch (err) {
    // Another person saved the same account at the same moment: the account's unique index refuses the slower one.
    if (isUniqueViolation(err)) return taken;
    throw err;
  }
  return { saved: true };
}

/**
 * Record a test of a person's saved token: when it ran and, when the service
 * refused it, that it is `invalid`. A token saved again since the test started
 * (`startedAt`) is the person's new one, which the test did not send: it stays
 * as it is.
 */
export async function recordUserTokenTest(
  db: DbClient,
  token: { credentialId: number; userId: number },
  state: 'ready' | 'invalid' | null,
  startedAt: Date,
): Promise<void> {
  await db
    .update(credentialUserTokens)
    .set({ testedAt: new Date(), ...(state ? { state } : {}) })
    .where(
      and(
        eq(credentialUserTokens.credentialId, token.credentialId),
        eq(credentialUserTokens.userId, token.userId),
        lte(credentialUserTokens.testedAt, startedAt),
      ),
    );
}

/** Add one read to the row of its credential, feature, project, result and hour, or start that row. */
async function countRead(
  db: DbClient,
  row: typeof credentialUses.$inferInsert & { result: CredentialUseResult },
  perPerson = false,
): Promise<void> {
  const now = new Date();
  const hour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const [existing] = await db
    .select({ id: credentialUses.id })
    .from(credentialUses)
    .where(
      and(
        row.credentialId == null
          ? isNull(credentialUses.credentialId)
          : eq(credentialUses.credentialId, row.credentialId),
        eq(credentialUses.feature, row.feature),
        row.projectId == null ? isNull(credentialUses.projectId) : eq(credentialUses.projectId, row.projectId),
        eq(credentialUses.result, row.result),
        gte(credentialUses.createdAt, hour),
        ...(perPerson
          ? [row.userId == null ? isNull(credentialUses.userId) : eq(credentialUses.userId, row.userId)]
          : []),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(credentialUses)
      .set({
        count: sql`${credentialUses.count} + 1`,
        lastAt: now,
        reason: row.reason ?? null,
        userId: row.userId ?? null,
        apiKeyId: row.apiKeyId ?? null,
        remoteUser: row.remoteUser ?? null,
        subjectType: row.subjectType ?? null,
        subjectId: row.subjectId ?? null,
        destination: row.destination ?? null,
      })
      .where(eq(credentialUses.id, existing.id));
    return;
  }
  await db.insert(credentialUses).values({ ...row, count: 1, createdAt: now, lastAt: now });
}

/** Delete the log rows older than the cutoff. Returns how many went. */
export async function pruneCredentialUses(db: DbClient, olderThanDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * MS_PER_DAY);
  const deleted = await db
    .delete(credentialUses)
    .where(lt(credentialUses.lastAt, cutoff))
    .returning({ id: credentialUses.id });
  return deleted.length;
}

/** `name`, or `name (2)`, `name (3)`… : the first no credential has, ignoring case. */
export const freeName = (db: DbClient, name: string): Promise<string> => freeCredentialName(db as never, name);

/** The base URL and token a project's `ci_server_token` holds, or null. */
function openProjectToken(stored: string | null): { url: string; token: string } | null {
  if (!stored) return null;
  try {
    const value = JSON.parse(decryptSecret(stored, getEncryptionKey())) as { url?: unknown; token?: unknown };
    const url = normalizeCiServerBaseUrl(value.url);
    return url && typeof value.token === 'string' && value.token ? { url, token: value.token } : null;
  } catch {
    return null;
  }
}

/**
 * Move the project CI server tokens (`projects.ci_server_token`) into
 * credentials, once: each token becomes a credential bound to the URL it was
 * sealed with, shared with its project, with the user name of the actions it
 * served, and allowed with a Custom request and every input. It has no
 * creator, so an administrator manages it. A token equal to one already
 * imported, with the same URL and user, joins
 * that credential's projects instead. Each CI server action the token served
 * (its base URL, else the instance's, under the token's URL) names the
 * credential and drops its user name, and the project's token is emptied, in
 * one transaction per project. A token that cannot be opened is left as it is
 * and logged. Returns how many projects were moved.
 */
export async function importProjectCiServerTokens(db: DbClient): Promise<number> {
  const stored = await db
    .select({ id: projects.id, name: projects.name, ciRerun: projects.ciRerun, token: projects.ciServerToken })
    .from(projects)
    .where(sql`${projects.ciServerToken} is not null`);
  if (stored.length === 0) return 0;

  const instanceUrl = normalizeCiServerBaseUrl(process.env.PIWI_CI_SERVER_URL);
  const imported = new Map<string, number>();
  let moved = 0;
  for (const project of stored) {
    const token = openProjectToken(project.token);
    if (!token) {
      console.warn(`[credentials] The CI server token of project ${project.id} cannot be opened; it is left as it is`);
      continue;
    }
    await db.transaction(async (tx) => {
      // A value with no `actions` list converts to actions, as a save writes it.
      const settings = project.ciRerun ? resolveCiActionsSettings(project.ciRerun) : null;
      const served = (settings?.actions ?? []).filter((action) => {
        if (action.target.type !== 'ci-server' || action.target.credentialId) return false;
        const base = action.target.baseUrl ?? instanceUrl;
        return !!base && isUnderBaseUrl(token.url, base);
      });
      const users = [...new Set(served.map((a) => (a.target.type === 'ci-server' ? (a.target.user ?? null) : null)))];
      if (users.length === 0) users.push(null);

      const idByUser = new Map<string | null, number>();
      for (const user of users) {
        const key = JSON.stringify([token.url, user, token.token]);
        let id = imported.get(key);
        if (id === undefined) {
          const host = new URL(token.url).host;
          const now = new Date();
          const [row] = await tx
            .insert(credentials)
            .values({
              name: await freeName(tx as unknown as DbClient, `CI server token · ${host}${user ? ` · ${user}` : ''}`),
              service: 'ci-server',
              userName: user,
              destination: token.url,
              secret: sealCredentialSecret(token.url, token.token),
              allProjects: false,
              allowedInputs: null,
              customRequests: true,
              disabled: false,
              managedBy: 'db',
              createdAt: now,
              rotatedAt: now,
            })
            .returning({ id: credentials.id });
          id = row!.id;
          imported.set(key, id);
        }
        await tx.insert(credentialProjects).values({ credentialId: id, projectId: project.id }).onConflictDoNothing();
        idByUser.set(user, id);
      }

      const ciRerun =
        settings && served.length > 0
          ? {
              ...settings,
              actions: settings.actions.map((action) => {
                if (!served.includes(action) || action.target.type !== 'ci-server') return action;
                const { user, ...target } = action.target;
                // An action that sent under the instance URL keeps it: the credential's destination may be wider.
                const base =
                  !target.baseUrl && instanceUrl && instanceUrl !== token.url ? { baseUrl: instanceUrl } : {};
                return { ...action, target: { ...target, ...base, credentialId: idByUser.get(user ?? null)! } };
              }),
            }
          : project.ciRerun;
      await tx.update(projects).set({ ciRerun, ciServerToken: null }).where(eq(projects.id, project.id));
    });
    moved++;
  }
  return moved;
}

/** The app setting that held the instance's SCM token, which {@link importScmTokens} moves to credentials. */
const INSTANCE_SCM_TOKEN_SETTING = 'scm_token';

/** A stored SCM token, decrypted, or null when it cannot be opened. */
function openScmToken(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    return decryptSecret(stored, getEncryptionKey()).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Move the SCM tokens into credentials of the source control service, with
 * the rules of the CI server tokens' import. A project's token
 * (`projects.scm_token`) becomes a credential bound to the API of the
 * project's repository (`scmApiDestination`), shared with the project and
 * named by it; it waits while the project has no repository, or one on a
 * GitLab host `PIWI_SCM_GITLAB_HOSTS` does not list, and moves once a run or a
 * project admin sets one (`pinProjectRepository`, the project route). The
 * instance's (the `scm_token` app setting) becomes one credential per API it
 * could reach (GitHub's, Bitbucket's, the GitLab cloud's and each listed GitLab
 * host's), shared with all projects and listed as the instance's
 * (`scm_credentials`). A token equal to one this import already moved, for the
 * same destination, joins that credential. Each token moves in a transaction
 * of its own that first takes it from where it was, so two servers starting
 * together move it once, and a token that cannot be moved (it does not open,
 * or `PIWI_SECRET_KEY` is unset) is left as it is and logged. Each credential
 * has no creator, so an administrator manages it. Returns how many tokens
 * were moved.
 */
export async function importScmTokens(db: DbClient): Promise<number> {
  const gitlabHosts = configuredGitlabHosts();
  const stored = await db
    .select({
      id: projects.id,
      name: projects.name,
      label: projects.label,
      repositoryUrl: projects.repositoryUrl,
      token: projects.scmToken,
      credentialId: projects.scmCredentialId,
    })
    .from(projects)
    .where(isNotNull(projects.scmToken));

  const imported = new Map<string, number>();
  /** The credential of this token for this destination: the one this import made, else a new one. */
  const credentialFor = async (
    tx: DbClient,
    destination: string,
    token: string,
    name: string,
    allProjects: boolean,
  ): Promise<number> => {
    const key = JSON.stringify([destination, token]);
    const known = imported.get(key);
    if (known !== undefined) {
      if (allProjects) await tx.update(credentials).set({ allProjects: true }).where(eq(credentials.id, known));
      return known;
    }
    const now = new Date();
    const [row] = await tx
      .insert(credentials)
      .values({
        name: await freeName(tx, name),
        service: 'scm',
        userName: null,
        destination,
        secret: sealCredentialSecret(destination, token),
        allProjects,
        allowedInputs: null,
        customRequests: false,
        disabled: false,
        managedBy: 'db',
        createdAt: now,
        rotatedAt: now,
      })
      .returning({ id: credentials.id });
    return row!.id;
  };

  let moved = 0;
  for (const project of stored) {
    const destination = scmApiDestination(project.repositoryUrl);
    if (!destination || !scmDestinationHost(destination, gitlabHosts)) continue;
    const token = openScmToken(project.token);
    if (!token) {
      console.warn(`[credentials] The SCM token of project ${project.id} cannot be opened; it is left as it is`);
      continue;
    }
    try {
      const made = await db.transaction(async (tx) => {
        // Taken first: a second server moving the same token finds it gone and moves nothing.
        const taken = await tx
          .update(projects)
          .set({ scmToken: null })
          .where(and(eq(projects.id, project.id), eq(projects.scmToken, project.token!)))
          .returning({ id: projects.id });
        if (taken.length === 0) return null;
        const id = await credentialFor(
          tx as unknown as DbClient,
          destination,
          token,
          `Source control · ${project.label || project.name}`,
          false,
        );
        await tx.insert(credentialProjects).values({ credentialId: id, projectId: project.id }).onConflictDoNothing();
        await tx
          .update(projects)
          .set({ scmCredentialId: project.credentialId ?? id })
          .where(eq(projects.id, project.id));
        return { key: JSON.stringify([destination, token]), id };
      });
      if (made) {
        imported.set(made.key, made.id);
        moved++;
      }
    } catch (err) {
      console.warn(`[credentials] The SCM token of project ${project.id} could not be moved; it is left as it is`, err);
    }
  }

  const [setting] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, INSTANCE_SCM_TOKEN_SETTING));
  const instanceStored = (setting?.value as { value?: string } | undefined)?.value ?? null;
  if (!instanceStored) return moved;
  const token = openScmToken(instanceStored);
  if (!token) {
    console.warn('[credentials] The instance SCM token cannot be opened; it is left as it is');
    return moved;
  }
  const destinations = [
    SCM_API_DESTINATIONS.github,
    SCM_API_DESTINATIONS.bitbucket,
    SCM_API_DESTINATIONS.gitlab,
    ...[...gitlabHosts].map((host) => `https://${host}/`),
  ];
  try {
    const made = await db.transaction(async (tx) => {
      const taken = await tx
        .delete(appSettings)
        .where(eq(appSettings.key, INSTANCE_SCM_TOKEN_SETTING))
        .returning({ key: appSettings.key });
      if (taken.length === 0) return false;
      const ids: number[] = [];
      for (const destination of [...new Set(destinations)]) {
        const name = `Source control (instance) · ${new URL(destination).host}`;
        ids.push(await credentialFor(tx as unknown as DbClient, destination, token, name, true));
      }
      const listed = await readInstanceScmCredentialIds(tx as unknown as DbClient);
      const value = { ids: [...new Set([...listed, ...ids])] };
      await tx
        .insert(appSettings)
        .values({ key: INSTANCE_SCM_CREDENTIALS_SETTING, value, updatedAt: new Date() })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
      return true;
    });
    return made ? moved + 1 : moved;
  } catch (err) {
    console.warn('[credentials] The instance SCM token could not be moved; it is left as it is', err);
    return moved;
  }
}
