import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the handler.
delete process.env.PIWI_DATABASE_URL;
const { listProjects } = await import('../../shared/handlers/projects');
const { patchTestRun } = await import('../../shared/handlers/test-runs');

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60 * 1000);

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  const migrationsFolder = fileURLToPath(new URL('../../server/database/migrations', import.meta.url));
  await migrate(db, { migrationsFolder });

  await db.insert(schema.projects).values([
    { id: 1, name: 'Alpha' },
    { id: 2, name: 'Beta' },
  ]);

  // Insert runs so that the NEWEST run (by start_time) has a LOWER id than an
  // older run — exactly how the demo seed inserts runs (newest-first with an
  // incrementing id). MAX(id) would therefore pick the OLDEST run.
  await db.insert(schema.testRuns).values([
    // Project 1: newest run (id 5, failed) is more recent than the old one (id 10, passed).
    { id: 10, projectId: 1, status: 'passed', startTime: at(500), isFullRun: 1 },
    { id: 5, projectId: 1, status: 'failed', startTime: at(1), isFullRun: 1 },
    // Project 2: newest run (id 7, failed) is a partial run; old one (id 12, passed).
    { id: 12, projectId: 2, status: 'passed', startTime: at(400), isFullRun: 1 },
    { id: 7, projectId: 2, status: 'failed', startTime: at(2), isFullRun: 0, streamToken: 'secret-stream-token' },
  ]);
});

describe('listProjects latest run selection', () => {
  test('picks the latest run by start_time, not MAX(id)', async () => {
    const result = await listProjects(db);
    const byName = new Map(result.map((p: any) => [p.name, p]));

    const alpha = byName.get('Alpha');
    expect(alpha.latestRun?.id).toBe(5);
    expect(alpha.latestRun?.status).toBe('failed');
    expect(alpha.totalRuns).toBe(2);

    // Also honored when the newest run is a partial run.
    const beta = byName.get('Beta');
    expect(beta.latestRun?.id).toBe(7);
    expect(beta.latestRun?.status).toBe('failed');
  });
});

describe('run rows handed to readers', () => {
  test('the latest run of a project never carries its stream token', async () => {
    const result = await listProjects(db);
    const beta = result.find((p: any) => p.name === 'Beta');
    expect(beta.latestRun?.id).toBe(7);
    expect(beta.latestRun).not.toHaveProperty('streamToken');
  });

  test('a patched run is returned without its stream token', async () => {
    const res = await patchTestRun(db as never, 7, { label: 'nightly' });
    expect(res.testRun).toMatchObject({ id: 7, label: 'nightly' });
    expect(res.testRun).not.toHaveProperty('streamToken');
  });
});
