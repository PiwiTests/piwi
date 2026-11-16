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
import { and, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { appSettings, credentialProjects, credentials, credentialUses, projects } from '../database/schema';
import type { DbClient } from '../database';
import { decryptSecret, encryptSecret, getEncryptionKey } from './crypto';
import {
  CREDENTIAL_READ_FEATURES,
  credentialLogDestination,
  credentialRefusal,
  isCredentialSecretEnv,
  MAX_CREDENTIAL_NAME_LENGTH,
  type CredentialFeature,
  type CredentialService,
  type CredentialUseResult,
} from '#shared/credentials';
import {
  INSTANCE_SCM_CREDENTIALS_SETTING,
  loadCredentialRecord,
  readInstanceScmCredentialIds,
  type CredentialRecord,
} from '#shared/handlers/credentials';
import { SCM_API_DESTINATIONS, scmApiDestination, scmDestinationHost } from '#shared/scm-urls';
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
    return variable && (AI_KEY_ENV_VARS as readonly string[]).includes(variable) ? readSecretEnv(variable) : null;
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
    allowedInputs: (process.env.PIWI_CI_SERVER_ALLOWED_INPUTS ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  };
}

/**
 * Bring the credentials the environment sets in line with its variables: the
 * CI server's when `PIWI_CI_SERVER_URL` and `PIWI_CI_SERVER_TOKEN` are set,
 * removed when they are not. Its secret stays in the environment, so the row
 * holds none; it is shared with all projects, never goes with a Custom request,
 * and sends only the inputs of `PIWI_CI_SERVER_ALLOWED_INPUTS`.
 */
export async function ensureEnvCredentials(db: DbClient): Promise<void> {
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

/** A use the credential's rules refuse; its message names the credential and the reason, never the secret. */
export class CredentialRefusedError extends Error {}

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
 * credential, feature, project, result and hour once it ends. `failure` reads a failure from what
 * `send` returned (a refused answer); a throw is a failure too, rethrown with
 * the secret masked.
 */
export async function withCredential<T>(
  db: DbClient,
  use: CredentialUse,
  send: (opened: OpenedCredential) => Promise<T>,
  failure?: (value: T) => string | null,
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
  let refusal = record ? credentialRefusal(record, use) : 'The credential was deleted: pick another one.';
  let secret: string | null = null;
  if (!refusal && record && row) {
    if (row.managedBy === 'env') {
      secret = envSecret(record.service, row.secretEnv ?? null);
      if (!secret) refusal = `The credential "${name}" is set by environment variables that are unset.`;
    } else {
      const opened = openStoredSecret(row.secret, record.destination, row.secretEnv ?? null, name);
      if ('secret' in opened) secret = opened.secret;
      else refusal = opened.refusal;
    }
  }
  const base = {
    credentialId: record ? record.id : null,
    credentialName: name,
    feature: use.feature,
    projectId: use.projectId,
    userId: use.actor.userId,
    apiKeyId: use.actor.apiKeyId,
    subjectType: use.subject?.type ?? null,
    subjectId: use.subject?.id ?? null,
    destination: credentialLogDestination(use.url),
  };
  const read = CREDENTIAL_READ_FEATURES.includes(use.feature);
  if (refusal || !secret || !record) {
    const refused = { ...base, result: 'refused' as const, reason: cut(refusal) };
    if (read) await countRead(db, refused);
    else await db.insert(credentialUses).values(refused);
    throw new CredentialRefusedError(refusal ?? `The credential "${name}" cannot be used.`);
  }

  const opened: OpenedCredential = { user: record.user, secret };
  const [written] = read
    ? [null]
    : await db
        .insert(credentialUses)
        .values({ ...base, result: 'sent' })
        .returning({ id: credentialUses.id });
  await db.update(credentials).set({ lastUsedAt: new Date() }).where(eq(credentials.id, record.id));

  const settle = async (result: CredentialUseResult, reason: string | null) => {
    try {
      const masked = cut(reason ? maskCredentialSecret(reason, opened) : null);
      if (written) {
        await db
          .update(credentialUses)
          .set({ result, reason: masked, lastAt: new Date() })
          .where(eq(credentialUses.id, written.id));
      } else {
        await countRead(db, { ...base, result, reason: masked });
      }
    } catch (err) {
      console.error('[credentials] Recording a use failed:', err);
    }
  };

  let value: T;
  try {
    value = await send(opened);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await settle('failed', message);
    const masked = maskCredentialSecret(message, opened);
    throw masked === message ? e : new Error(masked);
  }
  const failed = failure?.(value) ?? null;
  await settle(failed ? 'failed' : 'ok', failed);
  return value;
}

/** Add one read to the row of its credential, feature, project, result and hour, or start that row. */
async function countRead(
  db: DbClient,
  row: typeof credentialUses.$inferInsert & { result: CredentialUseResult },
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
export async function freeName(db: DbClient, name: string): Promise<string> {
  const rows = await db.select({ name: credentials.name }).from(credentials);
  const taken = new Set(rows.map((r) => r.name.toLowerCase()));
  const base = name.slice(0, MAX_CREDENTIAL_NAME_LENGTH - 5);
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

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
