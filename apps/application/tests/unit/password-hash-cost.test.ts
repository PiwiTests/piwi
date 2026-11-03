import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { scryptSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { H3Event } from 'h3';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * A password is checked only against a stored hash within the cost Piwi writes
 * (N ≤ 2^17, r ≤ 8, p ≤ 1, a 64-byte key and a 32-character salt at most). Any
 * hash above it fails as a wrong password does, never reaches scrypt, and the
 * first one a process meets logs a warning naming its account.
 */

const crypto = vi.hoisted(() => ({
  /** The scrypt options of each call, in order. */
  calls: [] as { N: number; r: number; p: number }[],
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    scrypt: (...args: Parameters<typeof actual.scrypt>) => {
      crypto.calls.push(args[3] as { N: number; r: number; p: number });
      return (actual.scrypt as (...rest: unknown[]) => void)(...args);
    },
  };
});

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));

/** A fresh copy of the auth module, so each test sees a process that has logged nothing yet. */
async function loadAuth() {
  vi.resetModules();
  return import('../../server/utils/auth');
}

const event = {
  context: {},
  node: { req: { headers: {}, socket: { remoteAddress: '192.0.2.20' } }, res: { setHeader: () => {} } },
} as unknown as H3Event;

const SALT = 'c3'.repeat(16);

/** An encoded hash of `password` at the given parameters, computed without the module under test. */
function encodedHash(password: string, log2N: number, r: number, p: number, salt = SALT, keyLength = 64): string {
  const key = scryptSync(password, salt, keyLength, { N: 2 ** log2N, r, p, maxmem: 256 * 2 ** log2N * r });
  return `scrypt$${log2N}$${r}$${p}$${salt}$${key.toString('hex')}`;
}

/** Hashes of `pw` that declare more than Piwi writes, one parameter at a time. */
const ABOVE_WRITTEN_COST = [
  `scrypt$18$8$1$${SALT}$${'ab'.repeat(64)}`,
  encodedHash('pw', 10, 9, 1),
  encodedHash('pw', 10, 8, 2),
  encodedHash('pw', 10, 8, 1, SALT, 65),
  encodedHash('pw', 10, 8, 1, `${SALT}ab`),
];

/** The warnings logged since the test began. */
const warnings = () => vi.mocked(console.warn).mock.calls;

beforeEach(() => {
  crypto.calls.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('stored password hash cost', () => {
  test('every parameter set Piwi has written still verifies', async () => {
    const { hashPassword, verifyPassword } = await loadAuth();
    const unencoded = `${SALT}:${scryptSync('pw', SALT, 64).toString('hex')}`;
    const current = await hashPassword(event, 'pw');
    expect(current).toMatch(/^scrypt\$17\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);

    for (const hash of [unencoded, current, encodedHash('pw', 12, 8, 1)]) {
      expect(await verifyPassword(event, 'pw', hash, 1)).toBe(true);
      expect(await verifyPassword(event, 'other', hash, 1)).toBe(false);
    }
    expect(warnings()).toEqual([]);
  });

  test('a hash above the written cost fails without reaching scrypt', async () => {
    const { verifyPassword, passwordNeedsRehash } = await loadAuth();
    for (const hash of ABOVE_WRITTEN_COST) {
      expect(await verifyPassword(event, 'pw', hash, 3)).toBe(false);
      expect(passwordNeedsRehash(hash)).toBe(true);
    }
    expect(crypto.calls).toEqual([]);
  });

  describe('signing in', () => {
    let db: TempDb;
    let close: () => Promise<void>;

    beforeEach(async () => {
      ({ db, close } = await openTempDb());
      state.db = db;
    });
    afterEach(() => close());

    test('refuses an account whose hash is above the written cost and logs one warning naming it', async () => {
      const { verifyUser, verifyPassword } = await loadAuth();
      const [costly, other] = ABOVE_WRITTEN_COST;
      await db.insert(schema.users).values({ id: 7, username: 'kim', password: costly!, role: 'member' });

      expect(await verifyUser(event, 'kim', 'pw')).toBeNull();
      expect(await verifyUser(event, 'kim', 'pw')).toBeNull();
      expect(await verifyPassword(event, 'pw', other!, 8)).toBe(false);

      expect(crypto.calls).toEqual([]);
      expect(warnings()).toHaveLength(1);
      const message = String(warnings()[0]![0]);
      expect(message).toContain('user 7');
      expect(message).not.toContain(SALT);
      expect(message).not.toContain('abab');
      const stored = await db
        .select({ password: schema.users.password })
        .from(schema.users)
        .where(eq(schema.users.id, 7));
      expect(stored[0]!.password).toBe(costly);
    });
  });
});
