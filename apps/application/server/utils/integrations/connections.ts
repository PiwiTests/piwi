import { and, eq, inArray } from 'drizzle-orm';
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
  TestManagementConnectionSummary,
  TrackerSummary,
} from '#shared/integrations/types';
import {
  credentials as credentialRows,
  entityLinks,
  integrationConnections,
  projectIntegrations,
  type IntegrationConnection,
  type ProjectIntegration,
} from '../../database/schema';
import type { DbClient } from '../../database';
import { randomBytes } from 'node:crypto';
import { hashToken } from '../token-hash';
import type { CredentialActor } from '../credentials';
import { JiraClient, parseJiraIssueUrl } from './jira/client';
import { jiraCheckFailure } from './jira/check';
import { jiraFailureHint, normalizeJiraSiteUrl, type JiraTokenKind } from '#shared/integrations/jira-setup';
import { resolveTitlePrefix } from '#shared/integrations/title-prefix';
import type { IssueTracker, TrackerCredentials } from './types';
import {
  connectionEndpoint,
  ensureEnvConnectionCredential,
  isCredentialConnection,
  openConnectionCredentials,
  openCredentialForCheck,
  removeEnvConnectionCredential,
  saveConnectionCredential,
  type OpenedConnection,
} from './connection-credentials';
import {
  ZEPHYR_INTERACTIVE_TIMEOUT_MS,
  ZEPHYR_TOKEN_UNUSABLE,
  ZephyrScaleClient,
  type ZephyrClientOptions,
} from './test-management/zephyr-scale';
import { zephyrFailureHint } from './test-management/zephyr-check';
import { connectionPausedUntil } from './connection-pauses';
import { INTERACTIVE_MAX_WAIT_MS, limiterForConnection, RequestLimiterBusyError } from './test-management/limiter';
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

/** An environment-managed connection as the env vars describe it, with the user its credential names. */
interface EnvManagedConnection {
  name: string;
  baseUrl: string;
  config: Record<string, unknown>;
  user: string | null;
}

/** The environment-managed connection of each provider that has one, or null for a provider whose env vars are unset. */
const ENV_MANAGED: Partial<Record<IntegrationProviderName, () => EnvManagedConnection | null>> = {
  jira: () => {
    const env = envJiraCredentials();
    return env
      ? { name: ENV_JIRA_NAME, baseUrl: env.baseUrl, config: { flavor: jiraFlavor() }, user: env.email }
      : null;
  },
  'zephyr-scale': () => {
    const env = envZephyrCredentials();
    return env ? { name: ENV_ZEPHYR_NAME, baseUrl: env.baseUrl, config: { region: env.region }, user: null } : null;
  },
};

/**
 * Reconcile the environment-managed connections with the current env vars: create
 * or update the Jira connection when `PIWI_JIRA_*` are set and the Zephyr Scale one when
 * `PIWI_ZEPHYR_API_TOKEN` is, remove each when its variables are not. Each names a
 * read-only credential of the environment, whose token stays in the variable, so
 * it never needs `PIWI_SECRET_KEY`.
 */
export async function ensureEnvManagedConnections(db: DbClient): Promise<void> {
  for (const [provider, describe] of Object.entries(ENV_MANAGED) as Array<
    ['jira' | 'zephyr-scale', () => EnvManagedConnection | null]
  >) {
    const env = describe();
    const [existing] = await db
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.provider, provider), eq(integrationConnections.managedBy, 'env')));

    const endpoint = env ? connectionEndpoint(provider, env.baseUrl, env.config) : null;
    if (!env || !endpoint) {
      if (existing) await db.delete(integrationConnections).where(eq(integrationConnections.id, existing.id));
      await removeEnvConnectionCredential(db, provider);
      continue;
    }
    const credentialId = await ensureEnvConnectionCredential(db, provider, {
      name: env.name,
      endpoint,
      user: env.user,
    });

    if (existing) {
      if (existing.baseUrl !== env.baseUrl || existing.credentialId !== credentialId) {
        // Preserve any admin-set config (e.g. the webhook token's digest) across a base-URL change.
        const config = { ...((existing.config as Record<string, unknown> | null) ?? {}), ...env.config };
        await db
          .update(integrationConnections)
          .set({ baseUrl: env.baseUrl, config, credentialId, updatedAt: new Date() })
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
      credentialId,
      status: 'unverified',
      managedBy: 'env',
    });
  }
}

/** True when the connection names a credential, without opening it. */
export function connectionHasCredentials(row: IntegrationConnection): boolean {
  return isCredentialConnection(row.provider) && row.credentialId != null;
}

