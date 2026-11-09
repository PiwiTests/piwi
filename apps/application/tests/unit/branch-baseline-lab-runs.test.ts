import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the module under test loads.
delete process.env.PIWI_DATABASE_URL;
const { selectBaselineRun } = await import('../../server/utils/branch-baseline');
const { runOrigin } = await import('../../shared/run-eligibility');

let db: ReturnType<typeof drizzle<typeof schema>>;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-28T12:00:00Z');

/**
 * A passing real run, then a passing probe run and a passing flake-lab run on
 * the same branch: the baseline for a later run is the real one.
 */
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
  const run = (id: number, hoursAgo: number, metadata: object | null) => ({
    id,
    projectId: 1,
    status: 'passed',
    startTime: new Date(NOW - hoursAgo * HOUR),
    branch: 'main',
    metadata,
    origin: runOrigin(metadata),
  });
  await db
    .insert(schema.testRuns)
    .values([
      run(1, 5, null),
      run(2, 4, { piwiProbe: true }),
      run(3, 3, { piwiFlakeLab: { experimentId: 'exp-1', armId: 'control' } }),
    ]);
});

describe('selectBaselineRun', () => {
  test('never picks a lab run', async () => {
    const selection = await selectBaselineRun(db as never, {
      projectId: 1,
      before: new Date(NOW),
      branch: 'main',
      environment: null,
      fallbackBranch: 'main',
    });
    expect(selection?.run.id).toBe(1);
  });
});
