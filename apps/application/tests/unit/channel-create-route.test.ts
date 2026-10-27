import { describe, test, expect, vi, beforeEach } from 'vitest';
import { apiError } from '../../server/utils/api-error';

/**
 * Creating a Slack channel stores only its delivery's fields: a bot token
 * encrypted with `PIWI_SECRET_KEY` (refused with 409 without it), or the
 * webhook URL alone, so no token is ever kept in clear.
 */

const stored = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[] }));

vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 3 }),
  getRequestAccess: async () => ({}),
  isAuthEnabled: () => false,
}));
vi.mock('../../server/database', () => ({
  getDatabase: async () => ({
    insert: () => ({
      values: (row: { config: Record<string, unknown> }) => {
        stored.configs.push(row.config);
        return { returning: async () => [{ id: 1, ...row }] };
      },
    }),
  }),
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: { body: unknown }) => event.body);
vi.stubGlobal('apiError', apiError);

const route = (await import('../../server/api/channels/index.post')).default as unknown as (
  event: unknown,
) => Promise<{ channel: { config: Record<string, unknown> } }>;
const { decryptSecret } = await import('../../server/utils/crypto');

const create = (config: Record<string, unknown>) =>
  route({ body: { name: 'Slack', type: 'slack', config }, context: {} });

describe('POST /api/channels for Slack', () => {
  beforeEach(() => {
    stored.configs.length = 0;
    vi.stubEnv('PIWI_SECRET_KEY', 'create-route-key');
  });

  test('stores the bot token encrypted and returns only the channel ID', async () => {
    const res = await create({ token: ' xoxb-1-2-secret ', channelId: 'C0123456789', webhookUrl: 'https://x' });
    expect(res.channel.config).toEqual({ channelId: 'C0123456789' });
    const config = stored.configs[0]!;
    expect(Object.keys(config).sort()).toEqual(['channelId', 'token']);
    expect(config.token).not.toContain('xoxb');
    expect(decryptSecret(config.token as string, 'create-route-key')).toBe('xoxb-1-2-secret');
  });

  test('refuses a bot token while PIWI_SECRET_KEY is unset', async () => {
    vi.stubEnv('PIWI_SECRET_KEY', '');
    await expect(create({ token: 'xoxb-1-2', channelId: 'C0123456789' })).rejects.toMatchObject({ statusCode: 409 });
    expect(stored.configs).toHaveLength(0);
  });

  test('a webhook channel keeps its URL alone', async () => {
    await create({ webhookUrl: 'https://hooks.slack.com/services/T/B/1', extra: 'x' });
    expect(stored.configs[0]).toEqual({ webhookUrl: 'https://hooks.slack.com/services/T/B/1' });
  });

  test('a token beside a webhook URL is a Web API channel missing its channel ID', async () => {
    await expect(
      create({ webhookUrl: 'https://hooks.slack.com/services/T/B/1', token: 'xoxb-1-2' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(stored.configs).toHaveLength(0);
  });
});
