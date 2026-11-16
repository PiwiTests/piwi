/**
 * A Jira or Zephyr Scale connection's secret as a credential (services `jira`
 * and `zephyr-scale`): the address it is sent under, opening it for a client
 * (one counted `integration-read` use) with the gate each write goes through
 * (`integration-write`), saving the token typed in a connection form, the
 * read-only credential of a connection the environment sets, and the import of
 * the tokens connections held in their own row.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { credentials, integrationConnections, type IntegrationConnection } from '../../database/schema';
import type { DbClient } from '../../database';
import { decryptSecret, getEncryptionKey } from '../crypto';
import {
  CredentialRefusedError,
  freeName,
  sealCredentialSecret,
  withCredential,
  type CredentialActor,
  type CredentialWriteGate,
} from '../credentials';
import { insertCredential, loadCredentialRecord, updateCredential } from '#shared/handlers/credentials';
import { isUnderBaseUrl, normalizeCiServerBaseUrl } from '#shared/ci-server';
import { connectionBaseUrl } from '#shared/integrations/registry';
import { normalizeJiraSiteUrl } from '#shared/integrations/jira-setup';

const INSTANCE: CredentialActor = { userId: null, apiKeyId: null };

/** Whether a provider's connections keep their secret in a credential: Jira and Zephyr Scale. */
export function isCredentialConnection(provider: string): provider is 'jira' | 'zephyr-scale' {
  return provider === 'jira' || provider === 'zephyr-scale';
}

/**
 * The address a connection's credential is sent under: the Jira site (its
 * Atlassian gateway, reached for a scoped token, stands for it), or the API of
 * the Zephyr Scale region the connection names.
 */
export function connectionEndpoint(
  provider: string,
  baseUrl: string,
  config: Record<string, unknown> | null | undefined,
): string | null {
  if (provider === 'jira') return normalizeCiServerBaseUrl(normalizeJiraSiteUrl(baseUrl)?.url);
  if (provider === 'zephyr-scale') {
    const endpoint = connectionBaseUrl(provider, { region: config?.region as string | undefined });
    return 'error' in endpoint ? null : normalizeCiServerBaseUrl(endpoint.baseUrl);
  }
  return null;
}

/** The secret fields of a connection as its credential holds them: the e-mail as the user, the token as the secret. */
function credentialFields(provider: string, values: Record<string, string>): { user: string | null; secret: string } {
  return { user: provider === 'jira' ? values.email || null : null, secret: values.apiToken ?? '' };
}

/** A connection's field map, from what its credential opens to. */
function valuesOf(provider: string, opened: { user: string | null; secret: string }): Record<string, string> {
  return provider === 'jira' ? { email: opened.user ?? '', apiToken: opened.secret } : { apiToken: opened.secret };
}

/** A connection's credential, opened: its fields, and the gate each write goes through. */
export interface OpenedConnection {
  values: Record<string, string>;
  writeGate: CredentialWriteGate;
}

/**
 * A connection's secret, opened for a client through `withCredential` as one
 * counted read (`integration-read`), with the gate its writes go through
 * (`integration-write`, a log row each); `{ refusal }` when the credential's
 * rules refuse it (the refusal is logged), null when the connection names none.
 */
export async function openConnectionCredentials(
  db: DbClient,
  row: IntegrationConnection,
  actor: CredentialActor = INSTANCE,
): Promise<OpenedConnection | { refusal: string } | null> {
  if (row.credentialId == null) return null;
  const endpoint = connectionEndpoint(row.provider, row.baseUrl, row.config as Record<string, unknown> | null);
  if (!endpoint) return null;
  const use = { credentialId: row.credentialId, projectId: null, url: endpoint, custom: false, actor };
  try {
    const opened = await withCredential(db, { ...use, feature: 'integration-read' }, async (credential) => credential);
    return {
      values: valuesOf(row.provider, opened),
      writeGate: (run, failure) => withCredential(db, { ...use, feature: 'integration-write' }, () => run(), failure),
    };
  } catch (e) {
    if (e instanceof CredentialRefusedError) return { refusal: e.message };
    throw e;
  }
}

