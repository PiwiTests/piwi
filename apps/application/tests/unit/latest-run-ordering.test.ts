import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the handlers.
delete process.env.PIWI_DATABASE_URL;
const { getProjectLatestRun, getTestRun } = await import('../../shared/handlers/test-runs');

const now = Date.now();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60 * 1000);

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  const migrationsFolder = fileURLToPath(new URL('../../server/database/migrations', import.meta.url));
  await migrate(db, { migrationsFolder });

  await db.insert(schema.projects).values([{ id: 1, name: 'Alpha' }]);

  // Insert runs the way the demo seed does: newest-first with an incrementing
  // id, so the NEWEST run (by start_time) has the SMALLEST id and the OLDEST run
  // has the LARGEST id. Ordering by MAX(id) would therefore pick the OLDEST run.
  await db.insert(schema.testRuns).values([
    { id: 5, projectId: 1, status: 'failed', startTime: at(1), isFullRun: 1 }, // newest
    { id: 8, projectId: 1, status: 'passed', startTime: at(300), isFullRun: 1 },
    { id: 12, projectId: 1, status: 'passed', startTime: at(900), isFullRun: 1 }, // oldest
  ]);
});

describe('latest-run selection is chronological, not MAX(id)', () => {
  test('getProjectLatestRun returns the newest run by start_time', async () => {
    const latest = await getProjectLatestRun(db, 1);
    expect(latest).toEqual({ id: 5, status: 'failed' });
  });

  test('getTestRun exposes the chronologically newest run as project.latestRunId', async () => {
    // Open the OLDEST run (largest id): its "Newer run" pill must still point at
    // the newest run (id 5), never at itself or at MAX(id).
    const run: any = await getTestRun(db, 12);
    expect(run?.project?.latestRunId).toBe(5);
    expect(run?.project?.latestRunStatus).toBe('failed');
  });
});

describe('a run with more executions than SQLite binds parameters', () => {
  test('opens, with its suites and the links of its executions', async () => {
    const executions = 33_000;
    await db.insert(schema.testRuns).values({ id: 20, projectId: 1, status: 'passed', startTime: at(2) });
    await db.run(sql`
      with recursive n(i) as (select 1 union all select i + 1 from n where i < ${executions})
      insert into test_cases (project_id, file_path, title, created_at, updated_at)
      select 1, 'specs/' || (i % 500) || '.spec.ts', 'test ' || i, 0, 0 from n`);
    await db.run(sql`
      insert into test_runs_cases (test_run_id, test_case_id, status, retries, created_at)
      select 20, id, 'passed', 0, 0 from test_cases where project_id = 1`);
    await db
      .insert(schema.testSuites)
      .values({ projectId: 1, filePath: 'specs/7.spec.ts', suitePath: 'Cart', mode: 'serial' });
    const [execution] = await db.select({ id: schema.testRunsCases.id }).from(schema.testRunsCases).limit(1);
    await db.insert(schema.entityLinks).values({ testRunsCaseId: execution!.id, url: 'https://tracker.example/T-1' });

    const run: any = await getTestRun(db, 20);
    expect(run.testCases).toHaveLength(executions);
    expect(run.suites).toEqual([expect.objectContaining({ filePath: 'specs/7.spec.ts', mode: 'serial' })]);
    expect(run.testCases.find((tc: any) => tc.executionId === execution!.id).links).toHaveLength(1);
  });
});
