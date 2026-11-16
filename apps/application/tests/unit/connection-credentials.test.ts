import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { credentialReferences, insertCredential, namedForEveryProject } from '#shared/handlers/credentials';
import { openTempDb, type TempDb } from './temp-db';

/**
 * A Jira or Zephyr Scale connection's token as a credential: opening it for a
 * client is one counted read, each write a log row of its own (a search is a
 * read), a refused credential gives no client, a saved credential can be
 * picked, the environment's connection names a read-only credential, and the
 * tokens connections held in their own row are moved at startup.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = '0123456789abcdef'.repeat(4);

const { createConnection, createTracker, getConnectionRow, listConnections, testConnection, updateConnection } =
  await import('../../server/utils/integrations/connections');
const { connectionCredentialProblem, importConnectionCredentials } =
  await import('../../server/utils/integrations/connection-credentials');
const { encryptSecret, getEncryptionKey } = await import('../../server/utils/crypto');
const { sealCredentialSecret } = await import('../../server/utils/credentials');

const SITE = 'https://team.atlassian.net';

let db: TempDb;
let close: () => Promise<void>;
const sent: Array<{ method: string; path: string }> = [];

beforeAll(async () => {
  ({ db, close } = await openTempDb());
});
afterAll(async () => {
  delete process.env.PIWI_SECRET_KEY;
  await close();
});
beforeEach(async () => {
  sent.length = 0;
  await db.delete(schema.integrationConnections);
  await db.delete(schema.credentialUses);
  await db.delete(schema.credentials);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      sent.push({ method: init?.method ?? 'GET', path: url.pathname });
      if (url.pathname.endsWith('/transitions')) return new Response(null, { status: 204 });
      if (url.pathname.endsWith('/search/jql')) return Response.json({ issues: [] });
      return Response.json({ accountId: 'a1', displayName: 'Ada' });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of ['PIWI_JIRA_BASE_URL', 'PIWI_JIRA_EMAIL', 'PIWI_JIRA_API_TOKEN']) delete process.env[name];
});

const jira = (overrides: Partial<Parameters<typeof createConnection>[1]> = {}) =>
  createConnection(db as never, {
    provider: 'jira',
    name: 'Team Jira',
    baseUrl: SITE,
    credentials: { email: 'me@team.io', apiToken: 'jira-token' },
    ...overrides,
  });

const uses = () =>
  db
    .select({
      credentialId: schema.credentialUses.credentialId,
      feature: schema.credentialUses.feature,
      result: schema.credentialUses.result,
      count: schema.credentialUses.count,
      destination: schema.credentialUses.destination,
    })
    .from(schema.credentialUses)
    .orderBy(asc(schema.credentialUses.id));

/** A Jira credential saved under Settings → Credentials, as its form saves one. */
const savedJiraCredential = (fields: { name?: string; destination?: string; allProjects?: boolean } = {}) =>
  insertCredential(
    db as never,
    {
      name: fields.name ?? 'Jira · bot',
      description: null,
      service: 'jira',
      user: 'bot@team.io',
      destination: fields.destination ?? `${SITE}/`,
      scope: fields.allProjects === false ? { allProjects: false, projectIds: [] } : { allProjects: true },
      allowedInputs: null,
      customRequests: false,
      disabled: false,
    },
    sealCredentialSecret(fields.destination ?? `${SITE}/`, 'bot-token'),
    null,
  );

describe('a connection’s token', () => {
  test('is saved as a credential named after the connection, bound to its site and shared with all projects', async () => {
    const created = await jira();
    expect(created).toMatchObject({ hasCredentials: true, credentialName: 'Team Jira' });
    const [credential] = await db
      .select({
        service: schema.credentials.service,
        user: schema.credentials.userName,
        destination: schema.credentials.destination,
        allProjects: schema.credentials.allProjects,
      })
      .from(schema.credentials)
      .where(eq(schema.credentials.id, created.credentialId!));
    expect(credential).toEqual({ service: 'jira', user: 'me@team.io', destination: `${SITE}/`, allProjects: true });
  });

  test('is opened once per client as a counted read, and each write is a row of its own; a search only reads', async () => {
    const created = await jira();
    const tracker = (await createTracker(db as never, created.id))!;
    await tracker.search({ jql: 'labels = piwi' });
    await tracker.transition('PROJ-1', '31');
    await (await createTracker(db as never, created.id))!.whoAmI();
    expect(await uses()).toEqual([
      {
        credentialId: created.credentialId,
        feature: 'integration-read',
        result: 'ok',
        count: 2,
        destination: `${SITE}/`,
      },
      {
        credentialId: created.credentialId,
        feature: 'integration-write',
        result: 'ok',
        count: 1,
        destination: `${SITE}/`,
      },
    ]);
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /rest/api/3/search/jql',
      'POST /rest/api/3/issue/PROJ-1/transitions',
      'GET /rest/api/3/myself',
    ]);
  });

  test('gives no client once its credential is disabled, and the test of the connection says why', async () => {
    const created = await jira();
    await db.update(schema.credentials).set({ disabled: true }).where(eq(schema.credentials.id, created.credentialId!));
    expect(await createTracker(db as never, created.id)).toBeNull();
    expect(await testConnection(db as never, created.id)).toEqual({
      ok: false,
      error: 'The credential "Team Jira" is disabled.',
    });
    expect(sent).toEqual([]);
    expect((await uses()).map((u) => u.result)).toEqual(['refused']);
  });

  test('rotates the credential the connection names when a new one is typed', async () => {
    const created = await jira();
    await updateConnection(db as never, created.id, { credentials: { apiToken: 'rotated' } });
    const row = (await getConnectionRow(db as never, created.id))!;
    expect(row.credentialId).toBe(created.credentialId);
    expect(await db.select({ id: schema.credentials.id }).from(schema.credentials)).toHaveLength(1);
  });
});

