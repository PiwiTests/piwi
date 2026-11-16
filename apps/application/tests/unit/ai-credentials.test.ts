import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { User } from '../../server/database/schema';
import { apiError } from '../../server/utils/api-error';
import { ADMIN_ACCESS, InstanceRole } from '#shared/permissions';
import { aiEndpoint, ANTHROPIC_ENDPOINT } from '#shared/credentials';
import { credentialReferences, insertCredential } from '#shared/handlers/credentials';
import { openTempDb, type TempDb } from './temp-db';
import { recordRouteMeta, underRoutePermission, type RouteAccessState } from './route-access';

/**
 * The AI keys as credentials: the endpoint a key is bound to, a key typed in
 * Settings → AI saved in the role's credential, the key opened only for a call
 * to the model (one counted use per credential), a refused credential failing
 * the call, the environment's keys as read-only credentials, and the import of
 * the keys saved before credentials existed.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));

let envAi: Record<string, string | undefined> | undefined;
vi.stubGlobal('useRuntimeConfig', () => ({ ai: envAi }));
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: { body?: unknown }) => event.body);
vi.stubGlobal('apiError', apiError);

const { importAiKeys, saveAiRoleKey } = await import('../../server/utils/ai-credentials');
const { callAiProvider, resolveAiConfig } = await import('../../server/utils/ai-provider');
const { readAiSettings } = await import('../../server/utils/ai-settings');
const { getAppSetting, setAppSetting } = await import('../../server/utils/app-settings');
const { encryptSecret } = await import('../../server/utils/crypto');
const { CredentialRefusedError, sealCredentialSecret } = await import('../../server/utils/credentials');

type Handler = (event: { body?: unknown; context?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
const saveAiSettings = underRoutePermission(
  state,
  (await import('../../server/api/settings/ai.put')).default as unknown as Handler,
);

const SECRET_KEY = '0123456789abcdef'.repeat(4);
const OPENAI = 'https://llm.example.com/v1/';
const ADMIN = {
  user: { id: 1, username: 'avery', name: null, role: InstanceRole.ADMINISTRATOR } as unknown as User,
  access: ADMIN_ACCESS,
};

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.PIWI_SECRET_KEY = SECRET_KEY;
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.users).values({ id: 1, username: 'avery', password: '', role: InstanceRole.ADMINISTRATOR });
});

afterAll(async () => {
  delete process.env.PIWI_SECRET_KEY;
  await close();
});

beforeEach(async () => {
  envAi = undefined;
  state.caller = ADMIN;
  await db.delete(schema.credentialUses);
  await db.delete(schema.credentials);
  await db.delete(schema.appSettings);
});

afterEach(() => {
  for (const name of ['PIWI_AI_API_KEY', 'PIWI_AI_RESEARCH_API_KEY']) delete process.env[name];
  vi.unstubAllGlobals();
  vi.stubGlobal('useRuntimeConfig', () => ({ ai: envAi }));
  vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
  vi.stubGlobal('eventHandler', (handler: unknown) => handler);
  vi.stubGlobal('readBody', async (event: { body?: unknown }) => event.body);
  vi.stubGlobal('apiError', apiError);
});

const credentialRows = () => db.select().from(schema.credentials).orderBy(asc(schema.credentials.id));
const uses = () => db.select().from(schema.credentialUses).orderBy(asc(schema.credentialUses.id));

/** An OpenAI-compatible diagnosis role, its key saved in a credential. */
async function savedRole(key = 'sk-team', endpoint = OPENAI): Promise<number> {
  const id = await saveAiRoleKey(db as never, { role: 'diagnosis', endpoint, key, credentialId: null, createdBy: 1 });
  await setAppSetting(db as never, 'ai', {
    roles: { diagnosis: { provider: 'openai', baseUrl: endpoint, model: 'm', credentialId: id } },
  });
  return id;
}

describe('the endpoint an AI key is bound to', () => {
  test('a role’s base URL, else Anthropic’s API; none for a local CLI', () => {
    expect(aiEndpoint('anthropic', null)).toBe(ANTHROPIC_ENDPOINT);
    expect(aiEndpoint('anthropic', 'https://gateway.example.com/anthropic')).toBe(
      'https://gateway.example.com/anthropic/',
    );
    expect(aiEndpoint('openai', 'https://llm.example.com/v1')).toBe(OPENAI);
    expect(aiEndpoint('openai', null)).toBeNull();
    expect(aiEndpoint('claude-cli', null)).toBeNull();
  });
});

