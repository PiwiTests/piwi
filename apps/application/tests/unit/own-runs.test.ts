import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { isOwnRun, ownRunSql, SOLE_USER, type RunViewer } from '#shared/own-runs';
import { joinOwnRuns, listsRun, ownRunMark } from '../../app/utils/own-run-mark';
import type { ProjectRunScope } from '#shared/project-run-scope';
import { migrateToLatest } from './temp-db';

/**
 * A person's own runs are listed whatever a runs list's partial-run and branch filters say: a run outside CI they
 * reported (`reporter_id`) or requested (`requester_id`), or, with authentication off, any run outside CI. A list
 * answers `mine: true` for them and never names a run's reporter.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown, authEnabled: false, userId: 0 }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db, getDialect: () => 'sqlite' }));
vi.mock('../../server/utils/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/utils/auth')>()),
  requireAuth: async () => ({ id: state.userId, role: 'administrator' }),
  isAuthEnabled: () => state.authEnabled,
}));
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects: vi.fn(async () => {}) }));

interface RouteEvent {
  params?: Record<string, string>;
  body: Record<string, unknown>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('durationStats', durationStats);

type Route = (event: RouteEvent) => Promise<Record<string, any>>;
const submit = (await import('../../server/api/test-runs/submit.post')).default as unknown as Route;
const start = (await import('../../server/api/test-runs/start.post')).default as unknown as Route;
const setup = (await import('../../server/api/test-runs/setup.post')).default as unknown as Route;
const { runReporterId, runViewerOf } = await import('../../server/utils/run-viewer');
const { getProject, listKeptRuns } = await import('#shared/handlers/projects');
const { getRecentTestRuns, getTestRun } = await import('#shared/handlers/test-runs');
const { getTestRunCase } = await import('#shared/handlers/test-cases');
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;

const PROJECT = 'own-runs';
const AVERY = 7;
const JORDAN = 8;
const avery: RunViewer = { authEnabled: true, userId: AVERY };
const event = {} as never;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  state.authEnabled = false;
  state.userId = 0;
  await db.insert(schema.users).values([
    { id: AVERY, username: 'avery', password: '', role: 'administrator' },
    { id: JORDAN, username: 'jordan', password: '', role: 'administrator' },
  ]);
  const [project] = await db.insert(schema.projects).values({ name: PROJECT, defaultBranch: 'main' }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

/** A stored run: full, on main, from a developer's machine, reported by nobody, unless `run` says otherwise. */
async function storeRun(run: Partial<typeof schema.testRuns.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(schema.testRuns)
    .values({
      projectId,
      status: 'passed',
      startTime: new Date(Date.UTC(2026, 10, 1, 10, run.id ?? 0)),
      totalTests: 1,
      passedTests: 1,
      branch: 'main',
      origin: 'local',
      isFullRun: 1,
      ...run,
    })
    .returning({ id: schema.testRuns.id });
  return row!.id;
}

