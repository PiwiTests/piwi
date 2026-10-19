import { and, eq } from 'drizzle-orm';
import {
  INTEGRATION_PROVIDERS,
  isIntegrationProvider,
  nonSecretCredentials,
  type IntegrationProviderName,
} from '#shared/integrations/registry';
import type {
  ConnectionInput,
  ConnectionSummary,
  ConnectionTestResult,
  TrackerSummary,
} from '#shared/integrations/types';
import {
  entityLinks,
  integrationConnections,
  projectIntegrations,
  type IntegrationConnection,
  type ProjectIntegration,
} from '../../database/schema';
import type { DbClient } from '../../database';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, getEncryptionKey } from '../crypto';
import { hashToken } from '../token-hash';
import { JiraClient } from './jira/client';
import { jiraCheckFailure } from './jira/check';
import { jiraFailureHint, normalizeJiraSiteUrl, type JiraTokenKind } from '#shared/integrations/jira-setup';
import type { IssueTracker, TrackerCredentials } from './types';

/** Providers whose registry entry is a tracker (as opposed to a wiki). */
const TRACKER_PROVIDERS: ReadonlySet<IntegrationProviderName> = new Set(
  (Object.keys(INTEGRATION_PROVIDERS) as IntegrationProviderName[]).filter(
    (name) => INTEGRATION_PROVIDERS[name].kind === 'tracker',
  ),
);

const ENV_JIRA_NAME = 'Jira (environment)';

/** The Jira credentials configured through the environment, or null. */
function envJiraCredentials(): { baseUrl: string; email: string; apiToken: string } | null {
  const baseUrl = process.env.PIWI_JIRA_BASE_URL;
  const email = process.env.PIWI_JIRA_EMAIL;
  const apiToken = process.env.PIWI_JIRA_API_TOKEN;
  if (baseUrl && email && apiToken) return { baseUrl, email, apiToken };
  return null;
}

function jiraFlavor(): 'cloud' {
  // Cloud is the only supported flavor.
  return 'cloud';
}

/**
 * Reconcile the environment-managed connections with the current env vars: create
 * or update the Jira connection when `PIWI_JIRA_*` are set, remove it when they
 * are not. Credentials for an env-managed connection live in the environment, so
 * the row's `credentials` column stays null and never needs `PIWI_SECRET_KEY`.
 */
export async function ensureEnvManagedConnections(db: DbClient): Promise<void> {
  const env = envJiraCredentials();
  const [existing] = await db
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.provider, 'jira'), eq(integrationConnections.managedBy, 'env')));

  if (!env) {
    if (existing) await db.delete(integrationConnections).where(eq(integrationConnections.id, existing.id));
    return;
  }

  if (existing) {
    if (existing.baseUrl !== env.baseUrl) {
      // Preserve any admin-set config (e.g. the webhook token's digest) across a base-URL change.
      const config = {
        ...((existing.config as Record<string, unknown> | null) ?? {}),
        flavor: jiraFlavor(),
      };
      await db
        .update(integrationConnections)
        .set({ baseUrl: env.baseUrl, config, updatedAt: new Date() })
        .where(eq(integrationConnections.id, existing.id));
    }
    return;
  }

  await db.insert(integrationConnections).values({
    provider: 'jira',
    name: ENV_JIRA_NAME,
    baseUrl: env.baseUrl,
    config: { flavor: jiraFlavor() },
    credentials: null,
    status: 'unverified',
    managedBy: 'env',
  });
}

/** True when the connection has usable credentials, without revealing them. */
function hasStoredCredentials(row: IntegrationConnection): boolean {
  if (row.managedBy === 'env') return envJiraCredentials() !== null;
  return !!row.credentials;
}

/** The connection's decrypted credential map, or null when absent or corrupt. */
function decryptCredentials(row: IntegrationConnection): Record<string, string> | null {
  if (!row.credentials) return null;
  try {
    return JSON.parse(decryptSecret(row.credentials, getEncryptionKey())) as Record<string, string>;
  } catch {
    return null; // corrupt credential blob
  }
}

/** The full credential map for a connection — from the environment or the stored blob. */
function credentialMap(row: IntegrationConnection): Record<string, string> | null {
  if (row.managedBy === 'env') {
    const env = envJiraCredentials();
    return env ? { email: env.email, apiToken: env.apiToken } : null;
  }
  return decryptCredentials(row);
}

/** Resolve the tracker credentials for a connection, decrypting DB-stored ones. */
function resolveTrackerCredentials(row: IntegrationConnection): TrackerCredentials | null {
  const parsed = credentialMap(row);
  if (parsed?.email && parsed.apiToken) return { email: parsed.email, apiToken: parsed.apiToken };
  return null;
}

