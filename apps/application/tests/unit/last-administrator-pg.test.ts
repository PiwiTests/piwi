import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ADMIN_ACCESS, InstanceRole } from '#shared/permissions';

/**
 * The last administrator stays on PostgreSQL under concurrent demotions and
 * deletions, where each read-committed statement sees only what was committed
 * when it started. Runs against `PIWI_POSTGRES_TEST_URL`, in a database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_last_admin_${process.pid}`;
// The schema barrel picks the PostgreSQL schema at import time.
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.pathname = `/${databaseName}`;
  process.env.PIWI_DATABASE_URL = url.toString();
}

describe.skipIf(!postgresUrl)('the last administrator on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const schema = await import('../../server/database/schema.pg');
  const { updateUserAccount, deleteUserAccount } = await import('../../shared/handlers/project-access');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 8 });
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url)),
    });
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  beforeEach(async () => {
    await db.delete(schema.users);
    await db
      .insert(schema.users)
      .values([1, 2, 3].map((id) => ({ id, username: `admin${id}`, password: '', role: InstanceRole.ADMINISTRATOR })));
  });

  const administrators = async () =>
    (await db.select({ role: schema.users.role }).from(schema.users)).filter(
      (u) => u.role === InstanceRole.ADMINISTRATOR,
    ).length;
  const outcome = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: { statusCode?: number }) => error.statusCode ?? 'error',
    );
  const actor = { userId: 99, access: ADMIN_ACCESS };

  test('demoting every administrator at once leaves one', async () => {
    for (let round = 0; round < 10; round++) {
      await db.update(schema.users).set({ role: InstanceRole.ADMINISTRATOR });
      const outcomes = await Promise.all(
        [1, 2, 3].map((id) =>
          outcome(
            updateUserAccount(db as never, id, { role: InstanceRole.MEMBER }, actor, { guardLastAdministrator: true }),
          ),
        ),
      );
      expect(await administrators()).toBe(1);
      expect(outcomes.filter((o) => o === 400)).toHaveLength(1);
    }
  });

  test('deleting every administrator at once leaves one', async () => {
    const outcomes = await Promise.all(
      [1, 2, 3].map((id) => outcome(deleteUserAccount(db as never, id, 99, { guard: true }))),
    );
    expect(await administrators()).toBe(1);
    expect(outcomes.filter((o) => o === 'done')).toHaveLength(2);
  });
});
