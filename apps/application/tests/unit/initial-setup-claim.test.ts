import { describe, test, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel (server/database/schema.ts) picks the PostgreSQL schema at
// import time when PIWI_DATABASE_URL is set, so clear it before auth.ts (which
// imports the barrel) is loaded.
delete process.env.PIWI_DATABASE_URL;
const { claimInitialSetup, completeInitialSetup, releaseInitialSetup } = await import('../../server/utils/auth');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

async function freshDb(): Promise<Db> {
  const next = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(next, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  return next;
}

beforeEach(async () => {
  db = await freshDb();
});

describe('claimInitialSetup', () => {
  test('the first claim wins and a later claim loses', async () => {
    expect(await claimInitialSetup(db)).toBe(true);
    // The second claim against the already-claimed state must fail. This is the
    // guarantee POST /api/auth/setup relies on so only one administrator is ever
    // created when the check-then-create window is raced.
    expect(await claimInitialSetup(db)).toBe(false);
  });

  test('a set of concurrent claims yields exactly one winner', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claimInitialSetup(db)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('a finished setup is taken over by exactly one of a set of concurrent claims', async () => {
    // The caller gates on "no administrator exists", so this is an instance whose administrator is gone.
    expect(await claimInitialSetup(db)).toBe(true);
    await completeInitialSetup(db);
    const results = await Promise.all(Array.from({ length: 8 }, () => claimInitialSetup(db)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('a setup finished before this version is taken over too', async () => {
    await db.insert(schema.appSettings).values({ key: 'initial_setup_completed', value: true, updatedAt: new Date(0) });
    expect(await claimInitialSetup(db)).toBe(true);
    expect(await claimInitialSetup(db)).toBe(false);
  });

  test('releasing a claim lets setup be retried', async () => {
    expect(await claimInitialSetup(db)).toBe(true);
    await releaseInitialSetup(db);
    expect(await claimInitialSetup(db)).toBe(true);
  });
});
