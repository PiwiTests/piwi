import { describe, test, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';

/**
 * With AI configured through env vars, the per-role settings saved in
 * Settings → AI are the ones every AI call uses: a stored model or temperature
 * replaces the env one, a role the environment leaves out can be added by
 * reusing one it sets, and a stored provider, key or base URL never replaces
 * the environment's.
 */

delete process.env.PIWI_DATABASE_URL;

let envAi: Record<string, string | undefined> = {};
vi.stubGlobal('useRuntimeConfig', () => ({ ai: envAi }));

const { resolveAiConfig } = await import('../../server/utils/ai-provider');
const { readAiSettings } = await import('../../server/utils/ai-settings');
const { setAppSetting, deleteAppSetting } = await import('../../server/utils/app-settings');
const { encryptSecret } = await import('../../server/utils/crypto');

let db: DbClient;

beforeAll(async () => {
  const sqlite = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(sqlite, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  db = sqlite as unknown as DbClient;
});

beforeEach(async () => {
  envAi = {
    provider: 'openai',
    apiKey: 'env-key',
    model: 'env-model',
    baseUrl: 'https://llm.internal/v1',
    researchModel: 'env-research-model',
  };
  await deleteAppSetting(db, 'ai');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('resolveAiConfig under env-managed AI', () => {
  test('uses the env roles as they are when nothing is stored', async () => {
    const config = await resolveAiConfig(db);
    expect(config).toMatchObject({ source: 'env', model: 'env-model', apiKey: 'env-key' });
    expect(config?.roles.research?.model).toBe('env-research-model');
  });

  test('uses a stored model and temperature override, keeping the env key and base URL', async () => {
    await setAppSetting(db, 'ai', {
      roles: { diagnosis: { model: 'picked-model' }, research: { model: 'picked-research', temperature: 0.2 } },
    });

    const config = await resolveAiConfig(db);
    expect(config?.roles.diagnosis).toEqual({
      provider: 'openai',
      apiKey: 'env-key',
      model: 'picked-model',
      baseUrl: 'https://llm.internal/v1',
      temperature: null,
    });
    expect(config?.model).toBe('picked-model');
    expect(config?.roles.research).toMatchObject({ model: 'picked-research', temperature: 0.2, apiKey: 'env-key' });
  });

  test('adds a role the environment leaves out when it reuses one it sets', async () => {
    await setAppSetting(db, 'ai', { roles: { embedding: { reuse: 'diagnosis', model: 'embed-model' } } });

    const config = await resolveAiConfig(db);
    expect(config?.roles.embedding).toEqual({
      provider: 'openai',
      apiKey: 'env-key',
      model: 'embed-model',
      baseUrl: 'https://llm.internal/v1',
      temperature: null,
    });
  });

  test('never takes a stored provider, key or base URL over the environment', async () => {
    await setAppSetting(db, 'ai', {
      roles: {
        diagnosis: { provider: 'anthropic', apiKey: 'stored', baseUrl: 'https://elsewhere.example', model: 'm' },
        embedding: { provider: 'openai', apiKey: 'stored', baseUrl: 'https://elsewhere.example', model: 'e' },
      },
    });

    const config = await resolveAiConfig(db);
    expect(config?.roles.diagnosis).toMatchObject({
      provider: 'openai',
      apiKey: 'env-key',
      baseUrl: 'https://llm.internal/v1',
      model: 'm',
    });
    expect(config?.roles.embedding).toBeNull();
  });

  test('Settings shows the models that run', async () => {
    await setAppSetting(db, 'ai', {
      roles: { diagnosis: { model: 'picked-model' }, embedding: { reuse: 'diagnosis', model: 'embed-model' } },
    });

    const [config, settings] = await Promise.all([resolveAiConfig(db), readAiSettings(db)]);
    expect(settings.envManaged).toBe(true);
    expect(settings.roles.diagnosis?.model).toBe(config?.roles.diagnosis.model);
    expect(settings.roles.research?.model).toBe(config?.roles.research?.model);
    expect(settings.roles.embedding).toMatchObject({ reuse: 'diagnosis', model: 'embed-model' });
    expect(config?.roles.embedding?.model).toBe('embed-model');
  });
});

describe('the research and embedding roles of the environment', () => {
  test('take the main provider, base URL and key for each one they do not set', async () => {
    envAi = { ...envAi, researchApiKey: 'research-key', embeddingModel: 'embed-model' };

    const [config, settings] = await Promise.all([resolveAiConfig(db), readAiSettings(db)]);
    expect(config?.roles.research).toEqual({
      provider: 'openai',
      apiKey: 'research-key',
      model: 'env-research-model',
      baseUrl: 'https://llm.internal/v1',
      temperature: null,
    });
    expect(settings.roles.research).toMatchObject({ provider: 'openai', baseUrl: 'https://llm.internal/v1' });
    expect(config?.roles.embedding).toMatchObject({ provider: 'openai', apiKey: 'env-key', model: 'embed-model' });
  });

  test('a research provider of its own keeps the main base URL when it sets none', async () => {
    envAi = { ...envAi, researchProvider: 'openai' };

    const config = await resolveAiConfig(db);
    expect(config?.roles.research).toMatchObject({ provider: 'openai', baseUrl: 'https://llm.internal/v1' });
  });
});

describe('resolveAiConfig from settings saved in the flat shape of earlier versions', () => {
  const secret = 'test-encryption-secret-for-ai-roles';

  beforeEach(() => {
    envAi = {};
    vi.stubEnv('PIWI_SECRET_KEY', secret);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test('reads the diagnosis and research roles, research taking the main base URL and key', async () => {
    await setAppSetting(db, 'ai', {
      provider: 'openai',
      apiKey: encryptSecret('stored-key', secret),
      model: 'stored-model',
      baseUrl: 'https://llm.internal/v1',
      researchModel: 'stored-research-model',
      researchProvider: 'openai',
    });

    const [config, settings] = await Promise.all([resolveAiConfig(db), readAiSettings(db)]);
    expect(config).toMatchObject({ source: 'settings', model: 'stored-model', apiKey: 'stored-key' });
    expect(config?.roles.research).toEqual({
      provider: 'openai',
      apiKey: 'stored-key',
      model: 'stored-research-model',
      baseUrl: 'https://llm.internal/v1',
      temperature: null,
    });
    expect(settings.roles.research).toMatchObject({
      model: 'stored-research-model',
      baseUrl: 'https://llm.internal/v1',
    });
  });
});