/** The name and user of the credentials the connections name, by id; never a secret. */
async function connectionCredentialLabels(
  db: DbClient,
  rows: IntegrationConnection[],
): Promise<Map<number, { name: string; user: string | null }>> {
  const ids = [...new Set(rows.map((row) => row.credentialId).filter((id): id is number => id != null))];
  if (ids.length === 0) return new Map();
  const labels = await db
    .select({ id: credentialRows.id, name: credentialRows.name, user: credentialRows.userName })
    .from(credentialRows)
    .where(inArray(credentialRows.id, ids));
  return new Map(labels.map((label) => [label.id, { name: label.name, user: label.user }]));
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

function toSummary(
  row: IntegrationConnection,
  labels: Map<number, { name: string; user: string | null }>,
): ConnectionSummary {
  const credential = row.credentialId != null ? labels.get(row.credentialId) : undefined;
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
    hasCredentials: connectionHasCredentials(row),
    credentialId: credential ? row.credentialId : null,
    credentialName: credential?.name ?? null,
    credentialValues: nonSecretCredentials(
      row.provider as IntegrationProviderName,
      credential?.user ? { email: credential.user } : null,
    ),
    hasWebhookToken: webhookTokenDigestFor(row) != null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

export async function listConnections(db: DbClient): Promise<ConnectionSummary[]> {
  await ensureEnvManagedConnections(db);
  const rows = await db.select().from(integrationConnections).orderBy(integrationConnections.id);
  await hashPlainWebhookTokens(db, rows);
  const labels = await connectionCredentialLabels(db, rows);
  return rows.map((row) => toSummary(row, labels));
}

export async function getConnectionRow(db: DbClient, id: number): Promise<IntegrationConnection | null> {
  const [row] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, id));
  return row ?? null;
}

export async function getConnection(db: DbClient, id: number): Promise<ConnectionSummary | null> {
  const row = await getConnectionRow(db, id);
  return row ? toSummary(row, await connectionCredentialLabels(db, [row])) : null;
}

/** The credential entries with a non-empty value; an empty or omitted map yields `{}`. */
function nonEmptyValues(credentials: Record<string, string> | null | undefined): Record<string, string> {
  if (!credentials) return {};
  return Object.fromEntries(Object.entries(credentials).filter(([, v]) => v != null && v !== ''));
}

/**
 * The credential a connection names once saved: the token typed in its form
 * creates or rotates one, a credential picked is named as it is, and a move to
 * another site or region keeps none that is not sent there, so a stored token
 * never goes to another host.
 */
async function savedCredentialId(
  db: DbClient,
  input: {
    provider: IntegrationProviderName;
    name: string;
    endpoint: string | null;
    typed: Record<string, string>;
    credentialId: number | null;
    createdBy: number | null;
  },
): Promise<{ id: number | null; changed: boolean }> {
  if (!isCredentialConnection(input.provider) || !input.endpoint) return { id: null, changed: false };
  return saveConnectionCredential(db, { ...input, provider: input.provider, endpoint: input.endpoint });
}

/** The fields of a connection's input that set its credential beside the typed ones. */
export interface ConnectionCredentialInput {
  /** The credential picked in the form; undefined keeps the one the connection names. */
  credentialId?: number | null;
  /** Who saves it: the owner of a credential the token typed creates. */
  createdBy?: number | null;
}

export async function createConnection(
  db: DbClient,
  input: ConnectionInput & ConnectionCredentialInput,
): Promise<ConnectionSummary> {
  if (!isIntegrationProvider(input.provider)) throw new Error(`Unknown provider: ${input.provider}`);
  const config = configWithoutWebhookToken(input.config);
  const { id: credentialId } = await savedCredentialId(db, {
    provider: input.provider,
    name: input.name,
    endpoint: connectionEndpoint(input.provider, input.baseUrl, config),
    typed: nonEmptyValues(input.credentials),
    credentialId: input.credentialId ?? null,
    createdBy: input.createdBy ?? null,
  });
  const [row] = await db
    .insert(integrationConnections)
    .values({
      provider: input.provider,
      name: input.name,
      baseUrl: input.baseUrl,
      config,
      credentials: null,
      credentialId,
      status: 'unverified',
      managedBy: 'db',
    })
    .returning();
  return toSummary(row!, await connectionCredentialLabels(db, [row!]));
}

