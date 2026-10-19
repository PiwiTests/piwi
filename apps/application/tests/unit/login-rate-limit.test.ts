import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { H3Event } from 'h3';
import { apiError } from '../../server/utils/api-error';

/**
 * The login route's throttle: attempts sent together each take a slot before
 * the password is checked, so no more than the account's limit is ever tried
 * in one window, and a valid login gives its slots back.
 */

const auth = vi.hoisted(() => ({
  /** Resolves every pending password check at once. */
  release: () => {},
  correct: 'right-password',
}));

vi.mock('../../server/database', () => ({ getDatabase: async () => ({}) }));
vi.mock('../../server/utils/auth', () => ({
  isAuthEnabled: () => true,
  authUserView: async () => ({ id: 1, username: 'ada', role: 'member' }),
  setUserSession: async () => {},
  verifyUser: async (username: string, password: string) => {
    await new Promise<void>((resolve) => {
      const previous = auth.release;
      auth.release = () => {
        previous();
        resolve();
      };
    });
    return password === auth.correct ? { id: 1, username, sessionEpoch: 0 } : null;
  },
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: { body: unknown }) => event.body);
vi.stubGlobal('apiError', apiError);

const login = (await import('../../server/api/auth/login.post')).default as unknown as (
  event: H3Event,
) => Promise<unknown>;

let address = 0;

/** A login request from `remoteAddress`. */
function request(remoteAddress: string, username: string, password: string) {
  return {
    body: { username, password },
    context: {},
    node: { req: { headers: {}, socket: { remoteAddress } }, res: { setHeader: () => {} } },
  } as unknown as H3Event;
}

/** Send every request together, then let the password checks finish, and collect each status. */
async function together(events: H3Event[]): Promise<number[]> {
  const pending = events.map((event) =>
    login(event).then(
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
  address += 1;
});

describe('login throttle', () => {
  test('ten wrong passwords sent together try five, and refuse the rest', async () => {
    const ip = `10.0.0.${address}`;
    const statuses = await together(Array.from({ length: 10 }, () => request(ip, `ada${address}`, 'wrong')));
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  });

  test('a source sending wrong passwords for many accounts together is held to twenty', async () => {
    const ip = `10.0.0.${address}`;
    const statuses = await together(Array.from({ length: 30 }, (_, i) => request(ip, `user${address}-${i}`, 'wrong')));
    expect(statuses.filter((s) => s === 401)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
  });

  test('a valid login gives its slots back', async () => {
    const ip = `10.0.0.${address}`;
    const username = `ada${address}`;
    expect(await together(Array.from({ length: 4 }, () => request(ip, username, 'wrong')))).toEqual([
      401, 401, 401, 401,
    ]);
    expect(await together([request(ip, username, auth.correct)])).toEqual([200]);
    // The account's counter is clear again: five more wrong passwords are tried.
    const statuses = await together(Array.from({ length: 6 }, () => request(ip, username, 'wrong')));
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
  });
});
