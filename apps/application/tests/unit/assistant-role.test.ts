/**
 * The `assistant` AI role and the assistant's limits: unset, the role answers
 * with the diagnosis role's provider, key and model; set, from Settings or the
 * `PIWI_AI_ASSISTANT_*` variables, it is its own. The limits are parsed and
 * clamped like the AI-step limits, and their registry entries match the code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { PIWI_ENV_VARS } from '#shared/piwi-env-vars';

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY ||= 'assistant-role-test-secret-key-0123456789';

let envAi: Record<string, string | undefined> = {};
vi.stubGlobal('useRuntimeConfig', () => ({ ai: envAi }));

const { assistantRole, resolveAiConfig } = await import('../../server/utils/ai-provider');
const { readAiSettings } = await import('../../server/utils/ai-settings');
const { setAppSetting, deleteAppSetting } = await import('../../server/utils/app-settings');
const { encryptSecret, getEncryptionKey } = await import('../../server/utils/crypto');
const limits = await import('../../server/utils/assistant/limits');
const { DEFAULT_ASSISTANT_RETENTION_DAYS } = await import('../../server/utils/retention');

let db: DbClient;

beforeAll(async () => {
  const sqlite = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(sqlite, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  db = sqlite as unknown as DbClient;
});

beforeEach(async () => {
  envAi = {};
  await deleteAppSetting(db, 'ai');
});

afterAll(() => vi.unstubAllGlobals());

const diagnosis = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  apiKey: encryptSecret('sk-ant-diagnosis', getEncryptionKey()),
};

describe('the assistant role from Settings', () => {
  test('unset, it answers with the diagnosis role', async () => {
    await setAppSetting(db, 'ai', { roles: { diagnosis } });
    const config = (await resolveAiConfig(db))!;
    expect(config.roles.assistant).toBeNull();
    expect(assistantRole(config)).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      apiKey: 'sk-ant-diagnosis',
    });
    expect((await readAiSettings(db)).roles.assistant).toBeNull();
  });

  test('reusing the diagnosis role, it keeps the key and takes its own model', async () => {
    await setAppSetting(db, 'ai', {
      roles: { diagnosis, assistant: { reuse: 'diagnosis', model: 'claude-haiku-4-5' } },
    });
    const config = (await resolveAiConfig(db))!;
    expect(assistantRole(config)).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-diagnosis',
    });
    expect(config.roles.diagnosis.model).toBe('claude-opus-4-8');
    expect((await readAiSettings(db)).roles.assistant).toMatchObject({ reuse: 'diagnosis', model: 'claude-haiku-4-5' });
  });

  test('with a provider of its own, it is its own', async () => {
    await setAppSetting(db, 'ai', {
      roles: { diagnosis, assistant: { provider: 'openai', model: 'qwen2.5', baseUrl: 'http://localhost:11434/v1' } },
    });
    expect(assistantRole((await resolveAiConfig(db))!)).toMatchObject({
      provider: 'openai',
      model: 'qwen2.5',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
    });
  });
});

describe('the assistant role from the environment', () => {
  const env = { provider: 'openai', apiKey: 'env-key', model: 'env-model', baseUrl: 'https://llm.internal/v1' };

  test('a model alone reuses the main provider, key and base URL', async () => {
    envAi = { ...env, assistantModel: 'env-chat', assistantTemperature: '0.2' };
    expect(assistantRole((await resolveAiConfig(db))!)).toEqual({
      provider: 'openai',
      apiKey: 'env-key',
      model: 'env-chat',
      baseUrl: 'https://llm.internal/v1',
      temperature: 0.2,
    });
  });

  test('a provider, key or base URL of its own makes a separate role', async () => {
    envAi = {
      ...env,
      assistantModel: 'claude-haiku-4-5',
      assistantProvider: 'anthropic',
      assistantApiKey: 'sk-ant-chat',
    };
    expect(assistantRole((await resolveAiConfig(db))!)).toMatchObject({
      provider: 'anthropic',
      apiKey: 'sk-ant-chat',
      model: 'claude-haiku-4-5',
    });
  });

  test('without its model, it answers with the diagnosis role', async () => {
    envAi = { ...env };
    const config = (await resolveAiConfig(db))!;
    expect(config.roles.assistant).toBeNull();
    expect(assistantRole(config).model).toBe('env-model');
  });
});

describe('resolveAssistantLimits', () => {
  test('defaults with nothing set', () => {
    expect(limits.resolveAssistantLimits({})).toEqual({
      maxToolCalls: limits.DEFAULT_ASSISTANT_MAX_TOOL_CALLS,
      maxOutputTokens: limits.DEFAULT_ASSISTANT_MAX_OUTPUT_TOKENS,
      turnTimeoutMs: limits.DEFAULT_ASSISTANT_TURN_TIMEOUT_SECONDS * 1000,
      dailyTokensPerUser: limits.DEFAULT_ASSISTANT_DAILY_TOKENS_PER_USER,
      dailyTokens: limits.DEFAULT_ASSISTANT_DAILY_TOKENS,
    });
  });

  test('reads and clamps each variable, ignoring what is not a number', () => {
    expect(
      limits.resolveAssistantLimits({
        PIWI_AI_ASSISTANT_MAX_TOOL_CALLS: '500',
        PIWI_AI_ASSISTANT_MAX_OUTPUT_TOKENS: '10',
        PIWI_AI_ASSISTANT_TURN_TIMEOUT_SECONDS: '60.9',
        PIWI_AI_ASSISTANT_DAILY_TOKENS_PER_USER: 'lots',
        PIWI_AI_ASSISTANT_DAILY_TOKENS: '-5',
      }),
    ).toEqual({
      maxToolCalls: 30,
      maxOutputTokens: 256,
      turnTimeoutMs: 60_000,
      dailyTokensPerUser: limits.DEFAULT_ASSISTANT_DAILY_TOKENS_PER_USER,
      dailyTokens: null,
    });
  });

  test('0 turns a daily cap off', () => {
    const off = limits.resolveAssistantLimits({
      PIWI_AI_ASSISTANT_DAILY_TOKENS_PER_USER: '0',
      PIWI_AI_ASSISTANT_DAILY_TOKENS: '0',
    });
    expect(off).toMatchObject({ dailyTokensPerUser: null, dailyTokens: null });
  });

  test('the registry records the defaults and ranges the code applies', () => {
    const recorded = {
      PIWI_AI_ASSISTANT_MAX_TOOL_CALLS: [limits.DEFAULT_ASSISTANT_MAX_TOOL_CALLS, 1, 30],
      PIWI_AI_ASSISTANT_MAX_OUTPUT_TOKENS: [limits.DEFAULT_ASSISTANT_MAX_OUTPUT_TOKENS, 256, 16_384],
      PIWI_AI_ASSISTANT_TURN_TIMEOUT_SECONDS: [limits.DEFAULT_ASSISTANT_TURN_TIMEOUT_SECONDS, 15, 900],
      PIWI_AI_ASSISTANT_DAILY_TOKENS_PER_USER: [limits.DEFAULT_ASSISTANT_DAILY_TOKENS_PER_USER, 0, 1_000_000_000],
      PIWI_AI_ASSISTANT_DAILY_TOKENS: [limits.DEFAULT_ASSISTANT_DAILY_TOKENS, 0, 1_000_000_000],
    } as const;
    for (const [name, [fallback, min, max]] of Object.entries(recorded)) {
      const meta = PIWI_ENV_VARS[name as keyof typeof recorded];
      expect(meta, name).toMatchObject({ default: String(fallback), min, max });
      // Each end of the range is what the code clamps to.
      const atMin = limits.resolveAssistantLimits({ [name]: String(min - 1) });
      const atMax = limits.resolveAssistantLimits({ [name]: String(max + 1) });
      expect(Object.values(atMin)).toContain(name.endsWith('SECONDS') ? min * 1000 : min > 0 ? min : null);
      expect(Object.values(atMax)).toContain(name.endsWith('SECONDS') ? max * 1000 : max);
    }
    expect(PIWI_ENV_VARS.PIWI_ASSISTANT_RETENTION_DAYS.default).toBe(String(DEFAULT_ASSISTANT_RETENTION_DAYS));
  });
});
