/**
 * The data migration that hands project access to role bindings
 * (`0105_role_bindings_from_assignments`): a database migrated up to just
 * before it gets users, projects and project assignments, then the rest of the
 * migrations run as at startup.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { asc } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';

const migrationsFolder = fileURLToPath(new URL('../../server/database/migrations', import.meta.url));
const DATA_MIGRATION = '0105_role_bindings_from_assignments';
const BACKFILL_KEY = 'project_assignments_backfilled';

let folderBefore: string;

beforeAll(() => {
  // The migrations folder cut just before the data migration.
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((entry) => entry.tag === DATA_MIGRATION);
  expect(cut).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, cut);
  folderBefore = mkdtempSync(join(tmpdir(), 'piwi-role-bindings-'));
  mkdirSync(join(folderBefore, 'meta'));
  writeFileSync(join(folderBefore, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(folderBefore, `${entry.tag}.sql`));
  }
});

afterAll(() => {
  rmSync(folderBefore, { recursive: true, force: true });
});

let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: folderBefore });
});

const ASSIGNED_AT = 1_700_000_000_000;

async function addUsers(...rows: [id: number, username: string, role: string][]) {
  await db.insert(schema.users).values(rows.map(([id, username, role]) => ({ id, username, password: '', role })));
}

/** Projects as the schema before the data migration holds them: the columns added since are not there yet. */
async function addProjects(...ids: number[]) {
  for (const id of ids) {
    await client.execute({
      sql: 'INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      args: [id, `project-${id}`, ASSIGNED_AT / 1000, ASSIGNED_AT / 1000],
    });
  }
}

async function assign(userId: number, projectId: number | null, createdBy: number | null = null) {
  await client.execute({
    sql: 'INSERT INTO project_assignments (user_id, project_id, created_by, created_at) VALUES (?, ?, ?, ?)',
    args: [userId, projectId, createdBy, ASSIGNED_AT],
  });
}

async function setBackfill(value: unknown) {
  await db.insert(schema.appSettings).values({ key: BACKFILL_KEY, value });
}

async function finishMigrating() {
  await migrate(db, { migrationsFolder });
}

async function bindings() {
  const rows = await db.select().from(schema.roleBindings).orderBy(asc(schema.roleBindings.id));
  return rows.map((row) => ({ userId: row.userId, projectId: row.projectId, role: row.role }));
}

async function roles(): Promise<Record<string, string>> {
  const rows = await db.select({ username: schema.users.username, role: schema.users.role }).from(schema.users);
  return Object.fromEntries(rows.map((row) => [row.username, row.role]));
}

describe('project assignments', () => {
  test('become bindings: Maintainer for a reporter, Viewer for a user, on the same scope', async () => {
    await addUsers([1, 'avery', 'administrator'], [2, 'robin', 'reporter'], [3, 'sam', 'user']);
    await addProjects(10, 11);
    await assign(2, null, 1);
    await assign(2, 10, 1);
    await assign(3, 10, 1);
    await assign(3, 11);
    await setBackfill(true);

    await finishMigrating();

    expect(await bindings()).toEqual([
      { userId: 2, projectId: null, role: 'maintainer' },
      { userId: 2, projectId: 10, role: 'maintainer' },
      { userId: 3, projectId: 10, role: 'viewer' },
      { userId: 3, projectId: 11, role: 'viewer' },
    ]);
    const [first] = await db.select().from(schema.roleBindings).orderBy(asc(schema.roleBindings.id)).limit(1);
    expect(first).toMatchObject({ createdBy: 1, groupId: null });
    expect(first!.createdAt.getTime()).toBe(ASSIGNED_AT);
  });

  test("an administrator's assignments are dropped: the instance role already grants everything", async () => {
    await addUsers([1, 'avery', 'administrator']);
    await addProjects(10);
    await assign(1, 10);
    await setBackfill(true);

    await finishMigrating();

    expect(await bindings()).toEqual([]);
    expect(await roles()).toEqual({ avery: 'administrator' });
  });

  test('two all-projects assignments of one user become one binding', async () => {
    await addUsers([2, 'robin', 'reporter']);
    await assign(2, null);
    await assign(2, null);
    await setBackfill(true);

    await finishMigrating();

    expect(await bindings()).toEqual([{ userId: 2, projectId: null, role: 'maintainer' }]);
  });
});

describe('instance roles', () => {
  test('reporters and users become members; administrators and other roles are kept', async () => {
    await addUsers([1, 'avery', 'administrator'], [2, 'robin', 'reporter'], [3, 'sam', 'user'], [4, 'kim', 'member']);
    await setBackfill(true);

    await finishMigrating();

    expect(await roles()).toEqual({ avery: 'administrator', robin: 'member', sam: 'member', kim: 'member' });
  });
});

describe('the one-time all-projects grant', () => {
  test.each([
    ['still owed', 'owed'],
    ['interrupted while granting', 'granting'],
  ])('is made when %s and no assignment exists', async (_state, value) => {
    await addUsers([1, 'avery', 'administrator'], [2, 'robin', 'reporter'], [3, 'sam', 'user']);
    await setBackfill(value);

    await finishMigrating();

    expect(await bindings()).toEqual([
      { userId: 2, projectId: null, role: 'maintainer' },
      { userId: 3, projectId: null, role: 'viewer' },
    ]);
  });

  test('is made on a database that never recorded it, dated now', async () => {
    await addUsers([3, 'sam', 'user']);
    const before = Date.now();

    await finishMigrating();

    const rows = await db.select().from(schema.roleBindings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 3, projectId: null, role: 'viewer', createdBy: null });
    expect(rows[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rows[0]!.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('is not made once settled: a user left without access stays without access', async () => {
    await addUsers([2, 'robin', 'reporter'], [3, 'sam', 'user']);
    await setBackfill(true);

    await finishMigrating();

    expect(await bindings()).toEqual([]);
  });

  test('is not made when assignments already exist, even if still owed', async () => {
    await addUsers([2, 'robin', 'reporter'], [3, 'sam', 'user']);
    await addProjects(10);
    await assign(2, 10);
    await setBackfill('owed');

    await finishMigrating();

    expect(await bindings()).toEqual([{ userId: 2, projectId: 10, role: 'maintainer' }]);
  });

  test('leaves no setting behind', async () => {
    await addUsers([3, 'sam', 'user']);
    await setBackfill('owed');

    await finishMigrating();

    expect(await db.select().from(schema.appSettings)).toEqual([]);
  });
});

test('the project_assignments table is gone once every migration ran', async () => {
  await finishMigrating();
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_assignments'",
  );
  expect(tables.rows).toEqual([]);
});
