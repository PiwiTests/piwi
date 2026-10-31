import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the helper (which imports the barrel) loads.
delete process.env.PIWI_DATABASE_URL;
const { resolveIngestProject } = await import('../../server/utils/ingest-project');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
});

describe('resolveIngestProject', () => {
  test('creates a missing project with its description', async () => {
    const project = await resolveIngestProject(db, 'all', 'checkout', 'The checkout suite');

    expect(project).toMatchObject({ name: 'checkout', description: 'The checkout suite' });
    expect(await db.select().from(schema.projects)).toHaveLength(1);
  });

  test('shards creating the same new project at once all report into one project', async () => {
    const projects = await Promise.all(
      Array.from({ length: 4 }, () => resolveIngestProject(db, 'all', 'sharded-suite')),
    );

    const rows = await db.select().from(schema.projects);
    expect(rows).toHaveLength(1);
    expect(new Set(projects.map((p) => p.id))).toEqual(new Set([rows[0]!.id]));
  });

  test('returns an existing project the caller may access', async () => {
    const [existing] = await db.insert(schema.projects).values({ name: 'checkout' }).returning();

    const project = await resolveIngestProject(db, new Set([existing!.id]), 'checkout');

    expect(project.id).toBe(existing!.id);
  });

  test('refuses an existing project outside the caller’s scope', async () => {
    const [existing] = await db.insert(schema.projects).values({ name: 'checkout' }).returning();

    await expect(resolveIngestProject(db, new Set([existing!.id + 1]), 'checkout')).rejects.toMatchObject({
      statusCode: 403,
      message: 'No access to this project',
    });
  });

  test('refuses to create a project for a caller without access to every project', async () => {
    await expect(resolveIngestProject(db, new Set([1]), 'new-suite')).rejects.toMatchObject({
      statusCode: 403,
      message: 'Cannot create a new project — no global access',
    });
    expect(await db.select().from(schema.projects)).toHaveLength(0);
  });
});