/** Whether a connection form's fields carry a token, which saves a credential rather than naming one. */
export function hasTypedToken(typed: Record<string, string> | null | undefined): boolean {
  return !!typed?.apiToken;
}

/**
 * Why a connection cannot name this credential, or null: it must hold a key for
 * the connection's provider, be shared with all projects (a connection serves
 * every project bound to it), and be sent under the connection's endpoint.
 */
export async function connectionCredentialProblem(
  db: DbClient,
  provider: string,
  credentialId: number,
  endpoint: string | null,
): Promise<string | null> {
  const record = await loadCredentialRecord(db, credentialId);
  if (!record || record.service !== provider) return `No ${provider} credential ${credentialId} exists.`;
  if (record.managedBy === 'env')
    return `The credential "${record.name}" is set by the environment for its own connection.`;
  if (!endpoint) return 'This connection has no address its credential could be sent to.';
  if (!record.allProjects) return `The credential "${record.name}" is not shared with all projects.`;
  if (!isUnderBaseUrl(record.destination, endpoint)) {
    return `The credential "${record.name}" is sent only under ${record.destination}, not to ${endpoint}.`;
  }
  return null;
}

/**
 * The fields of a saved credential a connection form picked, opened for its
 * pre-save check as one counted read; null when the connection could not name
 * it (see {@link connectionCredentialProblem}) or its rules refuse it.
 */
export async function openCredentialForCheck(
  db: DbClient,
  provider: 'jira' | 'zephyr-scale',
  credentialId: number,
  endpoint: string | null,
  actor: CredentialActor = INSTANCE,
): Promise<Record<string, string> | null> {
  if (!endpoint || (await connectionCredentialProblem(db, provider, credentialId, endpoint))) return null;
  try {
    const opened = await withCredential(
      db,
      { credentialId, feature: 'integration-read', projectId: null, url: endpoint, custom: false, actor },
      async (credential) => credential,
    );
    return valuesOf(provider, opened);
  } catch (e) {
    if (e instanceof CredentialRefusedError) return null;
    throw e;
  }
}

/**
 * Save the secret fields typed in a connection form: a token rotates the
 * credential the connection names while its destination holds the
 * connection's endpoint, or makes one shared with all projects, named after
 * the connection; an e-mail alone changes the user of the credential named.
 * Returns the credential the connection names next (null when nothing usable
 * was typed and it names none that fits), and whether its token or user changed.
 */
export async function saveConnectionCredential(
  db: DbClient,
  input: {
    provider: 'jira' | 'zephyr-scale';
    name: string;
    endpoint: string;
    typed: Record<string, string>;
    credentialId: number | null;
    createdBy: number | null;
  },
): Promise<{ id: number | null; changed: boolean }> {
  const named = input.credentialId ? await loadCredentialRecord(db, input.credentialId) : null;
  const fits = named && named.service === input.provider && isUnderBaseUrl(named.destination, input.endpoint);
  const ours = fits && named.managedBy === 'db' ? named : null;
  const { user, secret } = credentialFields(input.provider, input.typed);
  if (!secret) {
    const newUser = !!ours && !!user && user !== ours.user;
    if (newUser) await updateCredential(db, ours!.id, { user });
    return { id: fits ? named.id : null, changed: newUser };
  }
  const sealed = sealCredentialSecret(input.endpoint, secret);
  if (ours) {
    await updateCredential(db, ours.id, { destination: input.endpoint, ...(user ? { user } : {}) }, sealed);
    return { id: ours.id, changed: true };
  }
  if (input.provider === 'jira' && !user) return { id: null, changed: false };
  const id = await insertCredential(
    db,
    {
      name: await freeName(db, input.name),
      description: null,
      service: input.provider,
      user,
      destination: input.endpoint,
      scope: { allProjects: true },
      allowedInputs: null,
      customRequests: false,
      disabled: false,
    },
    sealed,
    input.createdBy,
  );
  return { id, changed: true };
}

/** The variable each provider's environment connection reads its token from. */
const ENV_TOKEN_VARIABLES = { jira: 'PIWI_JIRA_API_TOKEN', 'zephyr-scale': 'PIWI_ZEPHYR_API_TOKEN' } as const;

