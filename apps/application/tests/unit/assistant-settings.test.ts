/**
 * `explain_setting`: a field of the Settings pages with its help, its docs
 * page, the variables that override it and its guide anchor; which variables
 * the environment sets and the field's current value only for a user who may
 * open its page, a secret never, only whether it is set, and a variable's
 * value never.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { ADMIN_ACCESS, InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { SETTINGS_PAGES } from '#shared/settings-metadata';
import { findGuideAnchor } from '#shared/guide-anchors/index.mjs';

delete process.env.PIWI_DATABASE_URL;
vi.stubGlobal('useRuntimeConfig', () => ({ ai: {}, authEnabled: false, public: { appVersion: '0.59.0' } }));

const { explainSetting } = await import('../../server/utils/assistant/settings');
const { setAppSetting } = await import('../../server/utils/app-settings');
type McpContext = import('../../server/utils/mcp/tools').McpContext;

const administrator: McpContext = { user: null, access: ADMIN_ACCESS, scope: 'all' };
const member: McpContext = {
  user: { id: 2, role: 'member', username: 'robin', name: 'Robin', email: 'robin@example.com' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: null, role: ProjectRole.MAINTAINER }]),
  scope: 'all',
};

const ENV = ['PIWI_CI_MINUTE_COST', 'PIWI_AI_ASSISTANT_API_KEY', 'PIWI_AI_ASSISTANT_MODEL'] as const;

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
});
afterEach(async () => {
  for (const name of ENV) delete process.env[name];
  await close();
});
afterAll(() => vi.unstubAllGlobals());

const explain = async (ctx: McpContext, fieldId: string) =>
  (await explainSetting(db as never, ctx, fieldId)) as Record<string, any>;

describe('explain_setting', () => {
  test("a field's label, page, help, docs, variables and anchor", async () => {
    const field = await explain(administrator, 'ai.assistant');
    expect(field).toMatchObject({
      id: 'ai.assistant',
      label: 'Assistant model',
      page: { label: 'AI diagnosis', route: '/settings/ai' },
      title: 'Assistant model',
      help: expect.stringContaining('Unset, it uses the diagnosis model'),
      docs: 'https://piwitests.dev/features/assistant#the-model',
      environment: { managed: false, set: [] },
      set: false,
      anchor: 'ai-assistant-model',
    });
    expect(field.variables.map((v: { name: string }) => v.name)).toContain('PIWI_AI_ASSISTANT_MODEL');
    expect(field.variables[0].description.length).toBeGreaterThan(0);
    expect(findGuideAnchor(field.anchor)?.kind).toBe('field');
  });

  test('says which variables the environment sets, and that it then manages the field', async () => {
    process.env.PIWI_CI_MINUTE_COST = '0.013 EUR';
    const field = await explain(administrator, 'ci-cost');
    expect(field).toMatchObject({
      environment: { managed: true, set: ['PIWI_CI_MINUTE_COST'] },
      value: { amount: 0.013, currency: 'EUR' },
      anchor: 'ci-minute-cost',
    });
    expect(JSON.stringify(field)).not.toContain('0.013 EUR');
  });

  test("keeps the environment and the value to those who may open the field's page", async () => {
    process.env.PIWI_CI_MINUTE_COST = '0.013 EUR';
    const field = await explain(member, 'ci-cost');
    expect(field.environment).toBe('shown to those who can open Performance (it needs settings:manage)');
    expect(field.valueNote).toBe(field.environment);
    expect(field).not.toHaveProperty('value');
    expect(field.help).toBeTruthy();
    // A page with no permission: the value its endpoint returns to anyone.
    expect(await explain(member, 'localization.time-zone')).toMatchObject({ value: expect.any(String) });
    expect(await explain(member, 'account.display-name')).toMatchObject({ value: 'Robin' });
  });

  test('never returns a secret: a stored token or a key in the environment only reads as set', async () => {
    await setAppSetting(db as never, 'scm_token', { value: 'ghp_secret_token_123' });
    process.env.PIWI_AI_ASSISTANT_API_KEY = 'sk-secret-key-456';
    process.env.PIWI_AI_ASSISTANT_MODEL = 'claude-haiku';
    const token = await explain(administrator, 'ai.scm-token');
    expect(token).toMatchObject({ set: true });
    expect(token).not.toHaveProperty('value');
    expect(JSON.stringify(token)).not.toContain('ghp_secret_token_123');
    const assistant = await explain(administrator, 'ai.assistant');
    expect(assistant.environment).toEqual({
      managed: true,
      set: ['PIWI_AI_ASSISTANT_MODEL', 'PIWI_AI_ASSISTANT_API_KEY'],
    });
    expect(JSON.stringify(assistant)).not.toContain('sk-secret-key-456');
    expect(JSON.stringify(assistant)).not.toContain('claude-haiku');

    await setAppSetting(db as never, 'ai', {
      roles: { diagnosis: { provider: 'openai', model: 'gpt-test', apiKey: 'sk-stored-key-789' } },
    });
    const diagnosis = await explain(administrator, 'ai.diagnosis');
    expect(diagnosis.value).toEqual({ provider: 'openai', model: 'gpt-test' });
    expect(JSON.stringify(diagnosis)).not.toContain('sk-stored-key-789');
  });

  test('a field this tool does not read says where it shows; an unknown id lists the fields', async () => {
    expect(await explain(administrator, 'storage.cleanup')).toMatchObject({
      valueNote: 'not read by this tool; Storage shows it',
    });
    const unknown = await explain(administrator, 'ai.nope');
    expect(unknown.note).toContain('No settings field has the id "ai.nope"');
    expect(unknown.fields).toEqual(SETTINGS_PAGES.flatMap((p) => p.fields.map((f) => f.id)));
  });
});
