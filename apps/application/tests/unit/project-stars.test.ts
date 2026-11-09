/**
 * Starred projects (`shared/handlers/project-stars.ts`): a user's stars, in the
 * order they were starred, only on the projects they can read now; starring and
 * unstarring twice; and the stars going with their user and with their project,
 * also where the foreign keys' cascade does not run (the demo's database).
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;
const { listProjectStars, starProject, unstarProject } = await import('../../shared/handlers/project-stars');
const { deleteUserRecord } = await import('../../shared/handlers/users');
const { deleteProjectData } = await import('../../shared/handlers/projects');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.users).values([
    { id: 1, username: 'alice', password: 'x', role: 'user' },
    { id: 2, username: 'bob', password: 'x', role: 'user' },
  ]);
  await db.insert(schema.projects).values([
    { id: 10, name: 'shop' },
    { id: 11, name: 'admin-portal' },
    { id: 12, name: 'mobile' },
  ]);
});

/** The stars of `userId` as their rows hold them, whatever the caller may read. */
async function storedStars(userId: number): Promise<number[]> {
  const rows = await db.select().from(schema.projectStars);
  return rows.filter((row) => row.userId === userId).map((row) => row.projectId);
}

describe('listing stars', () => {
  test('lists the projects in the order they were starred, and never another user’s', async () => {
    await starProject(db as any, 1, 12);
    await starProject(db as any, 1, 10);
    await starProject(db as any, 2, 11);
    expect(await listProjectStars(db as any, 1)).toEqual({ projectIds: [12, 10] });
    expect(await listProjectStars(db as any, 2)).toEqual({ projectIds: [11] });
  });

  test('hides a star on a project the user cannot read, and shows it again with the access', async () => {
    await starProject(db as any, 1, 10);
    await starProject(db as any, 1, 11);
    expect(await listProjectStars(db as any, 1, new Set([10]))).toEqual({ projectIds: [10] });
    expect(await listProjectStars(db as any, 1, new Set())).toEqual({ projectIds: [] });
    expect(await storedStars(1)).toEqual([10, 11]);
    expect(await listProjectStars(db as any, 1, new Set([10, 11]))).toEqual({ projectIds: [10, 11] });
  });
});

describe('starring and unstarring', () => {
  test('starring twice keeps one star', async () => {
    await starProject(db as any, 1, 10);
    await starProject(db as any, 1, 10);
    expect(await storedStars(1)).toEqual([10]);
  });

  test('unstarring removes only that user’s star, and unstarring again changes nothing', async () => {
    await starProject(db as any, 1, 10);
    await starProject(db as any, 2, 10);
    await unstarProject(db as any, 1, 10);
    await unstarProject(db as any, 1, 10);
    expect(await storedStars(1)).toEqual([]);
    expect(await storedStars(2)).toEqual([10]);
  });
});

describe.each([
  { name: 'with the foreign keys enforced', foreignKeys: true },
  { name: 'without them, as in the demo', foreignKeys: false },
])('deleting, $name', ({ foreignKeys }) => {
  beforeEach(async () => {
    await starProject(db as any, 1, 10);
    await starProject(db as any, 1, 11);
    await starProject(db as any, 2, 10);
    if (!foreignKeys) await db.run(sql`PRAGMA foreign_keys = OFF`);
  });

  test('deleting a user deletes their stars', async () => {
    await deleteUserRecord(db as any, 1);
    expect(await storedStars(1)).toEqual([]);
    expect(await storedStars(2)).toEqual([10]);
  });

  test('deleting a project deletes the stars on it', async () => {
    await deleteProjectData(db as any, 10);
    expect(await storedStars(1)).toEqual([11]);
    expect(await storedStars(2)).toEqual([]);
  });
});
