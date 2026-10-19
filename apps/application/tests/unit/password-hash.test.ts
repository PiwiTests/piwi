import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { scryptSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));

const { hashPassword, verifyPassword, passwordNeedsRehash, verifyUser } = await import('../../server/utils/auth');

/** A hash in the `salt:key` form, at Node's default scrypt cost. */
function unencodedHash(password: string, salt = 'a1'.repeat(16)): string {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

describe('password hashes', () => {
  test('a new hash carries its scrypt cost and verifies', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^scrypt\$17\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
    expect(passwordNeedsRehash(hash)).toBe(false);
  });

  test('a hash in the salt:key form verifies at the default cost and needs a rehash', async () => {
    const hash = unencodedHash('old password');
    expect(await verifyPassword('old password', hash)).toBe(true);
    expect(await verifyPassword('other', hash)).toBe(false);
    expect(passwordNeedsRehash(hash)).toBe(true);
  });

  test('a hash at another encoded cost verifies with that cost and needs a rehash', async () => {
    const salt = 'b2'.repeat(16);
    const key = scryptSync('pw', salt, 64, { N: 2 ** 12, r: 8, p: 1 }).toString('hex');
    const hash = `scrypt$12$8$1$${salt}$${key}`;
    expect(await verifyPassword('pw', hash)).toBe(true);
    expect(passwordNeedsRehash(hash)).toBe(true);
  });

  test('a malformed hash or an unbounded cost never verifies', async () => {
    for (const hash of [
      '',
      'nocolon',
      'a:b:c',
      `scrypt$30$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`,
      'scrypt$17$8$1$salt$zz',
    ]) {
      expect(await verifyPassword('pw', hash)).toBe(false);
      expect(passwordNeedsRehash(hash)).toBe(true);
    }
  });
});

describe('signing in', () => {
  let db: TempDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    state.db = db;
  });
  afterEach(() => close());

  const storedHash = async () =>
    (await db.select({ password: schema.users.password }).from(schema.users).where(eq(schema.users.id, 1)))[0]!
      .password;

  test('rewrites a hash at an older cost once the password matches', async () => {
    const legacy = unencodedHash('s3cret');
    await db.insert(schema.users).values({ id: 1, username: 'lee', password: legacy, role: 'member' });

    expect(await verifyUser('lee', 'wrong')).toBeNull();
    expect(await storedHash()).toBe(legacy);

    expect((await verifyUser('lee', 's3cret'))?.id).toBe(1);
    const rehashed = await storedHash();
    expect(rehashed).toMatch(/^scrypt\$17\$8\$1\$/);
    expect(await verifyPassword('s3cret', rehashed!)).toBe(true);
  });
});
