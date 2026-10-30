import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { OAuthProfile } from '../../server/utils/oauth-helpers';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before oauth.ts (which imports the barrel) loads.
delete process.env.PIWI_DATABASE_URL;
const { findOrCreateOAuthUser, linkProviderToUser } = await import('../../server/utils/oauth');
const { mintAccountToken, validateAccountToken } = await import('../../server/utils/account-tokens');

const MIGRATIONS = fileURLToPath(new URL('../../server/database/migrations', import.meta.url));

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

async function freshDb(migrationsFolder?: string): Promise<Db> {
  const next = drizzle(createClient({ url: ':memory:' }), { schema });
  if (migrationsFolder) await migrate(next, { migrationsFolder });
  else await migrateToLatest(next);
  return next;
}

const profile = (over: Partial<OAuthProfile> = {}): OAuthProfile => ({
  provider: 'google',
  providerId: 'google-bob',
  email: 'bob@corp.com',
  emailVerified: true,
  name: 'Bob',
  avatar: '',
  ...over,
});

async function addUser(values: Partial<typeof schema.users.$inferInsert> & { username: string }) {
  const [user] = await db
    .insert(schema.users)
    .values({ password: 'hash', role: 'member', ...values })
    .returning();
  return user!;
}

beforeEach(async () => {
  db = await freshDb();
});

describe('findOrCreateOAuthUser — email compared ignoring case', () => {
  test('a verified provider email links the account whose address differs only by case', async () => {
    const bob = await addUser({ username: 'bob', email: 'Bob@corp.com', emailVerified: true });

    const signedIn = await findOrCreateOAuthUser(profile(), db);

    expect(signedIn.id).toBe(bob.id);
    expect(signedIn).toMatchObject({ oauthProvider: 'google', oauthProviderId: 'google-bob' });
    expect(await db.select().from(schema.users)).toHaveLength(1);
  });

  test('the account still has to have verified the address itself', async () => {
    await addUser({ username: 'bob', email: 'Bob@corp.com', emailVerified: false });

    await expect(findOrCreateOAuthUser(profile(), db)).rejects.toMatchObject({
      data: { oauthError: 'email-unverified' },
    });
    expect(await db.select().from(schema.users)).toHaveLength(1);
  });

  test('a later sign-in whose address differs only by case keeps the account verified, its spelling and its links', async () => {
    const bob = await addUser({
      username: 'bob',
      email: 'Bob@corp.com',
      emailVerified: true,
      oauthProvider: 'github',
      oauthProviderId: 'github-bob',
    });
    const reset = await mintAccountToken(db, bob.id, 'reset', 'Bob@corp.com');

    const signedIn = await findOrCreateOAuthUser(
      profile({ provider: 'github', providerId: 'github-bob', emailVerified: false }),
      db,
    );

    expect(signedIn.id).toBe(bob.id);
    expect(signedIn.emailVerified).toBe(true);
    expect(signedIn.email).toBe('Bob@corp.com');
    expect(await validateAccountToken(db, reset, 'reset')).toMatchObject({ userId: bob.id });
  });
});

describe('linkProviderToUser — email compared ignoring case', () => {
  test('an address another account owns is not copied to the account the provider links to', async () => {
    const bob = await addUser({ username: 'bob', email: 'Bob@corp.com', emailVerified: true });
    const alice = await addUser({ username: 'alice' });

    const linked = await linkProviderToUser(alice.id, profile(), db);

    expect(linked).toMatchObject({ id: alice.id, oauthProvider: 'google', email: null, emailVerified: false });
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.id, bob.id));
    expect(owner).toMatchObject({ email: 'Bob@corp.com', emailVerified: true });
  });

  test('a provider linked without its address keeps signing in, and the address stays with its owner', async () => {
    const bob = await addUser({ username: 'bob', email: 'Bob@corp.com', emailVerified: true });
    const octo = await addUser({ username: 'octo', oauthProvider: 'github', oauthProviderId: 'github-octo' });
    await linkProviderToUser(octo.id, profile(), db);

    const signedIn = await findOrCreateOAuthUser(profile(), db);

    expect(signedIn).toMatchObject({ id: octo.id, email: null, emailVerified: false, oauthProvider: 'google' });
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.id, bob.id));
    expect(owner).toMatchObject({ email: 'Bob@corp.com', emailVerified: true });
  });

  test('an address no account owns is copied to an account without one', async () => {
    const alice = await addUser({ username: 'alice' });

    const linked = await linkProviderToUser(alice.id, profile({ email: 'alice@corp.com' }), db);

    expect(linked).toMatchObject({ email: 'alice@corp.com', emailVerified: true });
  });
});