/** The ids of the runs `where` keeps, in id order. */
async function ownRunIds(viewer: RunViewer | null): Promise<number[]> {
  const rows = await db.select({ id: schema.testRuns.id }).from(schema.testRuns).where(ownRunSql(viewer));
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

describe('a run is its viewer’s own', () => {
  const run = { origin: 'local', reporterId: null, requesterId: null };

  test('with authentication off, for every run outside CI, lab runs and imports', () => {
    for (const origin of ['local', 'desktop', 'editor', 'preflight', 'bug', 'bisect', 'reproduce', 'request'])
      expect(isOwnRun({ ...run, origin }, SOLE_USER)).toBe(true);
    for (const origin of ['ci', 'ci-rerun', 'probe', 'flake-lab', 'import', null])
      expect(isOwnRun({ ...run, origin }, SOLE_USER)).toBe(false);
  });

  test('with authentication on, for a run outside CI the viewer reported or requested', () => {
    expect(isOwnRun({ ...run, reporterId: AVERY }, avery)).toBe(true);
    expect(isOwnRun({ ...run, origin: 'request', requesterId: AVERY }, avery)).toBe(true);
    expect(isOwnRun({ ...run, reporterId: JORDAN }, avery)).toBe(false);
    expect(isOwnRun({ ...run, origin: 'request', requesterId: JORDAN }, avery)).toBe(false);
    expect(isOwnRun(run, avery)).toBe(false);
  });

  test('never for a CI run, whoever’s key reported it', () => {
    expect(isOwnRun({ ...run, origin: 'ci', reporterId: AVERY }, avery)).toBe(false);
    expect(isOwnRun({ ...run, origin: 'ci-rerun', reporterId: AVERY }, avery)).toBe(false);
  });

  test('never with no viewer, nor a signed-in viewer without an id', () => {
    expect(isOwnRun({ ...run, reporterId: AVERY }, null)).toBe(false);
    expect(isOwnRun({ ...run, reporterId: AVERY }, { authEnabled: true, userId: null })).toBe(false);
  });

  test('in SQL as in memory', async () => {
    const ids = {
      mine: await storeRun({ reporterId: AVERY }),
      requested: await storeRun({ origin: 'request', requesterId: AVERY }),
      theirs: await storeRun({ reporterId: JORDAN }),
      ci: await storeRun({ origin: 'ci', reporterId: AVERY }),
      lab: await storeRun({ origin: 'probe', reporterId: AVERY }),
      imported: await storeRun({ origin: 'import' }),
      nobodys: await storeRun(),
    };
    expect(await ownRunIds(avery)).toEqual([ids.mine, ids.requested]);
    expect(await ownRunIds(SOLE_USER)).toEqual([ids.mine, ids.requested, ids.theirs, ids.nobodys]);
    expect(await ownRunIds(null)).toEqual([]);
    expect(await ownRunIds({ authEnabled: true, userId: null })).toEqual([]);
    const rows = await db.select().from(schema.testRuns);
    for (const viewer of [avery, SOLE_USER]) {
      const inMemory = rows.filter((row) => isOwnRun(row, viewer)).map((row) => row.id);
      expect(await ownRunIds(viewer)).toEqual(inMemory.sort((a, b) => a - b));
    }
  });
});

describe('a run’s reporter', () => {
  test('is the person whose credentials started it, with authentication on', async () => {
    state.authEnabled = true;
    state.userId = AVERY;
    const streamed = await start({ body: { projectName: PROJECT, instanceId: 'avery-1' } });
    const registered = await setup({ body: { projectName: PROJECT, instanceId: 'avery-2' } });
    const submitted = await submit({
      body: { projectName: PROJECT, status: 'passed', startTime: '2026-11-01T10:00:00.000Z', testCases: [] },
    });
    const rows = await db.select().from(schema.testRuns);
    expect(rows.map((row) => [row.id, row.reporterId])).toEqual([
      [streamed.runId, AVERY],
      [registered.runId, AVERY],
      [submitted.runId, AVERY],
    ]);
  });

  test('is nobody with authentication off, and for a run started by a request token', async () => {
    await start({ body: { projectName: PROJECT, instanceId: 'local-1' } });
    expect((await db.select().from(schema.testRuns)).map((row) => row.reporterId)).toEqual([null]);
    expect(runReporterId(event, { id: 0 })).toBeNull();
    state.authEnabled = true;
    expect(runReporterId(event, null)).toBeNull();
    expect(runReporterId(event, { id: AVERY })).toBe(AVERY);
    expect(runViewerOf(event, { id: AVERY })).toEqual(avery);
    state.authEnabled = false;
    expect(runViewerOf(event, { id: 0 })).toEqual(SOLE_USER);
  });
});

describe('the runs lists', () => {
  const scope: ProjectRunScope = { environments: [], branches: [], allBranches: false, fullRunsOnly: true };

  test('list the viewer’s own runs the partial-run and branch filters leave out, in the scope’s environments', async () => {
    const full = await storeRun({ id: 1, reporterId: AVERY });
    const partial = await storeRun({ id: 2, reporterId: AVERY, isFullRun: 0 });
    const branch = await storeRun({ id: 3, reporterId: AVERY, branch: 'feature/x' });
    await storeRun({ id: 4, reporterId: JORDAN, isFullRun: 0 });
    await storeRun({ id: 5, origin: 'ci', reporterId: AVERY, isFullRun: 0 });
    await storeRun({ id: 6, reporterId: AVERY, isFullRun: 0, environment: 'staging' });

    const project = await getProject(db as never, projectId, { scope, viewer: avery });
    expect(project.testRuns.map((run: any) => [run.id, run.mine])).toEqual([[full, true]]);
    expect((project.ownRuns ?? []).map((run: any) => [run.id, run.mine])).toEqual([
      [6, true],
      [branch, true],
      [partial, true],
    ]);
    expect(project.unscopedRuns?.filter((run) => run.mine).map((run) => run.id)).toEqual([6, branch, partial, full]);

    const inProduction = { ...scope, environments: ['production'] };
    expect(
      (await getProject(db as never, projectId, { scope: inProduction, viewer: avery })).ownRuns?.map((run) => run.id),
    ).toEqual([]);
    const inStaging = { ...scope, environments: ['staging'] };
    expect(
      (await getProject(db as never, projectId, { scope: inStaging, viewer: avery })).ownRuns?.map((run) => run.id),
    ).toEqual([6]);
    // A scope that reads every run leaves none out.
    const everything = { environments: [], branches: [], allBranches: true, fullRunsOnly: false };
    expect((await getProject(db as never, projectId, { scope: everything, viewer: avery })).ownRuns).toBeUndefined();
    // Another person's own runs are theirs alone.
    const jordans = await getProject(db as never, projectId, { scope, viewer: { authEnabled: true, userId: JORDAN } });
    expect(jordans.ownRuns?.map((run) => run.id)).toEqual([4]);
    expect(jordans.testRuns.map((run: any) => run.mine)).toEqual([undefined]);
  });

  /** `db` on the same connection, running `write` once right after the project's scoped run list is read. */
  function writingAfterScopedList(write: string): Db {
    const client = (db as unknown as { $client: ReturnType<typeof createClient> }).$client;
    let written = false;
    const racing = new Proxy(client, {
      get(target, key) {
        if (key !== 'execute') return Reflect.get(target, key);
        return async (stmt: { sql: string }) => {
          const result = await target.execute(stmt as never);
          if (!written && /"test_runs"\."is_full_run" = \?/.test(stmt.sql)) {
            written = true;
            await target.execute(write);
          }
          return result;
        };
      },
    });
    return drizzle(racing, { schema });
  }

  test('list a run once when a write moves it out of the scope between the reads', async () => {
    const run = await storeRun({ id: 1, reporterId: AVERY, branch: null });
    const racing = writingAfterScopedList(`UPDATE test_runs SET branch = 'feature/x' WHERE id = ${run}`);
    const project = await getProject(racing as never, projectId, { scope, viewer: avery });
    const listed = [...project.testRuns, ...(project.ownRuns ?? [])].map((r: any) => r.id);
    expect(listed).toEqual([run]);
  });

  test('list a run when a write moves it into the scope between the reads', async () => {
    const run = await storeRun({ id: 1, reporterId: AVERY, branch: 'feature/x' });
    const racing = writingAfterScopedList(`UPDATE test_runs SET branch = 'main' WHERE id = ${run}`);
    const project = await getProject(racing as never, projectId, { scope, viewer: avery });
    const listed = [...project.testRuns, ...(project.ownRuns ?? [])].map((r: any) => r.id);
    expect(listed).toEqual([run]);
  });

  test('add no own run the scope holds past the scoped list’s window', async () => {
    await storeRun({ id: 1, reporterId: AVERY });
    const newer = await storeRun({ id: 2 });
    const project = await getProject(db as never, projectId, { scope, viewer: avery, runLimit: 1 });
    expect(project.testRuns.map((r: any) => r.id)).toEqual([newer]);
    expect(project.ownRuns?.map((r: any) => r.id)).toEqual([]);
  });

  test('say `mine` of every run outside CI with authentication off', async () => {
    await storeRun({ id: 1 });
    await storeRun({ id: 2, isFullRun: 0 });
    await storeRun({ id: 3, origin: 'ci', isFullRun: 0 });
    const project = await getProject(db as never, projectId, { scope, viewer: SOLE_USER });
    expect(project.ownRuns?.map((run) => run.id)).toEqual([2]);
    const recent = await getRecentTestRuns(db as never, 'all', SOLE_USER);
    expect(recent.map((run) => [run.id, run.mine])).toEqual([
      [3, undefined],
      [2, true],
      [1, true],
    ]);
  });

  test('say `mine` of a kept run and a recent run that is the viewer’s own, and nothing of the others', async () => {
    const mine = await storeRun({ id: 1, reporterId: AVERY, keptAt: new Date() });
    const theirs = await storeRun({ id: 2, reporterId: JORDAN, keptAt: new Date() });
    const kept = await listKeptRuns(db as never, projectId, { viewer: avery });
    expect(kept.items.map((run: any) => [run.id, run.mine])).toEqual([
      [theirs, undefined],
      [mine, true],
    ]);
    const recent = await getRecentTestRuns(db as never, 'all', avery);
    expect(recent.map((run) => [run.id, 'mine' in run])).toEqual([
      [theirs, false],
      [mine, true],
    ]);
  });

  test('never answer a run’s reporter, nor do a run’s page, its case’s page or an MCP tool', async () => {
    const runId = await storeRun({ id: 1, reporterId: AVERY, keptAt: new Date() });
    const [testCase] = await db
      .insert(schema.testCases)
      .values({ projectId, title: 'pays', filePath: 'tests/pays.spec.ts' })
      .returning();
    const [execution] = await db
      .insert(schema.testRunsCases)
      .values({ testRunId: runId, testCaseId: testCase!.id, status: 'passed', duration: 10, finalAttempt: true })
      .returning();
    const ctx = { user: { id: AVERY, role: 'administrator' }, access: { role: 'administrator' }, scope: 'all' };
    const answers = [
      await getProject(db as never, projectId, { scope, viewer: avery }),
      await getProject(db as never, projectId, { viewer: avery }),
      await listKeptRuns(db as never, projectId, { viewer: avery }),
      await getRecentTestRuns(db as never, 'all', avery),
      await getTestRun(db as never, runId),
      await getTestRunCase(db as never, execution!.id),
      ...(await Promise.all(
        ['get_run', 'list_runs', 'get_project'].map((name) =>
          MCP_TOOLS.find((tool) => tool.name === name)
            ?.handler(db as never, { runId, projectId, project: PROJECT }, ctx as never)
            .catch((error: unknown) => ({ error: String(error) })),
        ),
      )),
    ];
    expect(JSON.stringify(answers.slice(-3))).not.toContain('"error"');
    for (const answer of answers) {
      const text = JSON.stringify(answer);
      expect(text).not.toMatch(/reporterId|reporter_id/);
    }
    expect((await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId)))[0]!.reporterId).toBe(AVERY);
  });
});

