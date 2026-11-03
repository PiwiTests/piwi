import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { H3Event } from 'h3';
import { apiError } from '../../server/utils/api-error';
import { rateLimitKeyCount } from '../../server/utils/rate-limit';

/**
 * The password change's throttle: every attempt takes its slots before the
 * current password is checked and holds them until it ends, so an account
 * never has more than five checks running or waiting, wrong current passwords
 * count per account and per address, and any other outcome gives its slots
 * back.
 */

const auth = vi.hoisted(() => ({
  /** Resolves every pending password check at once. */
  release: () => {},
  /** How many password checks have started. */
  checks: 0,
  correct: 'right-password',
  /** A password whose check the server refuses as too busy. */
  busy: 'busy-password',
}));

vi.mock('../../server/database', () => ({
  getDatabase: async () => ({
    select: () => ({ from: () => ({ where: async () => [{ id: 1, password: 'stored-hash' }] }) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  }),
}));
vi.mock('../../server/utils/auth', () => ({
  requireSessionAuth: async (event: { userId: number }) => ({ id: event.userId }),
  verifyPassword: async (_event: unknown, password: string) => {
    auth.checks += 1;
    await new Promise<void>((resolve) => {
      const previous = auth.release;
      auth.release = () => {
        previous();
        resolve();
      };
    });
    if (password === auth.busy) throw Object.assign(new Error('busy'), { statusCode: 503 });
    return password === auth.correct;
  },
  hashPassword: async () => 'new-hash',
  revokeUserSessions: async () => 1,
  setUserSession: async () => {},
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: { body: unknown }) => event.body);
vi.stubGlobal('apiError', apiError);

const changePassword = (await import('../../server/api/auth/change-password.post')).default as unknown as (
  event: H3Event,
) => Promise<unknown>;

let round = 0;

/** A password change by user `userId` from `remoteAddress`. */
function request(remoteAddress: string, userId: number, currentPassword: string) {
  return {
    userId,
    body: { currentPassword, newPassword: 'a-new-password' },
    context: {},
    node: { req: { headers: {}, socket: { remoteAddress } }, res: { setHeader: () => {} } },
  } as unknown as H3Event;
}

/** Send every request together, then let the password checks finish, and collect each status. */
async function together(events: H3Event[]): Promise<number[]> {
  const pending = events.map((event) =>
    changePassword(event).then(
      () => 200,
      (e: { statusCode?: number }) => e.statusCode ?? 500,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  auth.release();
  return Promise.all(pending);
}

beforeEach(() => {
  auth.release = () => {};
  auth.checks = 0;
  round += 1;
});

describe('password change throttle', () => {
  test('ten wrong current passwords sent together check five, and refuse the rest', async () => {
    const statuses = await together(Array.from({ length: 10 }, () => request(`10.0.0.${round}`, round, 'wrong')));
    expect(statuses.filter((s) => s === 400)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(auth.checks).toBe(5);
  });

  test('an account never has more than five checks running or waiting, right passwords included', async () => {
    const statuses = await together(Array.from({ length: 10 }, () => request(`10.0.0.${round}`, round, auth.correct)));
    expect(auth.checks).toBe(5);
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  test('one address is held to twenty wrong current passwords across accounts', async () => {
    const ip = `10.1.0.${round}`;
    const statuses = await together(Array.from({ length: 30 }, (_, i) => request(ip, 1000 * round + i, 'wrong')));
    expect(statuses.filter((s) => s === 400)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
  });

  test('a right current password gives its slots back, wrong ones keep theirs', async () => {
    const ip = `10.0.0.${round}`;
    expect(await together(Array.from({ length: 4 }, () => request(ip, round, 'wrong')))).toEqual([400, 400, 400, 400]);
    expect(await together([request(ip, round, auth.correct)])).toEqual([200]);
    expect(await together([request(ip, round, 'wrong')])).toEqual([400]);
    expect(await together([request(ip, round, auth.correct)])).toEqual([429]);
  });

  test('a check refused as busy gives its slots back and leaves no key behind', async () => {
    const ip = `10.2.0.${round}`;
    const before = rateLimitKeyCount();
    for (let i = 0; i < 8; i++) expect(await together([request(ip, round, auth.busy)])).toEqual([503]);
    expect(rateLimitKeyCount()).toBe(before);
    const statuses = await together(Array.from({ length: 6 }, () => request(ip, round, 'wrong')));
    expect(statuses.filter((s) => s === 400)).toHaveLength(5);
  });
});
