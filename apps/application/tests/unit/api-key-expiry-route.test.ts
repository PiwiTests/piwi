import { describe, test, expect, vi } from 'vitest';
import { apiError } from '../../server/utils/api-error';
import { ADMIN_ACCESS } from '#shared/permissions';

/** Creating an API key refuses an expiry in the past, and keeps a future one. */

const stored = vi.hoisted(() => ({ keys: [] as Array<{ expiresAt: Date | null }> }));

vi.mock('../../server/database', () => ({ getDatabase: async () => ({}) }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 1 }),
  getRequestAccess: async () => ADMIN_ACCESS,
  generateApiKey: () => ({ plaintext: 'pd_x', hash: 'h', prefix: 'pd_x' }),
}));
vi.mock('#shared/handlers/users', () => ({
  createUserApiKeyRecord: async (_db: unknown, _userId: number, data: { expiresAt: Date | null }) => {
    stored.keys.push(data);
  },
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: { body: unknown }) => event.body);
vi.stubGlobal('getRouterParam', (event: { params: Record<string, string> }, name: string) => event.params[name]);
vi.stubGlobal('apiError', apiError);

const create = (await import('../../server/api/users/[id]/api-keys/index.post')).default as unknown as (
  event: unknown,
) => Promise<unknown>;

const request = (expiresAt?: string) => ({ params: { id: '1' }, body: { name: 'CI', expiresAt } });

describe('POST /api/users/:id/api-keys', () => {
  test('refuses an expiry in the past', async () => {
    await expect(create(request(new Date(Date.now() - 60_000).toISOString()))).rejects.toMatchObject({
      statusCode: 400,
      message: 'The expiry date is in the past',
    });
    expect(stored.keys).toHaveLength(0);
  });

  test('keeps a future expiry, and no expiry', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await create(request(future));
    await create(request());
    expect(stored.keys.map((k) => k.expiresAt?.toISOString() ?? null)).toEqual([future, null]);
  });
});