describe('a saved credential picked for a connection', () => {
  test('is named by the connection, which signs in with it', async () => {
    const id = await savedJiraCredential();
    const created = await jira({ credentials: null, credentialId: id });
    expect(created).toMatchObject({
      credentialId: id,
      credentialName: 'Jira · bot',
      credentialValues: { email: 'bot@team.io' },
    });
    expect(await (await createTracker(db as never, created.id))!.whoAmI()).toEqual({ id: 'a1', displayName: 'Ada' });
  });

  test('must be sent to the connection’s site, shared with all projects, and saved in the database', async () => {
    const elsewhere = await savedJiraCredential({ destination: 'https://other.atlassian.net/' });
    expect(await connectionCredentialProblem(db as never, 'jira', elsewhere, `${SITE}/`)).toContain(
      'is sent only under https://other.atlassian.net/',
    );
    const narrow = await savedJiraCredential({ name: 'Jira · narrow', allProjects: false });
    expect(await connectionCredentialProblem(db as never, 'jira', narrow, `${SITE}/`)).toContain(
      'is not shared with all projects',
    );
    expect(await connectionCredentialProblem(db as never, 'zephyr-scale', narrow, `${SITE}/`)).toContain(
      'No zephyr-scale credential',
    );
  });

  test('keeps the credential shared with all projects while a connection names it', async () => {
    const created = await jira();
    expect((await credentialReferences(db as never)).get(created.credentialId!)).toEqual([
      { kind: 'connection', projectId: null, projectName: null, actionId: null, name: 'Team Jira' },
    ]);
    expect(await namedForEveryProject(db as never, created.credentialId!)).toBe(true);
  });
});

describe('the environment’s connection', () => {
  test('names a read-only credential that reads the token from the environment, removed with it', async () => {
    process.env.PIWI_JIRA_BASE_URL = 'https://env.atlassian.net';
    process.env.PIWI_JIRA_EMAIL = 'env@team.io';
    process.env.PIWI_JIRA_API_TOKEN = 'env-token';
    const [connection] = await listConnections(db as never);
    expect(connection).toMatchObject({ managedBy: 'env', credentialName: 'Jira (environment)' });
    const [credential] = await db
      .select({
        managedBy: schema.credentials.managedBy,
        secret: schema.credentials.secret,
        secretEnv: schema.credentials.secretEnv,
        user: schema.credentials.userName,
      })
      .from(schema.credentials);
    expect(credential).toEqual({
      managedBy: 'env',
      secret: null,
      secretEnv: 'PIWI_JIRA_API_TOKEN',
      user: 'env@team.io',
    });
    await (await createTracker(db as never, connection!.id))!.whoAmI();
    expect(sent).toHaveLength(1);

    delete process.env.PIWI_JIRA_BASE_URL;
    expect(await listConnections(db as never)).toEqual([]);
    expect(await db.select({ id: schema.credentials.id }).from(schema.credentials)).toEqual([]);
  });
});

describe('importConnectionCredentials', () => {
  const legacy = async (provider: 'jira' | 'zephyr-scale', values: Record<string, string>) => {
    const [row] = await db
      .insert(schema.integrationConnections)
      .values({
        provider,
        name: provider === 'jira' ? 'Old Jira' : 'Old Zephyr',
        baseUrl: provider === 'jira' ? SITE : 'https://api.zephyrscale.smartbear.com/v2',
        config: provider === 'jira' ? { flavor: 'cloud' } : { region: 'us' },
        credentials: encryptSecret(JSON.stringify(values), getEncryptionKey()),
        status: 'ok',
        managedBy: 'db',
      })
      .returning();
    return row!;
  };

  test('moves each connection’s token to a credential of its own, once', async () => {
    const jiraRow = await legacy('jira', { email: 'me@team.io', apiToken: 'old-token' });
    const zephyrRow = await legacy('zephyr-scale', { apiToken: 'old-zephyr' });
    expect(await importConnectionCredentials(db as never)).toBe(2);
    expect(await importConnectionCredentials(db as never)).toBe(0);

    const moved = (await getConnectionRow(db as never, jiraRow.id))!;
    expect(moved.credentials).toBeNull();
    const credentials = await db
      .select({
        id: schema.credentials.id,
        name: schema.credentials.name,
        service: schema.credentials.service,
        user: schema.credentials.userName,
        destination: schema.credentials.destination,
      })
      .from(schema.credentials)
      .orderBy(asc(schema.credentials.id));
    expect(credentials).toEqual([
      { id: moved.credentialId, name: 'Old Jira', service: 'jira', user: 'me@team.io', destination: `${SITE}/` },
      {
        id: (await getConnectionRow(db as never, zephyrRow.id))!.credentialId,
        name: 'Old Zephyr',
        service: 'zephyr-scale',
        user: null,
        destination: 'https://api.zephyrscale.smartbear.com/v2/',
      },
    ]);
    expect(await (await createTracker(db as never, jiraRow.id))!.whoAmI()).toEqual({ id: 'a1', displayName: 'Ada' });
  });

  test('leaves a token it cannot open where it is', async () => {
    const [row] = await db
      .insert(schema.integrationConnections)
      .values({
        provider: 'jira',
        name: 'Broken',
        baseUrl: SITE,
        credentials: 'v1:not-a-sealed-value',
        status: 'ok',
        managedBy: 'db',
      })
      .returning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await importConnectionCredentials(db as never)).toBe(0);
    expect((await getConnectionRow(db as never, row!.id))!.credentials).toBe('v1:not-a-sealed-value');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
