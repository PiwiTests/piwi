import { beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/rate-limit', () => ({
  checkRateLimit: () => true,
  rateLimitClientIp: () => 'test',
  rateLimitedError: () => new Error('rate limited'),
}));
vi.mock('../../server/utils/auth', () => ({
  hashPassword: async (password: string) => `hashed:${password}`,
  revokeUserSessions: async () => 0,
  clearUserSession: async () => {},
}));

interface FakeEvent {
  query?: Record<string, string>;
  body?: unknown;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query ?? {});
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('sendRedirect', (_event: FakeEvent, location: string) => ({ location }));
vi.stubGlobal('apiError', apiError);

const { mintAccountToken, validateAccountToken } = await import('../../server/utils/account-tokens');
const { updateUserRecord } = await import('../../shared/handlers/users');
type Handler = (event: FakeEvent) => Promise<unknown>;
const verifyEmail = (await import('../../server/api/auth/verify-email.get')).default as unknown as Handler;
const resetPassword = (await import('../../server/api/auth/reset-password.post')).default as unknown as Handler;

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const ALICE = 'alice@example.com';
const OTHER = 'someone-else@example.com';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  await db.insert(schema.users).values({ id: 1, username: 'alice', password: 'old', role: 'member', email: ALICE });
});

async function account() {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, 1));
  return row!;
}

async function changeEmail(email: string | null) {
  await updateUserRecord(db as any, 1, { email });
}

describe('validateAccountToken', () => {
  test('a token sent to the address the account holds is valid', async () => {
    const token = await mintAccountToken(db, 1, 'verify', ALICE);
    expect(await validateAccountToken(db, token, 'verify')).toMatchObject({ userId: 1, email: ALICE });
  });

  test.each([OTHER, null])('a token is refused once the address changes to %s', async (email) => {
    const token = await mintAccountToken(db, 1, 'reset', ALICE);
    await changeEmail(email);
    expect(await validateAccountToken(db, token, 'reset')).toBeNull();
  });

  test('a token is valid again once the account holds its address again', async () => {
    const token = await mintAccountToken(db, 1, 'invite', ALICE);
    await changeEmail(OTHER);
    await changeEmail(ALICE);
    expect(await validateAccountToken(db, token, 'invite')).toMatchObject({ email: ALICE });
  });

  test('a token sent to another address than the account holds is refused', async () => {
    const token = await mintAccountToken(db, 1, 'verify', OTHER);
    expect(await validateAccountToken(db, token, 'verify')).toBeNull();
  });

  test('a token that records no address is refused', async () => {
    const token = await mintAccountToken(db, 1, 'verify', ALICE);
    await db.update(schema.accountTokens).set({ email: null });
    expect(await validateAccountToken(db, token, 'verify')).toBeNull();
  });
});

describe('GET /api/auth/verify-email', () => {
  test('verifies the address the link was sent to', async () => {
    const token = await mintAccountToken(db, 1, 'verify', ALICE);

    expect(await verifyEmail({ query: { token } })).toEqual({ location: '/settings/account?verified=1' });

    expect(await account()).toMatchObject({ email: ALICE, emailVerified: true });
  });

  test('a link sent before the address changed verifies nothing', async () => {
    const token = await mintAccountToken(db, 1, 'verify', ALICE);
    await changeEmail(OTHER);

    await expect(verifyEmail({ query: { token } })).rejects.toMatchObject({ statusCode: 400 });

    expect(await account()).toMatchObject({ email: OTHER, emailVerified: false });
  });
});

describe('POST /api/auth/reset-password', () => {
  test('an invite accepted at the address it was sent to sets the password and verifies the address', async () => {
    const token = await mintAccountToken(db, 1, 'invite', ALICE);

    expect(await resetPassword({ body: { token, password: 'new-password' } })).toEqual({ success: true });

    expect(await account()).toMatchObject({ password: 'hashed:new-password', emailVerified: true });
  });

  test.each(['invite', 'reset'] as const)(
    'a "%s" link sent before the address changed sets no password',
    async (purpose) => {
      const token = await mintAccountToken(db, 1, purpose, ALICE);
      await changeEmail(OTHER);

      await expect(resetPassword({ body: { token, password: 'new-password' } })).rejects.toMatchObject({
        statusCode: 400,
      });

      expect(await account()).toMatchObject({ password: 'old', email: OTHER, emailVerified: false });
    },
  );
});