/**
 * The read-only credential of a connection the environment sets, kept in line
 * with its variables (its endpoint and, for Jira, its e-mail): the token stays
 * in the environment, and the row names the variable, never the token. Returns
 * its id.
 */
export async function ensureEnvConnectionCredential(
  db: DbClient,
  provider: 'jira' | 'zephyr-scale',
  env: { name: string; endpoint: string; user: string | null },
): Promise<number> {
  const [existing] = await db
    .select({ id: credentials.id, destination: credentials.destination, user: credentials.userName })
    .from(credentials)
    .where(and(eq(credentials.service, provider), eq(credentials.managedBy, 'env')));
  if (existing) {
    if (existing.destination !== env.endpoint || existing.user !== env.user) {
      await db
        .update(credentials)
        .set({ destination: env.endpoint, userName: env.user })
        .where(eq(credentials.id, existing.id));
    }
    return existing.id;
  }
  const [row] = await db
    .insert(credentials)
    .values({
      name: await freeName(db, env.name),
      service: provider,
      userName: env.user,
      destination: env.endpoint,
      secret: null,
      secretEnv: ENV_TOKEN_VARIABLES[provider],
      allProjects: true,
      allowedInputs: null,
      customRequests: false,
      disabled: false,
      managedBy: 'env',
    })
    .returning({ id: credentials.id });
  return row!.id;
}

/** Remove the read-only credential of a connection the environment no longer sets. */
export async function removeEnvConnectionCredential(db: DbClient, provider: 'jira' | 'zephyr-scale'): Promise<void> {
  await db.delete(credentials).where(and(eq(credentials.service, provider), eq(credentials.managedBy, 'env')));
}

/**
 * Move the tokens the Jira and Zephyr Scale connections held
 * (`integration_connections.credentials`, encrypted) into credentials, once,
 * at startup: each to one of its own, bound to the connection's endpoint,
 * shared with all projects and named after the connection. Each connection
 * moves in a transaction that first takes its secret from the row, so two
 * servers move it once; one that cannot be opened or moved is left as it is
 * and logged. Returns how many moved.
 */
export async function importConnectionCredentials(db: DbClient): Promise<number> {
  const rows = await db
    .select({
      id: integrationConnections.id,
      provider: integrationConnections.provider,
      name: integrationConnections.name,
      baseUrl: integrationConnections.baseUrl,
      config: integrationConnections.config,
      sealed: integrationConnections.credentials,
    })
    .from(integrationConnections)
    .where(and(eq(integrationConnections.managedBy, 'db'), isNotNull(integrationConnections.credentials)));
  let moved = 0;
  for (const row of rows) {
    if (!row.sealed || !isCredentialConnection(row.provider)) continue;
    const provider = row.provider;
    const endpoint = connectionEndpoint(provider, row.baseUrl, row.config as Record<string, unknown> | null);
    let values: Record<string, string>;
    try {
      values = JSON.parse(decryptSecret(row.sealed, getEncryptionKey())) as Record<string, string>;
    } catch {
      console.warn(`[credentials] The token of connection ${row.id} cannot be opened; it is left as it is`);
      continue;
    }
    const { user, secret } = credentialFields(provider, values);
    if (!endpoint || !secret || (provider === 'jira' && !user)) continue;
    try {
      const done = await db.transaction(async (tx) => {
        const taken = await tx
          .update(integrationConnections)
          .set({ credentials: null })
          .where(and(eq(integrationConnections.id, row.id), eq(integrationConnections.credentials, row.sealed!)))
          .returning({ id: integrationConnections.id });
        if (taken.length === 0) return false;
        const { id } = await saveConnectionCredential(tx as unknown as DbClient, {
          provider,
          name: row.name,
          endpoint,
          typed: values,
          credentialId: null,
          createdBy: null,
        });
        await tx.update(integrationConnections).set({ credentialId: id }).where(eq(integrationConnections.id, row.id));
        return true;
      });
      if (done) moved++;
    } catch (err) {
      console.warn(`[credentials] The token of connection ${row.id} could not be moved; it is left as it is`, err);
    }
  }
  return moved;
}
