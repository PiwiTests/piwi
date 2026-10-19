import { describe, test, expect, vi } from 'vitest';
import { apiError } from '../../server/utils/api-error';

/** The unsaved-channel test: a caller sends at most ten tests a minute. */

const sent = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../server/utils/auth', () => ({ requireAuth: async () => ({ id: 3 }) }));
vi.mock('../../server/utils/notifications/channel-test', () => ({
  deliverChannelTest: async () => {
    sent.count += 1;
  },
  rememberTestedDestination: () => {},
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: { body: unknown }) => event.body);
vi.stubGlobal('apiError', apiError);

const route = (await import('../../server/api/channels/test.post')).default as unknown as (
  event: unknown,
) => Promise<{ success: boolean }>;

const event = () => ({
  body: { type: 'webhook', config: { url: 'https://ci.example.com/piwi' } },
  context: {},
  node: { req: { headers: {}, socket: { remoteAddress: '10.1.1.1' } }, res: { setHeader: () => {} } },
});

describe('POST /api/channels/test', () => {
  test('refuses the eleventh test within a minute', async () => {
    for (let i = 0; i < 10; i++) expect(await route(event())).toEqual({ success: true });
    await expect(route(event())).rejects.toMatchObject({ statusCode: 429 });
    expect(sent.count).toBe(10);
  });
});