export async function updateConnection(
  db: DbClient,
  id: number,
  input: Partial<ConnectionInput> & ConnectionCredentialInput,
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

  // A blank field keeps what the credential holds, so rotating the API token or
  // correcting the account e-mail never drops the other.
  const typed = nonEmptyValues(input.credentials);
  const saved = await savedCredentialId(db, {
    provider: row.provider as IntegrationProviderName,
    name: updates.name ?? row.name,
    endpoint: connectionEndpoint(
      row.provider,
      updates.baseUrl ?? row.baseUrl,
      (updates.config ?? row.config) as Record<string, unknown> | null,
    ),
    typed,
    credentialId: input.credentialId !== undefined ? input.credentialId : row.credentialId,
    createdBy: input.createdBy ?? null,
  });
  if (saved.id !== row.credentialId || saved.changed) {
    updates.credentialId = saved.id;
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

/**
 * Build a tracker client for a connection, or null when it cannot be resolved.
 * `actor` is who the use of its credential is logged under: the instance for a
 * background job.
 */
export async function createTracker(
  db: DbClient,
  connectionId: number,
  actor?: CredentialActor,
): Promise<IssueTracker | null> {
  const row = await getConnectionRow(db, connectionId);
  if (!row) return null;
  return openTracker(db, row, actor);
}

/** The scoped-token cloud id stored on the connection, or null. */
function cloudIdFromConfig(row: IntegrationConnection): string | null {
  const config = row.config as Record<string, unknown> | null;
  const cloudId = config?.cloudId;
  return typeof cloudId === 'string' && cloudId.length > 0 ? cloudId : null;
}

/** A Jira client from a connection's opened credential, its writes through the credential's gate. */
function jiraClientFor(row: IntegrationConnection, opened: OpenedConnection): IssueTracker | null {
  const { email, apiToken } = opened.values;
  if (!email || !apiToken) return null;
  return JiraClient.fromCredentials(row.baseUrl, { email, apiToken }, cloudIdFromConfig(row), opened.writeGate);
}

/**
 * Build a tracker client from an already-loaded connection row, opening its
 * credential as one counted read; null when it names none or the credential
 * is refused.
 */
export async function openTracker(
  db: DbClient,
  row: IntegrationConnection,
  actor?: CredentialActor,
): Promise<IssueTracker | null> {
  if (row.provider !== 'jira') return null;
  const opened = await openConnectionCredentials(db, row, actor);
  return opened && 'values' in opened ? jiraClientFor(row, opened) : null;
}

/** The issue key a URL on a tracker connection's site names, or null; reads no credential. */
export function parseConnectionIssueUrl(row: IntegrationConnection, url: string): { key: string } | null {
  return row.provider === 'jira' ? parseJiraIssueUrl(row.baseUrl, url) : null;
}

/** Build a test management client for a connection, or null when it is not one or cannot be resolved. */
export async function createTestManagement(
  db: DbClient,
  connectionId: number,
  actor?: CredentialActor,
): Promise<TestManagementProvider | null> {
  const row = await getConnectionRow(db, connectionId);
  if (!row) return null;
  return openTestManagement(db, row, {}, actor);
}

/**
 * How a test management client spends its time. `maxWaitMs` caps how long one request queues behind the limiter;
 * `deadlineAt` (epoch ms) is when the caller's whole budget ends, so a request whose turn comes after it is refused
 * rather than queued.
 */
export type TestManagementClientOptions = ZephyrClientOptions & { maxWaitMs?: number; deadlineAt?: number };

/** The longest a request may queue now: the smaller of its own cap and what is left of the caller's budget. */
function waitBudget(maxWaitMs: number | undefined, deadlineAt: number | undefined): number | undefined {
  if (deadlineAt === undefined) return maxWaitMs;
  const left = Math.max(0, deadlineAt - Date.now());
  return maxWaitMs === undefined ? left : Math.min(maxWaitMs, left);
}

/**
 * A test management client from a connection's opened credential. It calls the host of the row's region from the
 * registry; the row's stored address is never used.
 */
export function testManagementClientFor(
  row: IntegrationConnection,
  opened: OpenedConnection,
  options: TestManagementClientOptions,
): TestManagementProvider | null {
  const credentials: TestManagementCredentials | null = opened.values.apiToken
    ? { apiToken: opened.values.apiToken }
    : null;
  if (!credentials) return null;
  const region = (row.config as Record<string, unknown> | null)?.region;
  // Every call of a saved connection goes through its limiter, whoever makes it.
  const { maxWaitMs, deadlineAt, ...clientOptions } = options;
  const limited: ZephyrClientOptions = {
    beforeRequest: () => limiterForConnection(row.id).wait({ maxWaitMs: waitBudget(maxWaitMs, deadlineAt) }),
    writeGate: opened.writeGate,
    ...clientOptions,
  };
  return typeof region === 'string' ? ZephyrScaleClient.forRegion(region, credentials, limited) : null;
}

/**
 * Build a test management client from an already-loaded connection row, opening its credential as one counted read;
 * null when it is not one, names none, or the credential is refused.
 */
export async function openTestManagement(
  db: DbClient,
  row: IntegrationConnection,
  options: TestManagementClientOptions = {},
  actor?: CredentialActor,
): Promise<TestManagementProvider | null> {
  if (!isProviderOfKind(row.provider, 'test-management')) return null;
  const opened = await openConnectionCredentials(db, row, actor);
  return opened && 'values' in opened ? testManagementClientFor(row, opened, options) : null;
}

/** Every tracker connection with usable credentials — what drives the UI entry points. */
export async function listTrackerConnections(db: DbClient): Promise<TrackerSummary[]> {
  await ensureEnvManagedConnections(db);
  const rows = await db.select().from(integrationConnections);
  return rows
    .filter((r) => isProviderOfKind(r.provider, 'tracker') && connectionHasCredentials(r))
    .map((r) => ({
      id: r.id,
      provider: r.provider as IntegrationProviderName,
      name: r.name,
      baseUrl: r.baseUrl,
      titlePrefix: resolveTitlePrefix(null, r.config),
    }));
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
  const opened = await openConnectionCredentials(db, row);
  if (!opened || !('values' in opened) || !opened.values.email || !opened.values.apiToken) return null;
  return {
    baseUrl: row.baseUrl,
    email: opened.values.email,
    apiToken: opened.values.apiToken,
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

/**
 * Record the outcome of a read of a connection that is not a sign-in test: the reason it failed on the row, or null to
 * clear an earlier one. The connection's status is left as it is: a timeout does not make a token bad.
 */
export async function recordConnectionError(db: DbClient, id: number, error: string | null): Promise<void> {
  await db
    .update(integrationConnections)
    .set({ lastError: error, updatedAt: new Date() })
    .where(eq(integrationConnections.id, id));
}

/**
 * Record that a provider refused a connection's credentials (a 401 from a picker, a catalog read or a test): the
 * connection shows as failed, with the provider's reason, until the next successful test.
 */
export async function markConnectionFailed(db: DbClient, id: number, error: string): Promise<void> {
  await recordTest(db, id, { ok: false, error });
}

/**
 * Record that a provider accepted a connection's credentials by answering a real read (a full catalog read): the
 * connection shows as ok, and any earlier failure is cleared.
 */
export async function markConnectionOk(db: DbClient, id: number): Promise<void> {
  await recordTest(db, id, { ok: true });
}

/** Every test management connection with a stored token — what the project's binding form offers. */
export async function listTestManagementConnections(db: DbClient): Promise<TestManagementConnectionSummary[]> {
  await ensureEnvManagedConnections(db);
  const rows = await db.select().from(integrationConnections).orderBy(integrationConnections.id);
  return rows
    .filter((r) => isProviderOfKind(r.provider, 'test-management') && connectionHasCredentials(r))
    .map((r) => ({
      id: r.id,
      provider: r.provider as IntegrationProviderName,
      name: r.name,
      status: r.status as ConnectionSummary['status'],
    }));
}

/** Why a connection has no client: the refusal of its credential, or that it names none. */
function noClientError(opened: OpenedConnection | { refusal: string } | null): string {
  return opened && 'refusal' in opened ? opened.refusal : 'No credentials configured for this connection.';
}

/** Verify a connection with the provider's `whoAmI`, recording the outcome. */
export async function testConnection(
  db: DbClient,
  id: number,
  actor?: CredentialActor,
): Promise<ConnectionTestResult | null> {
  const row = await getConnectionRow(db, id);
  if (!row) return null;
  if (isProviderOfKind(row.provider, 'test-management')) return testTestManagementConnection(db, row, actor);
  const opened = row.provider === 'jira' ? await openConnectionCredentials(db, row, actor) : null;
  const tracker = opened && 'values' in opened ? jiraClientFor(row, opened) : null;
  if (!tracker) return { ok: false, error: noClientError(opened) };
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

/**
 * {@link testConnection} for a test management connection: its client's `whoAmI` on the region's host, the queue
 * for the limiter included, within {@link ZEPHYR_INTERACTIVE_TIMEOUT_MS}. A connection the provider rate limited is
 * not called until its pause ends.
 */
async function testTestManagementConnection(
  db: DbClient,
  row: IntegrationConnection,
  actor: CredentialActor | undefined,
): Promise<ConnectionTestResult> {
  const paused = connectionPausedUntil(row.id, new Date());
  if (paused) {
    return { ok: false, error: `Paused until ${paused.toISOString()}: the provider rate limited this connection` };
  }
  const opened = await openConnectionCredentials(db, row, actor);
  if (!opened || !('values' in opened) || !opened.values.apiToken) return { ok: false, error: noClientError(opened) };
  const client = testManagementClientFor(row, opened, {
    timeoutMs: ZEPHYR_INTERACTIVE_TIMEOUT_MS,
    signal: AbortSignal.timeout(ZEPHYR_INTERACTIVE_TIMEOUT_MS),
    maxWaitMs: INTERACTIVE_MAX_WAIT_MS,
    deadlineAt: Date.now() + ZEPHYR_INTERACTIVE_TIMEOUT_MS,
  });
  // A token the credential holds but the client refuses to send is not the same as no token at all.
  if (!client) return { ok: false, error: ZEPHYR_TOKEN_UNUSABLE };
  try {
    const account = await client.whoAmI();
    await recordTest(db, row.id, { ok: true });
    return { ok: true, account };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RequestLimiterBusyError) return { ok: false, error: message };
    await recordTest(db, row.id, { ok: false, error: message });
    return { ok: false, error: message, hint: zephyrFailureHint(err) };
  }
}

/**
 * The credentials of the connection being edited that a pre-save check may fill blank fields from, or an empty map:
 * those of its credential, opened as one counted read, only while `sameEndpoint` says the check calls the place the
 * connection already reaches.
 */
async function storedCredentialsForCheck(
  db: DbClient,
  input: { connectionId?: number | null; actor?: CredentialActor },
  provider: IntegrationProviderName,
  sameEndpoint: (row: IntegrationConnection) => boolean,
): Promise<Record<string, string>> {
  if (!input.connectionId) return {};
  const row = await getConnectionRow(db, input.connectionId);
  if (!row || row.provider !== provider || !sameEndpoint(row)) return {};
  const opened = await openConnectionCredentials(db, row, input.actor);
  return opened && 'values' in opened ? opened.values : {};
}

/**
 * The credentials a pre-save check signs in with: those of the saved credential
 * the form picked, else the submitted fields, each blank one taken from the
 * connection being edited. The stored ones are used only while the site stays
 * the same, so a stored token never goes to another host.
 */
export async function credentialsForCheck(
  db: DbClient,
  input: {
    siteUrl: string;
    credentials?: Record<string, string> | null;
    credentialId?: number | null;
    connectionId?: number | null;
    actor?: CredentialActor;
  },
): Promise<TrackerCredentials | null> {
  if (input.credentialId) {
    const endpoint = connectionEndpoint('jira', input.siteUrl, null);
    const picked = await openCredentialForCheck(db, 'jira', input.credentialId, endpoint, input.actor);
    return picked?.email && picked.apiToken ? { email: picked.email, apiToken: picked.apiToken } : null;
  }
  let merged = nonEmptyValues(input.credentials);
  if (!merged.email || !merged.apiToken) {
    const stored = await storedCredentialsForCheck(
      db,
      input,
      'jira',
      (row) => normalizeJiraSiteUrl(row.baseUrl)?.url === input.siteUrl,
    );
    merged = { ...nonEmptyValues(stored), ...merged };
  }
  return merged.email && merged.apiToken ? { email: merged.email, apiToken: merged.apiToken } : null;
}

/**
 * {@link credentialsForCheck} for a test management provider reached by region: a saved credential picked is sent
 * only under the region's API, and a blank token is taken from the connection being edited only while it is of the
 * same provider and its region is the one being checked.
 */
export async function regionCredentialsForCheck(
  db: DbClient,
  input: {
    provider: TestManagementProviderName;
    region: string;
    credentials?: Record<string, string> | null;
    credentialId?: number | null;
    connectionId?: number | null;
    actor?: CredentialActor;
  },
): Promise<TestManagementCredentials | null> {
  const typed = nonEmptyValues(input.credentials);
  const endpoint = connectionBaseUrl(input.provider, { region: input.region });
  if ('error' in endpoint) return null;
  if (input.credentialId) {
    const address = connectionEndpoint(input.provider, endpoint.baseUrl, { region: input.region });
    const picked = await openCredentialForCheck(db, input.provider, input.credentialId, address, input.actor);
    return picked?.apiToken ? { apiToken: picked.apiToken } : null;
  }
  const stored = typed.apiToken
    ? {}
    : await storedCredentialsForCheck(db, input, input.provider, (row) => row.baseUrl === endpoint.baseUrl);
  const apiToken = typed.apiToken || stored.apiToken;
  return apiToken ? { apiToken } : null;
}
