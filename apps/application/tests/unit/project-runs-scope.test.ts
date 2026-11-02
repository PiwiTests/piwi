import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { getProject } = await import('../../shared/handlers/projects');

const MINUTE = 60_000;
const NOW = Date.now();
const DEFAULT_SCOPE = { environments: [], branches: [], allBranches: false, fullRunsOnly: true };

let db: ReturnType<typeof drizzle<typeof schema>>;

/** Three runs on `main`, then 250 newer runs of pull requests: more than the run list holds. */
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
  const runs: Array<typeof schema.testRuns.$inferInsert> = [];
  for (let i = 0; i < 3; i++) {
    runs.push({
      projectId: 1,
      status: 'passed',
      branch: 'main',
      environment: 'ci',
      startTime: new Date(NOW - (900 - i) * MINUTE),
    });
  }
  for (let i = 0; i < 250; i++) {
    runs.push({
      projectId: 1,
      status: 'passed',
      branch: `feature/${i}`,
      environment: i % 2 ? 'ci' : 'preview',
      isFullRun: i % 5 ? 1 : 0,
      startTime: new Date(NOW - (500 - i) * MINUTE),
    });
  }
  await db.insert(schema.testRuns).values(runs);
});

describe('the project page reads its runs within its run scope', () => {
  test("the default branch's runs, however many runs of other branches came after them", async () => {
    const project = await getProject(db as never, 1, { scope: DEFAULT_SCOPE });
    expect(project.testRuns).toHaveLength(3);
    expect(project.testRuns.every((run: { branch: string | null }) => run.branch === 'main')).toBe(true);
  });

  test('the newest runs of any scope come beside them, for the filters to offer and to count what they hide', async () => {
    const project = await getProject(db as never, 1, { scope: DEFAULT_SCOPE });
    expect(project.unscopedRuns).toHaveLength(200);
    expect(project.unscopedRuns![0]).toMatchObject({ branch: 'feature/249', environment: 'ci', isFullRun: true });
    expect(new Set(project.unscopedRuns!.map((run) => run.environment))).toEqual(new Set(['ci', 'preview']));
  });

  test('another scope reads its own newest runs', async () => {
    const preview = await getProject(db as never, 1, {
      scope: { ...DEFAULT_SCOPE, environments: ['preview'], allBranches: true, fullRunsOnly: false },
    });
    expect(preview.testRuns).toHaveLength(125);
    expect(preview.testRuns.every((run: { environment: string | null }) => run.environment === 'preview')).toBe(true);
  });

  test('a request without a scope reads the newest runs of any scope, as before', async () => {
    const project = await getProject(db as never, 1);
    expect(project.testRuns).toHaveLength(200);
    expect(project.unscopedRuns).toBeUndefined();
  });
});
