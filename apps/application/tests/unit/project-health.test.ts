import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { projectHealth, ranToItsEnd } from '../../shared/project-health';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { getProjectsOverview } = await import('../../shared/handlers/projects');

const MINUTE = 60_000;
const NOW = Date.now();

const run = (status: string, flakyTests = 0) => ({ status, flakyTests });

describe('projectHealth', () => {
  test('reads the latest run that ran to its end: one in progress, interrupted or cancelled is passed over', () => {
    for (const status of ['initializing', 'running', 'finalizing', 'interrupted', 'cancelled']) {
      const runs = [run('passed'), run('passed'), run(status)];
      expect(projectHealth(runs)).toEqual({ latest: runs[1], tendency: 'passing' });
      expect(ranToItsEnd(status)).toBe(false);
    }
    for (const status of ['passed', 'failed', 'timedout']) expect(ranToItsEnd(status)).toBe(true);
  });

  test('a project whose only runs are in progress or interrupted has no latest run', () => {
    expect(projectHealth([run('running')])).toEqual({ latest: null, tendency: 'unknown' });
    expect(projectHealth([run('interrupted'), run('cancelled')])).toEqual({ latest: null, tendency: 'unknown' });
  });

  test('an interrupted run among passing ones does not make the project flaky', () => {
    expect(projectHealth([run('passed'), run('interrupted'), run('passed')]).tendency).toBe('passing');
  });

  test('fails on a failed latest run, and reads the last five otherwise', () => {
    expect(projectHealth([run('passed'), run('timedout')]).tendency).toBe('failing');
    expect(projectHealth([run('failed'), run('passed')]).tendency).toBe('flaky');
    expect(projectHealth([run('passed'), run('passed', 2)]).tendency).toBe('flaky');
    expect(projectHealth([run('failed'), ...Array.from({ length: 5 }, () => run('passed'))]).tendency).toBe('passing');
  });
});

describe('getProjectsOverview', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(db);
    await db.insert(schema.projects).values([
      { id: 1, name: 'shop' },
      { id: 2, name: 'admin' },
    ]);
    // Two passing full runs, then one CI is running now: 3 of its 40 tests reported so far.
    // In the second project, the newest run was interrupted after 5 of its 40 tests.
    await db.insert(schema.testRuns).values([
      {
        id: 1,
        projectId: 1,
        status: 'passed',
        startTime: new Date(NOW - 30 * MINUTE),
        isFullRun: 1,
        totalTests: 40,
        passedTests: 40,
      },
      {
        id: 2,
        projectId: 1,
        status: 'passed',
        startTime: new Date(NOW - 20 * MINUTE),
        isFullRun: 1,
        totalTests: 40,
        passedTests: 40,
      },
      {
        id: 3,
        projectId: 1,
        status: 'running',
        startTime: new Date(NOW - MINUTE),
        isFullRun: 1,
        totalTests: 40,
        passedTests: 3,
      },
      ...[4, 5].map((id) => ({
        id,
        projectId: 2,
        status: 'passed',
        startTime: new Date(NOW - (30 - id) * MINUTE),
        isFullRun: 1,
        totalTests: 40,
        passedTests: 40,
      })),
      {
        id: 6,
        projectId: 2,
        status: 'interrupted',
        startTime: new Date(NOW - 2 * MINUTE),
        isFullRun: 1,
        totalTests: 40,
        passedTests: 5,
      },
    ]);
  });

  const overviewOf = async (projectId: number) =>
    (await getProjectsOverview(db as never)).find((project) => project.id === projectId);

  test('a run in progress is not the latest full run, nor part of the tendency', async () => {
    const project = await overviewOf(1);
    expect(project!.latestFullRun).toMatchObject({ id: 2, passedTests: 40, totalTests: 40 });
    expect(project!.tendency).toBe('passing');
    // The trend bars still show it, in its running color.
    expect(project!.recentRuns.map((r: { id: number }) => r.id)).toEqual([1, 2, 3]);
  });

  test('an interrupted run is not the latest full run, nor part of the tendency', async () => {
    const project = await overviewOf(2);
    expect(project!.latestFullRun).toMatchObject({ id: 5, status: 'passed', passedTests: 40 });
    expect(project!.tendency).toBe('passing');
    // The trend bars still show it, with its Interrupted status.
    expect(project!.recentRuns.map((r: { id: number; status: string }) => [r.id, r.status])).toEqual([
      [4, 'passed'],
      [5, 'passed'],
      [6, 'interrupted'],
    ]);
  });
});
