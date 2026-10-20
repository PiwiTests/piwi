import { beforeEach, describe, expect, test, vi } from 'vitest';
import { apiError } from '../../server/utils/api-error';

/** `POST /api/auth/logout`: it clears the cookie and revokes every session of the signed-in user. */

const state = vi.hoisted(() => ({
  authEnabled: true,
  user: null as { id: number } | null,
  calls: [] as string[],
}));
vi.mock('../../server/utils/auth', () => ({
  isAuthEnabled: () => state.authEnabled,
  getCurrentUser: async () => state.user,
  revokeUserSessions: async (userId: number) => {
    state.calls.push(`revoke:${userId}`);
    return 1;
  },
  clearUserSession: async () => {
    state.calls.push('clear');
  },
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('apiError', apiError);

const logout = (await import('../../server/api/auth/logout.post')).default as unknown as (
  event: object,
) => Promise<{ success: boolean }>;

beforeEach(() => {
  state.authEnabled = true;
  state.user = null;
  state.calls = [];
});

describe('POST /api/auth/logout', () => {
  test('revokes every session of the signed-in user, then clears the cookie', async () => {
    state.user = { id: 7 };
    await expect(logout({})).resolves.toEqual({ success: true });
    expect(state.calls).toEqual(['revoke:7', 'clear']);
  });

  test('only clears the cookie when no valid session comes with the request', async () => {
    await expect(logout({})).resolves.toEqual({ success: true });
    expect(state.calls).toEqual(['clear']);
  });

  test('is refused when authentication is off', async () => {
    state.authEnabled = false;
    await expect(logout({})).rejects.toMatchObject({ statusCode: 400 });
    expect(state.calls).toEqual([]);
  });
});
