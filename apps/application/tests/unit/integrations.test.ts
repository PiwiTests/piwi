import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const { JiraClient } = await import('../../server/utils/integrations/jira/client');
const {
  createConnection,
  updateConnection,
  listConnections,
  getConnectionRow,
  createTracker,
  ensureEnvManagedConnections,
  testConnection,
  credentialsForCheck,
  setWebhookToken,
  clearWebhookToken,
  connectionByWebhookToken,
} = await import('../../server/utils/integrations/connections');
const { hashToken } = await import('../../server/utils/token-hash');
const { detectProviderWithConnections } = await import('../../server/utils/integrations/link-resolve');

/** A minimal `fetch` Response carrying JSON, or a non-2xx status. */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('JiraClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const client = new JiraClient({ baseUrl: 'https://acme.atlassian.net/', email: 'me@acme.io', apiToken: 'tok' });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test('whoAmI sends Basic auth and maps the account', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accountId: 'a1', displayName: 'Ada' }));
    expect(await client.whoAmI()).toEqual({ id: 'a1', displayName: 'Ada' });
    const call = fetchMock.mock.calls.at(-1)!;
    expect(call[0]).toBe('https://acme.atlassian.net/rest/api/3/myself');
    const headers = call[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('me@acme.io:tok').toString('base64')}`);
  });

  test('getIssue maps status category to a color token and the assignee', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        key: 'PROJ-7',
        fields: {
          summary: 'Login broken',
          status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          assignee: { accountId: 'u2', displayName: 'Bob', emailAddress: 'bob@acme.io' },
        },
      }),
    );
    expect(await client.getIssue('PROJ-7')).toEqual({
      id: null,
      key: 'PROJ-7',
      url: 'https://acme.atlassian.net/browse/PROJ-7',
      title: 'Login broken',
      status: 'In Progress',
      statusCategory: 'indeterminate',
      statusColor: 'warning',
      assignee: { id: 'u2', displayName: 'Bob', email: 'bob@acme.io' },
    });
  });

  test('getIssue maps new and done categories to info and success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ key: 'P-1', fields: { status: { name: 'To Do', statusCategory: { key: 'new' } } } }),
    );
    expect((await client.getIssue('P-1'))?.statusColor).toBe('info');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ key: 'P-2', fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } }),
    );
    expect((await client.getIssue('P-2'))?.statusColor).toBe('success');
  });

  test('getIssue returns null on 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 404));
    expect(await client.getIssue('NOPE-1')).toBeNull();
  });

  test('issueUrl trims a trailing slash on the base URL', () => {
    expect(client.issueUrl('PROJ-3')).toBe('https://acme.atlassian.net/browse/PROJ-3');
  });

  test('parseIssueUrl recognizes browse and project URLs on the connection host only', () => {
    expect(client.parseIssueUrl('https://acme.atlassian.net/browse/PROJ-123')).toEqual({ key: 'PROJ-123' });
    expect(client.parseIssueUrl('https://acme.atlassian.net/browse/proj-9?x=1')).toEqual({ key: 'PROJ-9' });
    expect(client.parseIssueUrl('https://acme.atlassian.net/jira/software/c/projects/PROJ/issues/PROJ-42')).toEqual({
      key: 'PROJ-42',
    });
    expect(
      client.parseIssueUrl('https://acme.atlassian.net/jira/software/c/projects/PROJ/boards/1?selectedIssue=PROJ-8'),
    ).toEqual({ key: 'PROJ-8' });
    // A different host is not this connection's issue.
    expect(client.parseIssueUrl('https://other.atlassian.net/browse/PROJ-1')).toBeNull();
    expect(client.parseIssueUrl('https://acme.atlassian.net/wiki/spaces/DOC/pages/123')).toBeNull();
  });

  test('a scoped token is detected on a 401 and retried through the api.atlassian.com gateway', async () => {
    const scoped = new JiraClient({ baseUrl: 'https://scoped.atlassian.net', email: 's@acme.io', apiToken: 'stok' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'Client must be authenticated' }, false, 401)) // site /myself
      .mockResolvedValueOnce(jsonResponse({ cloudId: 'cloud-abc' })) // _edge/tenant_info
      .mockResolvedValueOnce(jsonResponse({ accountId: 'a1', displayName: 'Ada' })); // gateway /myself
    expect(await scoped.whoAmI()).toEqual({ id: 'a1', displayName: 'Ada' });

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe('https://scoped.atlassian.net/rest/api/3/myself');
    expect(urls[1]).toBe('https://scoped.atlassian.net/_edge/tenant_info');
    expect(urls[2]).toBe('https://api.atlassian.com/ex/jira/cloud-abc/rest/api/3/myself');
    // The resolved cloud id is offered for the connection layer to persist.
    expect(scoped.detectedConfig()).toEqual({ cloudId: 'cloud-abc' });
    // Browse links stay on the site host, not the gateway.
    expect(scoped.issueUrl('PROJ-3')).toBe('https://scoped.atlassian.net/browse/PROJ-3');
  });

  test('a known cloud id routes straight through the gateway, with no probe', async () => {
    const scoped = new JiraClient({
      baseUrl: 'https://preset.atlassian.net',
      email: 'p@acme.io',
      apiToken: 'ptok',
      cloudId: 'preset-cloud',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ accountId: 'a2', displayName: 'Bo' }));
    await scoped.whoAmI();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.atlassian.com/ex/jira/preset-cloud/rest/api/3/myself');
  });

  test('a 401 with no resolvable cloud id surfaces the auth error (self-hosted, no gateway)', async () => {
    const selfHosted = new JiraClient({ baseUrl: 'https://jira.company.com', email: 'u@co', apiToken: 'x' });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, false, 401)) // site /myself → 401
      .mockResolvedValueOnce(jsonResponse({}, false, 404)); // _edge/tenant_info → no cloud id
    await expect(selfHosted.whoAmI()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2); // no gateway retry
    expect(selfHosted.detectedConfig()).toBeNull();
  });
});

describe('connections and link resolution', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let dbc: DbClient;
  let tmpDir: string;
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    delete process.env.PIWI_JIRA_BASE_URL;
    delete process.env.PIWI_JIRA_EMAIL;
    delete process.env.PIWI_JIRA_API_TOKEN;
    tmpDir = mkdtempSync(join(tmpdir(), 'piwi-integrations-'));
    client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    dbc = db as unknown as DbClient;
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.PIWI_JIRA_BASE_URL;
    delete process.env.PIWI_JIRA_EMAIL;
    delete process.env.PIWI_JIRA_API_TOKEN;
  });

  test('a DB connection never returns its credentials, only hasCredentials', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Team Jira',
      baseUrl: 'https://team.atlassian.net',
      credentials: { email: 'me@team.io', apiToken: 'secret-token' },
    });
    expect(created.hasCredentials).toBe(true);
    expect('credentials' in created).toBe(false);

    const list = await listConnections(dbc);
    expect(list).toHaveLength(1);
    expect(list[0]!.hasCredentials).toBe(true);
    expect(JSON.stringify(list[0])).not.toContain('secret-token');

    // The stored blob is encrypted, not the plaintext token.
    const row = await getConnectionRow(dbc, created.id);
    expect(row?.credentials).toBeTruthy();
    expect(row?.credentials).not.toContain('secret-token');
    expect(row?.credentials?.startsWith('v1:')).toBe(true);
  });

  test('an empty credential map keeps the stored credential (redaction round-trip)', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Team Jira',
      baseUrl: 'https://team.atlassian.net',
      credentials: { email: 'me@team.io', apiToken: 'secret-token' },
    });
    const tracker = await createTracker(dbc, created.id);
    expect(tracker).not.toBeNull();
    expect(tracker!.provider).toBe('jira');
  });

  test('the summary exposes the non-secret account email but never the API token', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Team Jira',
      baseUrl: 'https://team.atlassian.net',
      credentials: { email: 'me@team.io', apiToken: 'secret-token' },
    });
    expect(created.credentialValues).toEqual({ email: 'me@team.io' });
    expect(JSON.stringify(created)).not.toContain('secret-token');

    const [listed] = await listConnections(dbc);
    expect(listed!.credentialValues.email).toBe('me@team.io');
    expect(JSON.stringify(listed)).not.toContain('secret-token');
  });

  test('rotating only the API token keeps the stored account email', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Team Jira',
      baseUrl: 'https://team.atlassian.net',
      credentials: { email: 'me@team.io', apiToken: 'secret-token' },
    });

    // The edit form resubmits only the token; the email field is left blank.
    const updated = await updateConnection(dbc, created.id, { credentials: { apiToken: 'rotated-token' } });
    expect(updated?.credentialValues.email).toBe('me@team.io');
    expect(updated?.status).toBe('unverified');

    // Both fields survived, so the connection still resolves a tracker.
    const tracker = await createTracker(dbc, created.id);
    expect(tracker).not.toBeNull();
  });

  test('moving a connection to another site keeps none of the stored credentials', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Team Jira',
      baseUrl: 'https://team.atlassian.net',
      credentials: { email: 'me@team.io', apiToken: 'secret-token' },
    });

    const moved = await updateConnection(dbc, created.id, { baseUrl: 'https://attacker.example' });
    expect(moved?.credentialValues.email).toBeUndefined();
    expect(moved?.status).toBe('unverified');
    expect(await createTracker(dbc, created.id)).toBeNull();

    // Resubmitting the same site keeps them.
    const again = await createConnection(dbc, {
      provider: 'jira',
      name: 'Team Jira 2',
      baseUrl: 'https://team.atlassian.net',
      credentials: { email: 'me@team.io', apiToken: 'secret-token' },
    });
    const same = await updateConnection(dbc, again.id, { baseUrl: 'https://team.atlassian.net/' });
    expect(same?.credentialValues.email).toBe('me@team.io');
  });

  test('correcting only the account email keeps the stored API token', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Team Jira',
      baseUrl: 'https://team.atlassian.net',
      credentials: { email: 'typo@team.io', apiToken: 'secret-token' },
    });

    const updated = await updateConnection(dbc, created.id, { credentials: { email: 'correct@team.io' } });
    expect(updated?.credentialValues.email).toBe('correct@team.io');

    // The token was not resubmitted but still resolves a tracker (needs both fields).
    const tracker = await createTracker(dbc, created.id);
    expect(tracker).not.toBeNull();
  });

  test('resubmitting the same account email keeps a verified connection verified', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Team Jira',
      baseUrl: 'https://team.atlassian.net',
      credentials: { email: 'me@team.io', apiToken: 'secret-token' },
    });
    // Mark it verified as a successful `test connection` would.
    await db
      .update(schema.integrationConnections)
      .set({ status: 'ok' })
      .where(eq(schema.integrationConnections.id, created.id));

    // Rename the connection while echoing back the pre-filled, unchanged email.
    const updated = await updateConnection(dbc, created.id, {
      name: 'Renamed',
      credentials: { email: 'me@team.io' },
    });
    expect(updated?.name).toBe('Renamed');
    expect(updated?.status).toBe('ok'); // an unchanged credential must not re-flag as unverified
    expect(updated?.credentialValues.email).toBe('me@team.io');
  });

  test('env vars create a read-only env-managed connection, removed when unset', async () => {
    process.env.PIWI_JIRA_BASE_URL = 'https://env.atlassian.net';
    process.env.PIWI_JIRA_EMAIL = 'env@acme.io';
    process.env.PIWI_JIRA_API_TOKEN = 'env-token';

    const list = await listConnections(dbc);
    expect(list).toHaveLength(1);
    expect(list[0]!.managedBy).toBe('env');
    expect(list[0]!.hasCredentials).toBe(true);
    expect(list[0]!.baseUrl).toBe('https://env.atlassian.net');
    // The account email comes from the environment and is shown, never the token.
    expect(list[0]!.credentialValues.email).toBe('env@acme.io');
    expect(JSON.stringify(list[0])).not.toContain('env-token');

    // The env-managed connection resolves a tracker from the environment.
    const tracker = await createTracker(dbc, list[0]!.id);
    expect(tracker?.provider).toBe('jira');

    // Removing the env vars removes the connection.
    delete process.env.PIWI_JIRA_BASE_URL;
    delete process.env.PIWI_JIRA_EMAIL;
    delete process.env.PIWI_JIRA_API_TOKEN;
    expect(await listConnections(dbc)).toHaveLength(0);
  });

  test('detectProviderWithConnections recognizes a self-hosted Jira once connected', async () => {
    const url = 'https://jira.company.com/browse/XYZ-99';

    // Without a connection, the self-hosted host stays generic.
    const before = await detectProviderWithConnections(dbc, url);
    expect(before).toEqual({ provider: 'generic', connectionId: null, key: null });

    const conn = await createConnection(dbc, {
      provider: 'jira',
      name: 'Self-hosted',
      baseUrl: 'https://jira.company.com',
      credentials: { email: 'a@b.io', apiToken: 't' },
    });

    const after = await detectProviderWithConnections(dbc, url);
    expect(after).toEqual({ provider: 'jira', connectionId: conn.id, key: 'XYZ-99' });
  });

  test('ensureEnvManagedConnections updates the base URL in place', async () => {
    process.env.PIWI_JIRA_BASE_URL = 'https://one.atlassian.net';
    process.env.PIWI_JIRA_EMAIL = 'env@acme.io';
    process.env.PIWI_JIRA_API_TOKEN = 'env-token';
    await ensureEnvManagedConnections(dbc);
    let list = await listConnections(dbc);
    expect(list).toHaveLength(1);

    process.env.PIWI_JIRA_BASE_URL = 'https://two.atlassian.net';
    await ensureEnvManagedConnections(dbc);
    list = await listConnections(dbc);
    expect(list).toHaveLength(1);
    expect(list[0]!.baseUrl).toBe('https://two.atlassian.net');
  });

  test('testConnection resolves a scoped token and persists its cloud id on the connection', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Scoped',
      baseUrl: 'https://scoped-conn.atlassian.net',
      credentials: { email: 'sc@team.io', apiToken: 'sc-tok' },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, false, 401)) // site /myself → scoped token rejected
      .mockResolvedValueOnce(jsonResponse({ cloudId: 'conn-cloud-1' })) // _edge/tenant_info
      .mockResolvedValueOnce(jsonResponse({ accountId: 'acct-9', displayName: 'Zoe' })); // gateway /myself
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await testConnection(dbc, created.id);
      expect(result).toMatchObject({ ok: true, account: { id: 'acct-9' }, tokenKind: 'scoped' });
    } finally {
      vi.unstubAllGlobals();
    }

    const row = await getConnectionRow(dbc, created.id);
    expect((row?.config as Record<string, unknown> | null)?.cloudId).toBe('conn-cloud-1');
    expect(row?.status).toBe('ok');
  });

  test('a failed testConnection explains a refused token', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Refused',
      baseUrl: 'https://refused.atlassian.net',
      credentials: { email: 'r@team.io', apiToken: 'bad' },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, false, 401)) // site /myself
        .mockResolvedValueOnce(jsonResponse({}, false, 404)), // _edge/tenant_info: no cloud id, no retry
    );
    try {
      const result = await testConnection(dbc, created.id);
      expect(result?.ok).toBe(false);
      expect(result?.hint).toMatch(/email and token/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('editing a connection keeps its webhook token, which the edit form never sees', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Hooked',
      baseUrl: 'https://hooked.atlassian.net',
      credentials: { email: 'h@team.io', apiToken: 'tok' },
    });
    const token = await setWebhookToken(dbc, created.id);
    const summary = (await listConnections(dbc)).find((c) => c.id === created.id)!;
    expect(summary.config).not.toHaveProperty('webhookToken');

    await updateConnection(dbc, created.id, { name: 'Renamed', config: { ...summary.config, locale: 'fr' } });
    const row = await getConnectionRow(dbc, created.id);
    expect(row?.config).toEqual({ locale: 'fr', webhookTokenDigest: hashToken(token!) });
  });

  test('a webhook token is stored as its digest, matched by it, and cleared', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Digest',
      baseUrl: 'https://digest.atlassian.net',
      credentials: { email: 'd@team.io', apiToken: 'tok' },
    });
    const token = (await setWebhookToken(dbc, created.id))!;
    expect(JSON.stringify((await getConnectionRow(dbc, created.id))?.config)).not.toContain(token);
    expect((await connectionByWebhookToken(dbc, token))?.id).toBe(created.id);
    expect(await connectionByWebhookToken(dbc, `${token}x`)).toBeNull();

    await clearWebhookToken(dbc, created.id);
    expect(await connectionByWebhookToken(dbc, token)).toBeNull();
    expect((await getConnectionRow(dbc, created.id))?.config).toEqual({});
  });

  test('a webhook token kept in plain text keeps working and is replaced by its digest on read', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Legacy',
      baseUrl: 'https://legacy.atlassian.net',
      credentials: { email: 'l@team.io', apiToken: 'tok' },
    });
    await dbc
      .update(schema.integrationConnections)
      .set({ config: { locale: 'en', webhookToken: 'legacy-plain-token' } })
      .where(eq(schema.integrationConnections.id, created.id));

    expect((await connectionByWebhookToken(dbc, 'legacy-plain-token'))?.id).toBe(created.id);
    expect((await getConnectionRow(dbc, created.id))?.config).toEqual({
      locale: 'en',
      webhookTokenDigest: hashToken('legacy-plain-token'),
    });
    expect((await connectionByWebhookToken(dbc, 'legacy-plain-token'))?.id).toBe(created.id);
  });

  test('a client cannot set a webhook token through a connection config', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Injected',
      baseUrl: 'https://injected.atlassian.net',
      config: { webhookToken: 'chosen', webhookTokenDigest: hashToken('chosen') },
      credentials: { email: 'i@team.io', apiToken: 'tok' },
    });
    expect(await connectionByWebhookToken(dbc, 'chosen')).toBeNull();
    await updateConnection(dbc, created.id, { config: { webhookTokenDigest: hashToken('chosen') } });
    expect(await connectionByWebhookToken(dbc, 'chosen')).toBeNull();
  });

  test('a pre-save check fills a blank token from the edited connection, on the same site only', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Edited',
      baseUrl: 'https://edited.atlassian.net/',
      credentials: { email: 'e@team.io', apiToken: 'stored-token' },
    });
    const sameSite = await credentialsForCheck(dbc, {
      siteUrl: 'https://edited.atlassian.net',
      credentials: { email: 'new@team.io', apiToken: '' },
      connectionId: created.id,
    });
    expect(sameSite).toEqual({ email: 'new@team.io', apiToken: 'stored-token' });

    const otherSite = await credentialsForCheck(dbc, {
      siteUrl: 'https://elsewhere.atlassian.net',
      credentials: { email: 'new@team.io' },
      connectionId: created.id,
    });
    expect(otherSite).toBeNull();

    const typed = await credentialsForCheck(dbc, {
      siteUrl: 'https://elsewhere.atlassian.net',
      credentials: { email: 'x@team.io', apiToken: 'typed' },
    });
    expect(typed).toEqual({ email: 'x@team.io', apiToken: 'typed' });
  });
});
