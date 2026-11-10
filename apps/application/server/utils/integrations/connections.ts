import { and, eq } from 'drizzle-orm';
import {
  connectionBaseUrl,
  isIntegrationProvider,
  isProviderOfKind,
  nonSecretCredentials,
  providerHasCapability,
  type IntegrationProviderName,
  type TestManagementProviderName,
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
import { ZEPHYR_TOKEN_UNUSABLE, ZephyrScaleClient } from './test-management/zephyr-scale';
import { zephyrFailureHint } from './test-management/zephyr-check';
import type { TestManagementCredentials, TestManagementProvider } from './test-management/types';

const ENV_JIRA_NAME = 'Jira (environment)';
const ENV_ZEPHYR_NAME = 'Zephyr Scale (environment)';
const DEFAULT_ZEPHYR_REGION = 'us';

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

/** Region values already reported as invalid, so the log names each one once. */
const reportedZephyrRegions = new Set<string>();

/** The Zephyr Scale credentials configured through the environment, or null. An invalid region is logged and ignored. */
function envZephyrCredentials(): { region: string; baseUrl: string; apiToken: string } | null {
  const apiToken = process.env.PIWI_ZEPHYR_API_TOKEN;
  if (!apiToken) return null;
  const requested = process.env.PIWI_ZEPHYR_REGION?.trim().toLowerCase() || DEFAULT_ZEPHYR_REGION;
  let endpoint = connectionBaseUrl('zephyr-scale', { region: requested });
  if ('error' in endpoint) {
    if (!reportedZephyrRegions.has(requested)) {
      reportedZephyrRegions.add(requested);
      console.warn(
        `[integrations] PIWI_ZEPHYR_REGION "${requested}" is not a Zephyr Scale region; using ${DEFAULT_ZEPHYR_REGION}`,
      );
    }
    endpoint = connectionBaseUrl('zephyr-scale', { region: DEFAULT_ZEPHYR_REGION });
  }
  if ('error' in endpoint || !endpoint.region) return null;
  return { region: endpoint.region, baseUrl: endpoint.baseUrl, apiToken };
}

/** The credential map an environment-managed connection of `provider` holds, or null when its env vars are unset. */
function envCredentialMap(provider: string): Record<string, string> | null {
  if (provider === 'jira') {
    const env = envJiraCredentials();
    return env ? { email: env.email, apiToken: env.apiToken } : null;
  }
  if (provider === 'zephyr-scale') {
    const env = envZephyrCredentials();
    return env ? { apiToken: env.apiToken } : null;
  }
  return null;
}

/** An environment-managed connection as the env vars describe it. */
interface EnvManagedConnection {
  name: string;
  baseUrl: string;
  config: Record<string, unknown>;
}

/** The environment-managed connection of each provider that has one, or null for a provider whose env vars are unset. */
const ENV_MANAGED: Partial<Record<IntegrationProviderName, () => EnvManagedConnection | null>> = {
  jira: () => {
    const env = envJiraCredentials();
    return env ? { name: ENV_JIRA_NAME, baseUrl: env.baseUrl, config: { flavor: jiraFlavor() } } : null;
  },
  'zephyr-scale': () => {
    const env = envZephyrCredentials();
    return env ? { name: ENV_ZEPHYR_NAME, baseUrl: env.baseUrl, config: { region: env.region } } : null;
  },
};

/**
 * Reconcile the environment-managed connections with the current env vars: create
 * or update the Jira connection when `PIWI_JIRA_*` are set and the Zephyr Scale one when
 * `PIWI_ZEPHYR_API_TOKEN` is, remove each when its variables are not. Credentials for an
 * env-managed connection live in the environment, so the row's `credentials` column stays
 * null and never needs `PIWI_SECRET_KEY`.
 */
export async function ensureEnvManagedConnections(db: DbClient): Promise<void> {
  for (const [provider, describe] of Object.entries(ENV_MANAGED)) {
    const env = describe();
    const [existing] = await db
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.provider, provider), eq(integrationConnections.managedBy, 'env')));

    if (!env) {
      if (existing) await db.delete(integrationConnections).where(eq(integrationConnections.id, existing.id));
      continue;
    }

    if (existing) {
      if (existing.baseUrl !== env.baseUrl) {
        // Preserve any admin-set config (e.g. the webhook token's digest) across a base-URL change.
        const config = { ...((existing.config as Record<string, unknown> | null) ?? {}), ...env.config };
        await db
          .update(integrationConnections)
          .set({ baseUrl: env.baseUrl, config, updatedAt: new Date() })
          .where(eq(integrationConnections.id, existing.id));
      }
      continue;
    }

    await db.insert(integrationConnections).values({
      provider,
      name: env.name,
      baseUrl: env.baseUrl,
      config: env.config,
      credentials: null,
      status: 'unverified',
      managedBy: 'env',
    });
  }
}