/**
 * A config without its inbound-webhook entries: the token's SHA-256 digest
 * (`webhookTokenDigest`) and a token kept in plain text
 * (`webhookToken`). Neither is ever returned or accepted from a client.
 */
function configWithoutWebhookToken(config: unknown): Record<string, unknown> | null {
  if (!config || typeof config !== 'object') return null;
  const { webhookToken: _token, webhookTokenDigest: _digest, ...rest } = config as Record<string, unknown>;
  return rest;
}

/** The connection's config as the API returns it, without the webhook token. */
function publicConfig(row: IntegrationConnection): Record<string, unknown> | null {
  return configWithoutWebhookToken(row.config);
}

/** A connection's inbound-webhook token kept in plain text (`config.webhookToken`), or null. */
function plainWebhookToken(row: IntegrationConnection): string | null {
  const token = (row.config as Record<string, unknown> | null)?.webhookToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/** The SHA-256 digest of a connection's inbound-webhook token, or null when the webhook is off. */
function webhookTokenDigestFor(row: IntegrationConnection): string | null {
  const digest = (row.config as Record<string, unknown> | null)?.webhookTokenDigest;
  if (typeof digest === 'string' && digest.length > 0) return digest;
  const plain = plainWebhookToken(row);
  return plain ? hashToken(plain) : null;
}

/** A row's config with its webhook token kept as a digest only. */
function webhookDigestConfig(row: IntegrationConnection, digest: string): Record<string, unknown> {
  return { ...configWithoutWebhookToken(row.config), webhookTokenDigest: digest };
}

/** Replace the plain webhook token of each of `rows` that still holds one with its digest. */
async function hashPlainWebhookTokens(db: DbClient, rows: IntegrationConnection[]): Promise<void> {
  for (const row of rows) {
    const plain = plainWebhookToken(row);
    if (!plain) continue;
    const config = webhookDigestConfig(row, hashToken(plain));
    await db.update(integrationConnections).set({ config }).where(eq(integrationConnections.id, row.id));
    row.config = config;
  }
}

function toSummary(row: IntegrationConnection): ConnectionSummary {
  return {
    id: row.id,
    provider: row.provider as IntegrationProviderName,
    name: row.name,
    baseUrl: row.baseUrl,
    config: publicConfig(row),
    status: row.status as ConnectionSummary['status'],
    lastCheckedAt: row.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString() : null,
    lastError: row.lastError ?? null,
    managedBy: row.managedBy as ConnectionSummary['managedBy'],
    hasCredentials: hasStoredCredentials(row),
    credentialValues: nonSecretCredentials(row.provider as IntegrationProviderName, credentialMap(row)),
    hasWebhookToken: webhookTokenDigestFor(row) != null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

export async function listConnections(db: DbClient): Promise<ConnectionSummary[]> {
  await ensureEnvManagedConnections(db);
  const rows = await db.select().from(integrationConnections).orderBy(integrationConnections.id);
  await hashPlainWebhookTokens(db, rows);
  return rows.map(toSummary);
}

export async function getConnectionRow(db: DbClient, id: number): Promise<IntegrationConnection | null> {
  const [row] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, id));
  return row ?? null;
}

export async function getConnection(db: DbClient, id: number): Promise<ConnectionSummary | null> {
  const row = await getConnectionRow(db, id);
  return row ? toSummary(row) : null;
}

/** The credential entries with a non-empty value; an empty or omitted map yields `{}`. */
function nonEmptyValues(credentials: Record<string, string> | null | undefined): Record<string, string> {
  if (!credentials) return {};
  return Object.fromEntries(Object.entries(credentials).filter(([, v]) => v != null && v !== ''));
}

/** Encrypt a credential map, or null when it holds no non-empty value. */
function encryptCredentials(credentials: Record<string, string> | null | undefined): string | null {
  const entries = nonEmptyValues(credentials);
  if (Object.keys(entries).length === 0) return null;
  return encryptSecret(JSON.stringify(entries), getEncryptionKey());
}

export async function createConnection(db: DbClient, input: ConnectionInput): Promise<ConnectionSummary> {
  if (!isIntegrationProvider(input.provider)) throw new Error(`Unknown provider: ${input.provider}`);
  const [row] = await db
    .insert(integrationConnections)
    .values({
      provider: input.provider,
      name: input.name,
      baseUrl: input.baseUrl,
      config: configWithoutWebhookToken(input.config),
      credentials: encryptCredentials(input.credentials),
      status: 'unverified',
      managedBy: 'db',
    })
    .returning();
  return toSummary(row!);
}

export async function updateConnection(
  db: DbClient,
  id: number,
  input: Partial<ConnectionInput>,
): Promise<ConnectionSummary | null> {
  const row = await getConnectionRow(db, id);
  if (!row) return null;

  const updates: Partial<IntegrationConnection> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.baseUrl !== undefined) updates.baseUrl = input.baseUrl;
  if (input.config !== undefined) {
    // The webhook token is never returned, so a submitted config cannot carry it;
    // it changes only through the webhook-token endpoints.
    const digest = webhookTokenDigestFor(row);
    const config = configWithoutWebhookToken(input.config);
    updates.config = digest ? { ...config, webhookTokenDigest: digest } : config;
  }

  // Merge the submitted credential fields onto the stored ones. A blank field is
  // ignored, so changing one field — rotating the API token, or correcting the
  // account email — never drops the others. An empty map keeps the stored blob.
  // A move to another site keeps none of them: a stored token never goes to another host.
  const incoming = nonEmptyValues(input.credentials);
  const movedSite =
    input.baseUrl !== undefined && normalizeJiraSiteUrl(input.baseUrl)?.url !== normalizeJiraSiteUrl(row.baseUrl)?.url;
  const stored = movedSite ? {} : (decryptCredentials(row) ?? {});
  const changed = movedSite || Object.keys(incoming).some((key) => stored[key] !== incoming[key]);
  if (changed) {
    updates.credentials = encryptCredentials({ ...stored, ...incoming });
    updates.status = 'unverified';
  }

  await db.update(integrationConnections).set(updates).where(eq(integrationConnections.id, id));
  return getConnection(db, id);
}