describe('a role’s key in a credential', () => {
  test('is opened only for a call to the model, as one counted use per credential', async () => {
    const id = await savedRole();
    await setAppSetting(db as never, 'ai', {
      roles: {
        diagnosis: { provider: 'openai', baseUrl: OPENAI, model: 'm', credentialId: id },
        research: { reuse: 'diagnosis', model: 'r' },
      },
    });
    const status = await resolveAiConfig(db as never);
    expect(status?.roles.diagnosis).toMatchObject({ credentialId: id, apiKey: '' });
    expect(await uses()).toEqual([]);

    const config = await resolveAiConfig(db as never, { open: true, actor: { userId: 1, apiKeyId: null } });
    expect(config?.roles.diagnosis.apiKey).toBe('sk-team');
    expect(config?.roles.research?.apiKey).toBe('sk-team');
    expect(await uses()).toMatchObject([
      { credentialId: id, feature: 'ai-call', projectId: null, userId: 1, result: 'ok', count: 1 },
    ]);
  });

  test('a disabled credential fails the call with its reason, and the refusal is logged', async () => {
    const id = await savedRole();
    await db.update(schema.credentials).set({ disabled: true }).where(eq(schema.credentials.id, id));
    const config = (await resolveAiConfig(db as never, { open: true }))!;
    expect(config.roles.diagnosis.apiKey).toBe('');
    await expect(callAiProvider(config.roles.diagnosis, { system: 's', user: 'u' })).rejects.toBeInstanceOf(
      CredentialRefusedError,
    );
    expect(await uses()).toMatchObject([{ feature: 'ai-call', result: 'refused' }]);
  });

  test('a credential sent elsewhere never goes to the role’s endpoint', async () => {
    const id = await savedRole('sk-team', 'https://other.example.com/v1/');
    await setAppSetting(db as never, 'ai', {
      roles: { diagnosis: { provider: 'openai', baseUrl: OPENAI, model: 'm', credentialId: id } },
    });
    const config = (await resolveAiConfig(db as never, { open: true }))!;
    expect(config.roles.diagnosis).toMatchObject({ apiKey: '', refusal: expect.stringMatching(/sent only under/) });
  });

  test('is listed as what names the credential, which then stays shared with all projects', async () => {
    const id = await savedRole();
    expect((await credentialReferences(db as never)).get(id)).toEqual([
      { kind: 'ai-role', projectId: null, projectName: null, actionId: null, name: 'AI · Diagnosis' },
    ]);
    const patch = underRoutePermission(
      state,
      (await import('../../server/api/credentials/[id].patch')).default as unknown as (event: {
        params: Record<string, string>;
        body: unknown;
      }) => Promise<unknown>,
    );
    vi.stubGlobal('getRouterParam', (event: { params: Record<string, string> }, name: string) => event.params[name]);
    await expect(
      patch({ params: { id: String(id) }, body: { scope: { allProjects: false, projectIds: [1] } } }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('Settings → AI', () => {
  const role = (over: Record<string, unknown> = {}) => ({
    roles: { diagnosis: { provider: 'openai', baseUrl: 'https://llm.example.com/v1', model: 'm', ...over } },
  });

  test('a typed key makes the role’s credential, then rotates it; the settings show it, never the key', async () => {
    await saveAiSettings({ body: role({ apiKey: 'sk-first' }) });
    const [made] = await credentialRows();
    expect(made).toMatchObject({ service: 'ai', destination: OPENAI, allProjects: true, createdBy: 1 });
    const settings = await readAiSettings(db as never);
    expect(settings.roles.diagnosis).toMatchObject({ hasApiKey: true, credentialId: made!.id });
    expect(JSON.stringify(settings)).not.toContain('sk-first');

    await saveAiSettings({ body: role({ apiKey: 'sk-second' }) });
    expect(await credentialRows()).toHaveLength(1);
    const config = (await resolveAiConfig(db as never, { open: true }))!;
    expect(config.roles.diagnosis.apiKey).toBe('sk-second');
  });

  test('another endpoint needs the key again, or a credential sent there', async () => {
    await saveAiSettings({ body: role({ apiKey: 'sk-first' }) });
    await expect(saveAiSettings({ body: role({ baseUrl: 'https://other.example.com/v1' }) })).rejects.toMatchObject({
      statusCode: 400,
    });
    const other = await insertCredential(
      db as never,
      {
        name: 'Other gateway',
        description: null,
        service: 'ai',
        user: null,
        destination: 'https://other.example.com/',
        scope: { allProjects: true },
        allowedInputs: null,
        customRequests: false,
        disabled: false,
      },
      sealCredentialSecret('https://other.example.com/', 'sk-other'),
      1,
    );
    await saveAiSettings({ body: role({ baseUrl: 'https://other.example.com/v1', credentialId: other }) });
    const stored = await getAppSetting<{ roles: { diagnosis: { credentialId: number } } }>(db as never, 'ai');
    expect(stored?.roles.diagnosis.credentialId).toBe(other);
  });

  test('a picked credential must be shared with all projects', async () => {
    const narrow = await insertCredential(
      db as never,
      {
        name: 'One project',
        description: null,
        service: 'ai',
        user: null,
        destination: OPENAI,
        scope: { allProjects: false, projectIds: [] },
        allowedInputs: null,
        customRequests: false,
        disabled: false,
      },
      sealCredentialSecret(OPENAI, 'sk'),
      1,
    );
    await expect(saveAiSettings({ body: role({ credentialId: narrow }) })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('the environment’s AI keys', () => {
  test('are read-only credentials, one per variable and endpoint, read at each use', async () => {
    envAi = { provider: 'openai', apiKey: 'env-key', model: 'm', baseUrl: 'https://llm.example.com/v1' };
    process.env.PIWI_AI_API_KEY = 'env-key';
    const config = (await resolveAiConfig(db as never, { open: true }))!;
    expect(config.roles.diagnosis.apiKey).toBe('env-key');
    expect(await credentialRows()).toMatchObject([
      { service: 'ai', managedBy: 'env', secret: null, secretEnv: 'PIWI_AI_API_KEY', destination: OPENAI },
    ]);
    // Unset since: the role has no key, as the environment sets none, and the row goes.
    delete process.env.PIWI_AI_API_KEY;
    const unset = (await resolveAiConfig(db as never, { open: true }))!;
    expect(unset.roles.diagnosis).toMatchObject({ apiKey: '' });
    expect(unset.roles.diagnosis.credentialId).toBeUndefined();
    expect(await credentialRows()).toEqual([]);
  });
});

describe('importAiKeys', () => {
  test('moves each stored key to a credential bound to its endpoint, equal keys sharing one', async () => {
    await setAppSetting(db as never, 'ai', {
      autoDiagnose: true,
      roles: {
        diagnosis: { provider: 'anthropic', model: 'm', apiKey: encryptSecret('sk-ant', SECRET_KEY) },
        research: { provider: 'anthropic', model: 'r', apiKey: encryptSecret('sk-ant', SECRET_KEY) },
        embedding: { provider: 'openai', baseUrl: OPENAI, model: 'e', apiKey: encryptSecret('sk-emb', SECRET_KEY) },
      },
    });
    expect(await importAiKeys(db as never)).toBe(3);
    const rows = await credentialRows();
    expect(rows.map((r) => [r.destination, r.allProjects, r.createdBy])).toEqual([
      [ANTHROPIC_ENDPOINT, true, null],
      [OPENAI, true, null],
    ]);
    const stored = await getAppSetting<{ autoDiagnose: boolean; roles: Record<string, Record<string, unknown>> }>(
      db as never,
      'ai',
    );
    expect(stored?.autoDiagnose).toBe(true);
    expect(stored?.roles.diagnosis).toMatchObject({ credentialId: rows[0]!.id });
    expect(stored?.roles.research).toMatchObject({ credentialId: rows[0]!.id });
    expect(JSON.stringify(stored)).not.toContain('apiKey');
    const config = (await resolveAiConfig(db as never, { open: true }))!;
    expect(config.roles.embedding?.apiKey).toBe('sk-emb');
    expect(await importAiKeys(db as never)).toBe(0);
  });

  test('moves the keys of the flat shape of earlier versions, into roles', async () => {
    await setAppSetting(db as never, 'ai', {
      provider: 'openai',
      baseUrl: OPENAI,
      model: 'm',
      apiKey: encryptSecret('sk-flat', SECRET_KEY),
    });
    expect(await importAiKeys(db as never)).toBe(1);
    const config = (await resolveAiConfig(db as never, { open: true }))!;
    expect(config.roles.diagnosis).toMatchObject({ apiKey: 'sk-flat', model: 'm' });
  });
});