/** True when the connection has usable credentials, without revealing them. */
function hasStoredCredentials(row: IntegrationConnection): boolean {
  if (row.managedBy === 'env') return envCredentialMap(row.provider) !== null;
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
  if (row.managedBy === 'env') return envCredentialMap(row.provider);
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

/** Whether `baseUrl` is another place than where the connection's row reaches its provider. */
function movedEndpoint(row: IntegrationConnection, baseUrl: string): boolean {
  if (row.provider === 'jira') return normalizeJiraSiteUrl(baseUrl)?.url !== normalizeJiraSiteUrl(row.baseUrl)?.url;
  return baseUrl !== row.baseUrl;
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
  // A move to another site or region keeps none of them: a stored token never goes to another host.
  const incoming = nonEmptyValues(input.credentials);
  const movedSite = input.baseUrl !== undefined && movedEndpoint(row, input.baseUrl);
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

/** The test management credentials of a connection, or null when it holds no token. */
function resolveTestManagementCredentials(row: IntegrationConnection): TestManagementCredentials | null {
  const apiToken = credentialMap(row)?.apiToken;
  return apiToken ? { apiToken } : null;
}

/** Build a test management client for a connection, or null when it is not one or cannot be resolved. */
export async function createTestManagement(db: DbClient, connectionId: number): Promise<TestManagementProvider | null> {
  const row = await getConnectionRow(db, connectionId);
  if (!row) return null;
  return testManagementForRow(row);
}

/**
 * Build a test management client from an already-loaded connection row. It calls the host of the row's region from the
 * registry; the row's stored address is never used.
 */
export function testManagementForRow(row: IntegrationConnection): TestManagementProvider | null {
  if (!isProviderOfKind(row.provider, 'test-management')) return null;
  const credentials = resolveTestManagementCredentials(row);
  if (!credentials) return null;
  const region = (row.config as Record<string, unknown> | null)?.region;
  return typeof region === 'string' ? ZephyrScaleClient.forRegion(region, credentials) : null;
}

/** Every tracker connection with usable credentials — what drives the UI entry points. */
export async function listTrackerConnections(db: DbClient): Promise<TrackerSummary[]> {
  await ensureEnvManagedConnections(db);
  const rows = await db.select().from(integrationConnections);
  return rows
    .filter((r) => isProviderOfKind(r.provider, 'tracker') && hasStoredCredentials(r))
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
  return rows.find((r) => providerHasCapability(r.provider, 'webhook') && webhookTokenDigestFor(r) === digest) ?? null;
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
 * The Atlassian config for unfurling a Jira URL through one connection, the one
 * the link's project is bound to: its credentials when the URL is on its site,
 * else null. Callers use it for links that carry no `connection_id`, whose URL
 * the connection's own parser did not read as an issue.
 */
export async function resolveJiraUnfurlConfig(
  db: DbClient,
  url: string,
  connectionId: number | null,
): Promise<{ baseUrl: string; email: string; apiToken: string; cloudId: string | null } | null> {
  if (connectionId == null) return null;
  await ensureEnvManagedConnections(db);
  const row = await getConnectionRow(db, connectionId);
  if (row?.provider !== 'jira') return null;
  let sameSite: boolean;
  try {
    sameSite = new URL(url).host === new URL(row.baseUrl).host;
  } catch {
    return null;
  }
  if (!sameSite) return null;
  const credentials = resolveTrackerCredentials(row);
  if (!credentials) return null;
  return {
    baseUrl: row.baseUrl,
    email: credentials.email,
    apiToken: credentials.apiToken,
    cloudId: cloudIdFromConfig(row),
  };
}

/** Record the outcome of a connection test on its row. */
async function recordTest(
  db: DbClient,
  id: number,
  outcome: { ok: true; config?: Record<string, unknown> } | { ok: false; error: string },
): Promise<void> {
  const now = new Date();
  await db
    .update(integrationConnections)
    .set(
      outcome.ok
        ? {
            status: 'ok',
            lastCheckedAt: now,
            lastError: null,
            updatedAt: now,
            ...(outcome.config && { config: outcome.config }),
          }
        : { status: 'failed', lastCheckedAt: now, lastError: outcome.error, updatedAt: now },
    )
    .where(eq(integrationConnections.id, id));
}

/** Verify a connection with the provider's `whoAmI`, recording the outcome. */
export async function testConnection(db: DbClient, id: number): Promise<ConnectionTestResult | null> {
  const row = await getConnectionRow(db, id);
  if (!row) return null;
  if (isProviderOfKind(row.provider, 'test-management')) return testTestManagementConnection(db, row);
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
    await recordTest(db, id, { ok: true, config });
    return { ok: true, account, tokenKind };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordTest(db, id, { ok: false, error: message });
    const failure = jiraCheckFailure(err);
    return { ok: false, error: message, hint: failure ? jiraFailureHint('auth', failure) : null };
  }
}

/** {@link testConnection} for a test management connection: its client's `whoAmI` on the region's host. */
async function testTestManagementConnection(db: DbClient, row: IntegrationConnection): Promise<ConnectionTestResult> {
  const client = testManagementForRow(row);
  if (!client) {
    // A token the row holds but the client refuses to send is not the same as no token at all.
    return {
      ok: false,
      error: resolveTestManagementCredentials(row)
        ? ZEPHYR_TOKEN_UNUSABLE
        : 'No credentials configured for this connection.',
    };
  }
  try {
    const account = await client.whoAmI();
    await recordTest(db, row.id, { ok: true });
    return { ok: true, account };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordTest(db, row.id, { ok: false, error: message });
    return { ok: false, error: message, hint: zephyrFailureHint(err) };
  }
}

/**
 * The credentials of the connection being edited that a pre-save check may fill blank fields from, or an empty map:
 * the stored ones, only while `sameEndpoint` says the check calls the place the connection already reaches.
 */
async function storedCredentialsForCheck(
  db: DbClient,
  connectionId: number | null | undefined,
  provider: IntegrationProviderName,
  sameEndpoint: (row: IntegrationConnection) => boolean,
): Promise<Record<string, string>> {
  if (!connectionId) return {};
  const row = await getConnectionRow(db, connectionId);
  return row && row.provider === provider && sameEndpoint(row) ? (credentialMap(row) ?? {}) : {};
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
  if (!merged.email || !merged.apiToken) {
    const stored = await storedCredentialsForCheck(
      db,
      input.connectionId,
      'jira',
      (row) => normalizeJiraSiteUrl(row.baseUrl)?.url === input.siteUrl,
    );
    merged = { ...stored, ...merged };
  }
  return merged.email && merged.apiToken ? { email: merged.email, apiToken: merged.apiToken } : null;
}

/**
 * {@link credentialsForCheck} for a test management provider reached by region: a blank token is taken from the
 * connection being edited only while it is of the same provider and its region is the one being checked.
 */
export async function regionCredentialsForCheck(
  db: DbClient,
  input: {
    provider: TestManagementProviderName;
    region: string;
    credentials?: Record<string, string> | null;
    connectionId?: number | null;
  },
): Promise<TestManagementCredentials | null> {
  const typed = nonEmptyValues(input.credentials);
  const endpoint = connectionBaseUrl(input.provider, { region: input.region });
  if ('error' in endpoint) return null;
  const stored = typed.apiToken
    ? {}
    : await storedCredentialsForCheck(
        db,
        input.connectionId,
        input.provider,
        (row) => row.baseUrl === endpoint.baseUrl,
      );
  const apiToken = typed.apiToken || stored.apiToken;
  return apiToken ? { apiToken } : null;
}