export async function deleteConnection(db: DbClient, id: number): Promise<boolean> {
  const row = await getConnectionRow(db, id);
  if (!row) return false;
  // A deleted connection detaches from the links it enriched, keeping their URLs
  // (the documented "set null" behavior), then the row goes.
  await db.update(entityLinks).set({ connectionId: null }).where(eq(entityLinks.connectionId, id));
  await db.delete(integrationConnections).where(eq(integrationConnections.id, id));
  return true;
}

/** Build a tracker client for a connection, or null when it cannot be resolved. */
export async function createTracker(db: DbClient, connectionId: number): Promise<IssueTracker | null> {
  const row = await getConnectionRow(db, connectionId);
  if (!row) return null;
  return trackerForRow(row);
}

/** The scoped-token cloud id stored on the connection, or null. */
function cloudIdFromConfig(row: IntegrationConnection): string | null {
  const config = row.config as Record<string, unknown> | null;
  const cloudId = config?.cloudId;
  return typeof cloudId === 'string' && cloudId.length > 0 ? cloudId : null;
}

/** Build a tracker client from an already-loaded connection row. */
export function trackerForRow(row: IntegrationConnection): IssueTracker | null {
  if (row.provider !== 'jira') return null;
  const credentials = resolveTrackerCredentials(row);
  if (!credentials) return null;
  return JiraClient.fromCredentials(row.baseUrl, credentials, cloudIdFromConfig(row));
}

/** Every tracker connection with usable credentials — what drives the UI entry points. */
export async function listTrackerConnections(db: DbClient): Promise<TrackerSummary[]> {
  await ensureEnvManagedConnections(db);
  const rows = await db.select().from(integrationConnections);
  return rows
    .filter((r) => TRACKER_PROVIDERS.has(r.provider as IntegrationProviderName) && hasStoredCredentials(r))
    .map((r) => ({ id: r.id, provider: r.provider as IntegrationProviderName, name: r.name, baseUrl: r.baseUrl }));
}

/**
 * Generate (or rotate) the inbound-webhook token for a connection and store its
 * SHA-256 digest in `config.webhookTokenDigest`. Returns the token so the caller
 * can show it once; the database never holds it.
 */
export async function setWebhookToken(db: DbClient, id: number): Promise<string | null> {
  const row = await getConnectionRow(db, id);
  if (!row) return null;
  const token = randomBytes(24).toString('base64url');
  const config = webhookDigestConfig(row, hashToken(token));
  await db
    .update(integrationConnections)
    .set({ config, updatedAt: new Date() })
    .where(eq(integrationConnections.id, id));
  return token;
}

