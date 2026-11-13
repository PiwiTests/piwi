import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { H3Event } from 'h3';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));

const { findLoginAccount, hashPassword, verifyUser } = await import('../../server/utils/auth');

/** The request a busy server's 503 would answer, from the client whose share its hashes count against. */
const event = {
  context: {},
  node: { req: { headers: {}, socket: { remoteAddress: '192.0.2.20' } }, res: { setHeader: () => {} } },
} as unknown as H3Event;

/** The id of the account the typed text resolves to, null for none. */
async function resolvedId(identifier: string): Promise<number | null> {
  return (await findLoginAccount(db, identifier))?.id ?? null;
}

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
});
afterEach(() => close());

describe('the account a sign-in names', () => {
  test("a username wins over another account's email", async () => {
    await db.insert(schema.users).values([
      { id: 1, username: 'a@x.com', password: 'x', role: 'member', email: 'moved@x.com' },
      { id: 2, username: 'bea', password: 'x', role: 'member', email: 'a@x.com' },
    ]);
    expect(await resolvedId('a@x.com')).toBe(1);
    expect(await resolvedId('bea')).toBe(2);
    expect(await resolvedId('moved@x.com')).toBe(1);
  });

  test('an email matches in any letter case, verified or not', async () => {
    await db.insert(schema.users).values({
      id: 3,
      username: 'ada',
      password: 'x',
      role: 'member',
      email: 'Ada@Example.com',
      emailVerified: false,
    });
    expect(await resolvedId('ada@example.com')).toBe(3);
    expect(await resolvedId('ADA@EXAMPLE.COM')).toBe(3);
  });

  test('a username matches in its own letter case only', async () => {
    await db.insert(schema.users).values({ id: 4, username: 'Lee', password: 'x', role: 'member' });
    expect(await resolvedId('Lee')).toBe(4);
    expect(await resolvedId('lee')).toBeNull();
  });

  test('an account a provider created, its username its address, signs in with that address', async () => {
    const password = await hashPassword(event, 'kim-password');
    await db.insert(schema.users).values({
      id: 5,
      username: 'kim@example.com',
      password,
      role: 'member',
      email: 'kim@example.com',
      oauthProvider: 'github',
      oauthProviderId: '42',
    });
    expect((await verifyUser(event, await findLoginAccount(db, 'kim@example.com'), 'kim-password'))?.id).toBe(5);
    expect(await verifyUser(event, await findLoginAccount(db, 'kim@example.com'), 'wrong')).toBeNull();
  });

  test('text without an @ never matches an email', async () => {
    await db.insert(schema.users).values({ id: 6, username: 'max', password: 'x', role: 'member', email: 'max-local' });
    expect(await resolvedId('max-local')).toBeNull();
    expect(await resolvedId('MAX-LOCAL')).toBeNull();
  });

  test('text that names no account resolves to none, and no password matches it', async () => {
    await db.insert(schema.users).values({ id: 7, username: 'noa', password: 'x', role: 'member', email: 'noa@x.com' });
    expect(await resolvedId('nobody')).toBeNull();
    expect(await resolvedId('nobody@x.com')).toBeNull();
    expect(await verifyUser(event, null, 'anything')).toBeNull();
  });
});