describe('the runs list’s mark', () => {
  const scope: ProjectRunScope = { environments: ['ci'], branches: [], allBranches: false, fullRunsOnly: true };
  const own = { environment: 'ci', branch: 'main', isFullRun: true, mine: true as const };

  test('says why an own run the filters leave out is listed', () => {
    expect(ownRunMark({ ...own, isFullRun: false }, scope, 'main')).toBe('Yours · partial run');
    expect(ownRunMark({ ...own, branch: 'feature/x' }, scope, 'main')).toBe('Yours · feature/x');
    expect(ownRunMark({ ...own, branch: 'feature/x', isFullRun: false }, scope, 'main')).toBe(
      'Yours · partial run · feature/x',
    );
  });

  test('is none for a run the filters keep, and for a run that is not the viewer’s', () => {
    expect(ownRunMark(own, scope, 'main')).toBeNull();
    expect(ownRunMark({ ...own, mine: undefined, isFullRun: false }, scope, 'main')).toBeNull();
  });

  test('goes with the list: an own run outside the scope’s environments stays hidden', () => {
    expect(listsRun({ ...own, isFullRun: false }, scope, 'main')).toBe(true);
    expect(listsRun({ ...own, isFullRun: false, environment: 'staging' }, scope, 'main')).toBe(false);
    expect(listsRun({ ...own, isFullRun: false, mine: undefined }, scope, 'main')).toBe(false);
  });

  test('lists each run once, newest first, when the own runs repeat a scoped one', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute));
    const scoped = [
      { id: 3, startTime: at(3) },
      { id: 1, startTime: at(1) },
    ];
    const own = [
      { id: 3, startTime: at(3) },
      { id: 2, startTime: at(2) },
    ];
    expect(joinOwnRuns(scoped, own).map((run) => run.id)).toEqual([3, 2, 1]);
  });
});