/** Clear a connection's inbound-webhook token, turning the webhook off. */
export async function clearWebhookToken(db: DbClient, id: number): Promise<void> {
  const row = await getConnectionRow(db, id);
  if (!row) return;
  await db
    .update(integrationConnections)
    .set({ config: configWithoutWebhookToken(row.config), updatedAt: new Date() })
    .where(eq(integrationConnections.id, id));
}

/**
 * The connection whose webhook token digest is the digest of `token`, or null.
 * The few connections an instance has are read whole, since the digest lives
 * in the JSON config; a token kept in plain text is replaced by its digest on the way.
 */
export async function connectionByWebhookToken(db: DbClient, token: string): Promise<IntegrationConnection | null> {
  if (!token) return null;
  const digest = hashToken(token);
  const rows = await db.select().from(integrationConnections);
  await hashPlainWebhookTokens(db, rows);
  return rows.find((r) => webhookTokenDigestFor(r) === digest) ?? null;
}

/** The per-project binding for a connection, or the first binding, or null. */
export async function getProjectBinding(
  db: DbClient,
  projectId: number,
  connectionId?: number | null,
): Promise<ProjectIntegration | null> {
  const rows = await db.select().from(projectIntegrations).where(eq(projectIntegrations.projectId, projectId));
  if (connectionId != null) return rows.find((r) => r.connectionId === connectionId) ?? null;
  return rows[0] ?? null;
}

/**
 * The Atlassian config for unfurling a Jira URL: the credentials of a Jira
 * connection whose base URL host matches the link's host, or null. Callers use
 * it for links that have no `connection_id` yet — a matching connection makes the
 * generic unfurl path work.
 */
export async function resolveJiraUnfurlConfig(
  db: DbClient,
  url: string,
): Promise<{ baseUrl: string; email: string; apiToken: string; cloudId: string | null } | null> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  await ensureEnvManagedConnections(db);
  const rows = await db.select().from(integrationConnections).where(eq(integrationConnections.provider, 'jira'));
  for (const row of rows) {
    let rowHost: string;
    try {
      rowHost = new URL(row.baseUrl).host;
    } catch {
      continue;
    }
    if (rowHost !== host) continue;
    const credentials = resolveTrackerCredentials(row);
    if (credentials) {
      return {
        baseUrl: row.baseUrl,
        email: credentials.email,
        apiToken: credentials.apiToken,
        cloudId: cloudIdFromConfig(row),
      };
    }
  }
  return null;
}

/** Verify a connection with the provider's `whoAmI`, recording the outcome. */
export async function testConnection(db: DbClient, id: number): Promise<ConnectionTestResult | null> {
  const row = await getConnectionRow(db, id);
  if (!row) return null;
  const tracker = trackerForRow(row);
  if (!tracker) {
    return { ok: false, error: 'No credentials configured for this connection.' };
  }
  try {
    const account = await tracker.whoAmI();
    // A scoped token resolves a cloud id while verifying; persist it so later
    // clients route through the gateway without re-detecting, and record the
    // token kind the connection card shows.
    const detected = tracker.detectedConfig?.() ?? null;
    const tokenKind: JiraTokenKind = detected?.cloudId ? 'scoped' : 'classic';
    const config = { ...((row.config as Record<string, unknown> | null) ?? {}), ...(detected ?? {}), tokenKind };
    await db
      .update(integrationConnections)
      .set({
        status: 'ok',
        lastCheckedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
        config,
      })
      .where(eq(integrationConnections.id, id));
    return { ok: true, account, tokenKind };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(integrationConnections)
      .set({ status: 'failed', lastCheckedAt: new Date(), lastError: message, updatedAt: new Date() })
      .where(eq(integrationConnections.id, id));
    const failure = jiraCheckFailure(err);
    return { ok: false, error: message, hint: failure ? jiraFailureHint('auth', failure) : null };
  }
}

/**
 * The credentials a pre-save check signs in with: the submitted fields, each
 * blank one taken from the connection being edited. The stored ones are used
 * only while the site stays the same, so a stored token never goes to another host.
 */
export async function credentialsForCheck(
  db: DbClient,
  input: { siteUrl: string; credentials?: Record<string, string> | null; connectionId?: number | null },
): Promise<TrackerCredentials | null> {
  let merged = nonEmptyValues(input.credentials);
  if (input.connectionId && (!merged.email || !merged.apiToken)) {
    const row = await getConnectionRow(db, input.connectionId);
    if (row && normalizeJiraSiteUrl(row.baseUrl)?.url === input.siteUrl) {
      merged = { ...(credentialMap(row) ?? {}), ...merged };
    }
  }
  return merged.email && merged.apiToken ? { email: merged.email, apiToken: merged.apiToken } : null;
}
