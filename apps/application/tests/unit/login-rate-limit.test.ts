import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { H3Event } from 'h3';
import { apiError } from '../../server/utils/api-error';
import { rateLimitKeyCount } from '../../server/utils/rate-limit';

/**
 * The login route's throttle: attempts sent together each take a slot before
 * the password is checked, so no more than an account's limit from one address,
 * or its ceiling across addresses, is ever tried in one window, failures from
 * other addresses leave the owner's own below the ceiling, and a valid login
 * gives its slots back. An account counts by its id, whichever of its names is
 * typed; text that names no account counts by itself.
 */

const auth = vi.hoisted(() => ({
  /** Resolves every pending password check at once. */
  release: () => {},
  correct: 'right-password',
  /** A password whose check the server refuses as too busy. */
  busy: 'busy-password',
  /** The account id each registered name resolves to; any other text names no account. */
  accounts: new Map<string, number>(),
  /** Text whose account lookup fails. */
  lookupFails: 'lookup-fails',
}));

vi.mock('../../server/database', () => ({ getDatabase: async () => ({}) }));
vi.mock('../../server/utils/auth', () => ({
  isAuthEnabled: () => true,
  authUserView: async () => ({ id: 1, username: 'ada', role: 'member' }),
  setUserSession: async () => {},
  findLoginAccount: async (_db: unknown, identifier: string) => {
    if (identifier === auth.lookupFails) throw new Error('database unavailable');
    const id = auth.accounts.get(identifier);
    return id === undefined ? null : { id, username: identifier, sessionEpoch: 0 };
  },
  verifyUser: async (_event: unknown, user: { id: number } | null, password: string) => {
    await new Promise<void>((resolve) => {
      const previous = auth.release;
      auth.release = () => {
        previous();
        resolve();
      };
    });
    if (password === auth.busy) throw Object.assign(new Error('busy'), { statusCode: 503 });
    return password === auth.correct ? { id: user?.id ?? 1, username: 'ada', sessionEpoch: 0 } : null;
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
  auth.accounts.clear();
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

  test('wrong passwords from other addresses do not lock the owner out', async () => {
    const username = `ada${address}`;
    const elsewhere = Array.from({ length: 15 }, (_, i) => request(`10.1.${address}.${i % 3}`, username, 'wrong'));
    expect(await together(elsewhere)).toEqual(Array.from({ length: 15 }, () => 401));
    expect(await together([request(`10.0.0.${address}`, username, auth.correct)])).toEqual([200]);
  });

  test("an account's failures from every address together stop at fifty", async () => {
    const username = `ada${address}`;
    const spread = Array.from({ length: 55 }, (_, i) => request(`10.2.${address}.${i % 11}`, username, 'wrong'));
    const statuses = await together(spread);
    expect(statuses.filter((s) => s === 401)).toHaveLength(50);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(await together([request(`10.0.0.${address}`, username, auth.correct)])).toEqual([429]);
  });

  test("a valid login gives back its slot of the account's ceiling", async () => {
    const username = `ada${address}`;
    const spread = Array.from({ length: 45 }, (_, i) => request(`10.3.${address}.${i % 9}`, username, 'wrong'));
    expect(await together(spread)).toEqual(Array.from({ length: 45 }, () => 401));
    expect(await together([request(`10.0.0.${address}`, username, auth.correct)])).toEqual([200]);
    const fromOne = Array.from({ length: 6 }, () => request(`10.4.${address}.0`, username, 'wrong'));
    const statuses = await together(fromOne);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(await together([request(`10.4.${address}.1`, username, 'wrong')])).toEqual([429]);
  });

  test('a check refused as busy gives its slots back', async () => {
    const ip = `10.0.0.${address}`;
    const username = `ada${address}`;
    for (let i = 0; i < 8; i++) expect(await together([request(ip, username, auth.busy)])).toEqual([503]);
    const statuses = await together(Array.from({ length: 6 }, () => request(ip, username, 'wrong')));
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
  });

  test('checks refused as busy leave no key behind, whatever username they name', async () => {
    const ip = `10.0.0.${address}`;
    const before = rateLimitKeyCount();
    for (let i = 0; i < 30; i++) {
      expect(await together([request(ip, `someone${address}-${i}`, auth.busy)])).toEqual([503]);
    }
    expect(rateLimitKeyCount()).toBe(before);
  });

  test('text longer than any email address is refused before it names a key', async () => {
    const ip = `10.0.0.${address}`;
    const before = rateLimitKeyCount();
    expect(await together([request(ip, 'a'.repeat(255), 'wrong')])).toEqual([400]);
    expect(rateLimitKeyCount()).toBe(before);
    expect(await together([request(ip, 'a'.repeat(254), 'wrong')])).toEqual([401]);
  });

  test('a lookup that fails takes no slot', async () => {
    const ip = `10.0.0.${address}`;
    const before = rateLimitKeyCount();
    for (let i = 0; i < 25; i++) expect(await together([request(ip, auth.lookupFails, 'wrong')])).toEqual([500]);
    expect(rateLimitKeyCount()).toBe(before);
    const statuses = await together(Array.from({ length: 6 }, () => request(ip, `ada${address}`, 'wrong')));
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
  });

  test('switching between the username and the email of one account gets no extra attempts', async () => {
    const ip = `10.0.0.${address}`;
    auth.accounts.set(`ada${address}`, 1000 + address);
    auth.accounts.set(`ada${address}@example.com`, 1000 + address);
    auth.accounts.set(`ADA${address}@EXAMPLE.COM`, 1000 + address);
    const statuses = await together([
      ...Array.from({ length: 2 }, () => request(ip, `ada${address}`, 'wrong')),
      ...Array.from({ length: 2 }, () => request(ip, `ada${address}@example.com`, 'wrong')),
      ...Array.from({ length: 2 }, () => request(ip, `ADA${address}@EXAMPLE.COM`, 'wrong')),
    ]);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  });

  test('two accounts whose usernames differ in letter case count separately', async () => {
    const ip = `10.0.0.${address}`;
    auth.accounts.set(`Kai${address}`, 2000 + address);
    auth.accounts.set(`kai${address}`, 3000 + address);
    const statuses = await together([
      ...Array.from({ length: 5 }, () => request(ip, `Kai${address}`, 'wrong')),
      ...Array.from({ length: 5 }, () => request(ip, `kai${address}`, 'wrong')),
    ]);
    expect(statuses).toEqual(Array.from({ length: 10 }, () => 401));
  });

  test('two texts that name no account count separately, and never as an account', async () => {
    const ip = `10.0.0.${address}`;
    const id = 4000 + address;
    auth.accounts.set(`noor${address}`, id);
    const statuses = await together([
      ...Array.from({ length: 5 }, () => request(ip, `ghost${address}-a`, 'wrong')),
      ...Array.from({ length: 5 }, () => request(ip, `ghost${address}-b`, 'wrong')),
      ...Array.from({ length: 5 }, () => request(ip, String(id), 'wrong')),
      ...Array.from({ length: 5 }, () => request(ip, `noor${address}`, 'wrong')),
    ]);
    expect(statuses).toEqual(Array.from({ length: 20 }, () => 401));
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