describe('idx_users_email', () => {
  test('refuses a second account whose address differs only by case', async () => {
    await addUser({ username: 'bob', email: 'Bob@corp.com' });
    await expect(addUser({ username: 'bob2', email: 'bob@corp.com' })).rejects.toThrow();
  });

  test('allows any number of accounts without an address', async () => {
    await addUser({ username: 'a' });
    await addUser({ username: 'b' });
    expect(await db.select().from(schema.users)).toHaveLength(2);
  });
});

describe('upgrading a database whose users share an address that differs only by case', () => {
  const folders: string[] = [];
  afterAll(() => {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });

  /** A copy of the migrations folder that stops before `tag`, as an older version ships it. */
  function migrationsBefore(tag: string): string {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const end = journal.entries.findIndex((entry) => entry.tag.endsWith(tag));
    expect(end).toBeGreaterThan(0);
    const folder = mkdtempSync(join(tmpdir(), 'piwi-migrations-'));
    folders.push(folder);
    mkdirSync(join(folder, 'meta'));
    const entries = journal.entries.slice(0, end);
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    return folder;
  }

  test('stops with an error that names the problem and keeps both accounts', async () => {
    db = await freshDb(migrationsBefore('_check_email_case_duplicates'));
    await addUser({ username: 'bob', email: 'Bob@corp.com' });
    await addUser({ username: 'bob2', email: 'bob@corp.com' });

    await expect(migrate(db, { migrationsFolder: MIGRATIONS })).rejects.toThrow(
      /same email address written with different letter case/,
    );
    expect(await db.select().from(schema.users)).toHaveLength(2);
  });

  test('goes through once each address belongs to one account', async () => {
    db = await freshDb(migrationsBefore('_check_email_case_duplicates'));
    await addUser({ username: 'bob', email: 'Bob@corp.com' });
    await addUser({ username: 'alice', email: 'alice@corp.com' });

    await migrate(db, { migrationsFolder: MIGRATIONS });

    await expect(addUser({ username: 'bob2', email: 'BOB@corp.com' })).rejects.toThrow();
  });
});

// A GitHub identity whose address the provider has not verified, the case the
// tests below cover; `profile` above is a verified Google identity.
const githubProfile = (over: Partial<OAuthProfile> = {}): OAuthProfile => ({
  provider: 'github',
  providerId: '583231',
  email: 'alice@example.com',
  emailVerified: false,
  name: 'Alice',
  avatar: '',
  login: 'octocat',
  ...over,
});

async function allUsers() {
  return db.select().from(schema.users).orderBy(schema.users.id);
}

