import { beforeAll, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { describeProjectRunScope, resolveProjectRunScope } from '../../shared/project-run-scope';

delete process.env.PIWI_DATABASE_URL;
const { listProjects, updateProject } = await import('../../shared/handlers/projects');

describe('resolveProjectRunScope', () => {
  test('anything but an object stands for every run', () => {
    expect(resolveProjectRunScope(null)).toBeNull();
    expect(resolveProjectRunScope('main')).toBeNull();
    expect(resolveProjectRunScope(['main'])).toBeNull();
  });

  test('trims and deduplicates the lists, and keeps full runs only unless turned off', () => {
    expect(resolveProjectRunScope({ environments: [' prod ', 'prod', '', 3], branches: ['main'] })).toEqual({
      environments: ['prod'],
      branches: ['main'],
      allBranches: false,
      fullRunsOnly: true,
    });
    expect(resolveProjectRunScope({ allBranches: true, fullRunsOnly: false })).toEqual({
      environments: [],
      branches: [],
      allBranches: true,
      fullRunsOnly: false,
    });
  });
});

describe('describeProjectRunScope', () => {
  const scope = { environments: [], branches: [], allBranches: false, fullRunsOnly: true };

  test('names the branches, the environments and the run kind', () => {
    expect(describeProjectRunScope(scope, 'main')).toBe('the default branch (main), full runs only');
    expect(describeProjectRunScope({ ...scope, allBranches: true, fullRunsOnly: false })).toBe('any branch');
    expect(describeProjectRunScope({ ...scope, branches: ['main', 'release/2'], environments: ['prod'] })).toBe(
      'main, release/2 in prod, full runs only',
    );
  });
});

describe('listProjects: the latest run follows the status filter', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const start = Date.parse('2026-10-01T12:00:00Z');

  beforeAll(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    await db.insert(schema.projects).values([
      { id: 1, name: 'filtered', defaultBranch: 'main' },
      { id: 2, name: 'unfiltered' },
    ]);
    const run = (id: number, projectId: number, branch: string | null, extra: Record<string, unknown> = {}) => ({
      id,
      projectId,
      status: 'passed',
      branch,
      environment: 'prod',
      startTime: new Date(start + id * 60_000),
      metadata: {},
      ...extra,
    });
    await db
      .insert(schema.testRuns)
      .values([
        run(1, 1, 'main'),
        run(2, 1, 'main', { environment: 'staging', status: 'failed' }),
        run(3, 1, 'feature/x', { status: 'failed' }),
        run(4, 1, 'main', { isFullRun: 0, status: 'failed' }),
        run(5, 2, 'develop'),
        run(6, 2, 'feature/y', { status: 'failed' }),
        run(7, 2, 'feature/y', { origin: 'flake-lab', status: 'failed' }),
      ]);
  });

  async function latestRunIds() {
    const projects = await listProjects(db as never);
    return Object.fromEntries(projects.map((p: any) => [p.name, p.latestRun?.id ?? null]));
  }

  test('with no filter, the latest run of any branch and environment, lab runs left out', async () => {
    expect(await latestRunIds()).toEqual({ filtered: 4, unfiltered: 6 });
  });

  test('a stored filter picks the latest run in it, and the last run time stays any run', async () => {
    await updateProject(db as never, 1, {
      statusFilter: { environments: ['prod'], branches: [], allBranches: false, fullRunsOnly: true },
    });
    expect(await latestRunIds()).toEqual({ filtered: 1, unfiltered: 6 });

    const filtered = (await listProjects(db as never)).find((p: any) => p.name === 'filtered');
    expect(filtered.statusFilter).toEqual({
      environments: ['prod'],
      branches: [],
      allBranches: false,
      fullRunsOnly: true,
    });
    expect(new Date(filtered.lastRunAt).getTime()).toBe(start + 4 * 60_000);
  });

  test('a filter no run matches leaves the project with no latest run; null clears it', async () => {
    await updateProject(db as never, 1, { statusFilter: { branches: ['release/9'] } });
    expect(await latestRunIds()).toEqual({ filtered: null, unfiltered: 6 });

    await updateProject(db as never, 1, { statusFilter: null });
    expect(await latestRunIds()).toEqual({ filtered: 4, unfiltered: 6 });
  });

  test('a filter every run passes is stored as none', async () => {
    await updateProject(db as never, 1, {
      statusFilter: { environments: [], branches: [], allBranches: true, fullRunsOnly: false },
    });
    const filtered = (await listProjects(db as never)).find((p: any) => p.name === 'filtered');
    expect(filtered.statusFilter).toBeNull();
  });

  test('names the default branch a filter reads, resolved from the runs when none is stored', async () => {
    await updateProject(db as never, 2, { statusFilter: { fullRunsOnly: false } });
    const unfiltered = (await listProjects(db as never)).find((p: any) => p.name === 'unfiltered');
    expect(unfiltered.statusDefaultBranch).toBe('feature/y');
    expect(unfiltered.latestRun.id).toBe(6);
    await updateProject(db as never, 2, { statusFilter: null });
  });
});