describe('findOrCreateOAuthUser — unverified provider email', () => {
  test('an address no account holds is stored, unverified, and becomes the username', async () => {
    const user = await findOrCreateOAuthUser(githubProfile(), db);
    expect(user).toMatchObject({ username: 'alice@example.com', email: 'alice@example.com', emailVerified: false });
  });

  test.each(['alice@example.com', 'Alice@Example.COM'])(
    'an address another account holds as %s gives a new account without an email',
    async (stored) => {
      await addUser({ id: 1, username: 'alice', email: stored, emailVerified: true });

      const user = await findOrCreateOAuthUser(githubProfile(), db);

      expect(user.id).not.toBe(1);
      expect(user).toMatchObject({
        username: 'octocat',
        email: null,
        emailVerified: false,
        oauthProvider: 'github',
        oauthProviderId: '583231',
      });
      const [existing] = await db.select().from(schema.users).where(eq(schema.users.id, 1));
      expect(existing).toMatchObject({ email: stored, oauthProvider: null });
    },
  );

  test('a taken username gets the first free numbered one', async () => {
    await addUser({ id: 1, username: 'alice@example.com', email: null });
    await addUser({ id: 2, username: 'alice@example.com-2', email: null });

    const user = await findOrCreateOAuthUser(githubProfile(), db);

    expect(user).toMatchObject({ username: 'alice@example.com-3', email: 'alice@example.com' });
  });

  test('without a login, a held address gives a username from the provider id', async () => {
    await addUser({ id: 1, username: 'alice', email: 'alice@example.com' });

    const user = await findOrCreateOAuthUser(githubProfile({ provider: 'google', login: undefined }), db);

    expect(user).toMatchObject({ username: 'google-583231', email: null });
  });

  test('a second identity with the same unverified address gets an account without it', async () => {
    const first = await findOrCreateOAuthUser(githubProfile(), db);
    const second = await findOrCreateOAuthUser(githubProfile({ providerId: '999', login: 'octocat2' }), db);

    expect(first.email).toBe('alice@example.com');
    expect(second).toMatchObject({ username: 'octocat2', email: null });
  });
});

describe('findOrCreateOAuthUser — no email address from the provider', () => {
  test('a GitHub profile without an email takes its login as username and stores no email', async () => {
    await addUser({ id: 1, username: 'octocat', email: null });

    const user = await findOrCreateOAuthUser(githubProfile({ email: '' }), db);

    expect(user).toMatchObject({ username: 'octocat-2', email: null, emailVerified: false });
  });

  test('a value that is not an address is never written to users.email', async () => {
    const user = await findOrCreateOAuthUser(githubProfile({ email: 'octocat', emailVerified: true }), db);

    expect(user).toMatchObject({ username: 'octocat', email: null, emailVerified: false });
  });

  test('a later sign-in clears a stored value that is not an address', async () => {
    await addUser({
      id: 1,
      username: 'octocat',
      email: 'octocat',
      password: '',
      oauthProvider: 'github',
      oauthProviderId: '583231',
    });

    const user = await findOrCreateOAuthUser(githubProfile({ email: '' }), db);

    expect(user).toMatchObject({ id: 1, email: null, emailVerified: false });
  });
});

describe('findOrCreateOAuthUser — linked and verified accounts', () => {
  test('a verified address links the account that verified it, ignoring case', async () => {
    await addUser({ id: 1, username: 'alice', email: 'Alice@Example.com', emailVerified: true });

    const user = await findOrCreateOAuthUser(githubProfile({ emailVerified: true }), db);

    expect(user).toMatchObject({ id: 1, oauthProvider: 'github', oauthProviderId: '583231' });
    expect(await allUsers()).toHaveLength(1);
  });

  test('a returning identity signs in to its account even when its new address is held elsewhere', async () => {
    await addUser({
      id: 1,
      username: 'alice@example.com',
      email: 'alice@example.com',
      emailVerified: true,
      password: '',
      oauthProvider: 'github',
      oauthProviderId: '583231',
    });
    await addUser({ id: 2, username: 'bob', email: 'bob@example.com' });

    const user = await findOrCreateOAuthUser(githubProfile({ email: 'BOB@example.com', emailVerified: true }), db);

    expect(user).toMatchObject({ id: 1, email: 'alice@example.com', emailVerified: true });
    expect(await allUsers()).toHaveLength(2);
  });

  test('a returning identity signs in to the same account', async () => {
    const first = await findOrCreateOAuthUser(githubProfile(), db);
    const again = await findOrCreateOAuthUser(githubProfile(), db);

    expect(again.id).toBe(first.id);
    expect(await allUsers()).toHaveLength(1);
  });
});
