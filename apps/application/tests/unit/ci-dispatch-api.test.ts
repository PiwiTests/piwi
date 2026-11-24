/**
 * The dispatch API: one dispatch for every source (`dispatchCi`), what a place
 * is offered (`ciOffered`), the branches an action may run on
 * (`ciActionBranches`), the reads of the dispatch record, and the routes that
 * serve them.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const GITHUB = 'https://github.com/acme/shop';

const scm = vi.hoisted(() => ({
  dispatched: [] as Array<{ target: Record<string, unknown>; args: string; request: Record<string, unknown> }>,
  branches: [] as string[],
  listed: [] as Array<Record<string, unknown> | undefined>,
}));
vi.mock('../../server/utils/scm', () => ({
  detectScmProvider: (url: string | null) => (url?.includes('gitlab') ? 'gitlab' : url ? 'github' : null),
  hasScmCredential: async () => true,
  createScmProvider: async (_url: string, _db: unknown, _projectId: number, options?: Record<string, unknown>) => ({
    provider: 'github',
    dispatchRerun: async (target: Record<string, unknown>, args: string, request: Record<string, unknown>) => {
      scm.dispatched.push({ target, args, request });
      return { url: 'https://github.com/acme/shop/actions', ref: request.ref ?? target.ref };
    },
    listBranches: async () => {
      scm.listed.push(options);
      return scm.branches;
    },
  }),
}));

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);

const { ciActionBranches, ciOffered, dispatchCi } = await import('../../server/utils/ci-rerun');
const { findCiDispatch, listCiDispatches } = await import('#shared/handlers/ci-dispatches');
const { matchRunToCiDispatch } = await import('../../server/utils/ci-dispatches');
const { ciTagsArgs } = await import('#shared/ci-tags');

interface FakeEvent {
  context: Record<string, unknown>;
  params: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  status?: number;
}

vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query ?? {});
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('setResponseStatus', (event: FakeEvent, status: number) => {
  event.status = status;
});
vi.stubGlobal('apiError', apiError);

type Route = (event: FakeEvent) => Promise<unknown>;
const route = async (path: string) =>
  underRoutePermission(state, (await import(`../../server/api/${path}`)).default as unknown as Route);
const postDispatch = await route('projects/[id]/ci-dispatches.post');
const listDispatches = await route('projects/[id]/ci-dispatches.get');
const readDispatch = await route('ci-dispatches/[id].get');
const offeredRoute = await route('projects/[id]/ci-actions/offered.get');
const branchesRoute = await route('projects/[id]/ci-actions/[actionId]/branches.get');

const asRole = (role: ProjectRole, apiKey = false): RouteCaller => ({
  user: { id: 2, role: 'user', name: 'Sam', username: 'sam' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role }]),
  apiKey,
});

/** The status and message a route call threw, or its answer. */
async function call(handler: Route, event: FakeEvent) {
  try {
    const body = await handler(event);
    return { status: event.status ?? 200, body, event };
  } catch (e) {
    const error = e as { statusCode: number; message: string; data?: unknown };
    return { status: error.statusCode, body: { message: error.message, data: error.data }, event };
  }
}

let db: TempDb;
let close: () => Promise<void>;

/** The GitHub action, which takes tests and a whole suite, with a fixed and a choice input. */
const gh = {
  id: 'gh',
  name: 'Smoke',
  target: { type: 'github', workflow: 'e2e.yml', ref: 'main', argsInput: 'args' },
  inputs: [
    { name: 'TARGET_ENV', kind: 'fixed', value: 'staging' },
    { name: 'SUITE', kind: 'choice', options: ['smoke', 'full'], default: 'full' },
  ],
  accepts: ['tests', 'suite'],
};
const actions = [
  gh,
  {
    id: 'gl',
    name: 'GitLab',
    target: { type: 'gitlab', ref: 'main', argsVariable: 'PIWI_RERUN_ARGS' },
    inputs: [],
    accepts: ['tests'],
  },
  {
    id: 'nightly',
    name: 'Nightly',
    target: { type: 'github', workflow: 'nightly.yml', ref: 'main', argsInput: 'args' },
    inputs: [],
    accepts: ['tests', 'suite'],
    environment: 'staging',
  },
  {
    id: 'lab',
    name: 'Flake Lab',
    target: { type: 'github', workflow: 'lab.yml', ref: 'main', argsInput: 'args' },
    inputs: [],
    accepts: ['flakeLab'],
  },
  {
    id: 'job',
    name: 'Jenkins',
    target: { type: 'ci-server', preset: 'jenkins', baseUrl: 'https://jenkins.example.com/', fields: { job: 'e2e' } },
    inputs: [],
    accepts: ['suite'],
  },
  {
    id: 'branch-job',
    name: 'Jenkins branches',
    target: {
      type: 'ci-server',
      preset: 'jenkins',
      baseUrl: 'https://jenkins.example.com/',
      fields: { job: 'e2e/{branch}' },
    },
    inputs: [],
    accepts: ['suite'],
  },
];

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.caller = asRole(ProjectRole.MAINTAINER);
  scm.dispatched.length = 0;
  scm.listed.length = 0;
  scm.branches = ['main', 'release/2.0', 'feature/coupon'];
  await db.insert(schema.users).values([
    { id: 1, username: 'ada', password: '', role: 'member' },
    { id: 2, username: 'sam', password: '', role: 'member' },
  ]);
  await db.insert(schema.projects).values([
    {
      id: 1,
      name: 'shop',
      repositoryUrl: GITHUB,
      ciRerun: { enabled: true, actions, defaults: { rerun: 'gh', suite: 'gh', flakeLab: 'lab' } },
    },
    { id: 2, name: 'other' },
  ]);
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'refunds' },
    { id: 3, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'empties' },
    { id: 9, projectId: 2, filePath: 'tests/other.spec.ts', title: 'other' },
  ]);
  const run = (id: number, projectId: number, branch: string, extra: Record<string, unknown> = {}) => ({
    id,
    projectId,
    status: 'failed',
    branch,
    startTime: new Date(Date.UTC(2026, 8, 1, 10, id)),
    metadata: { scm: { remoteUrl: GITHUB, branch } },
    origin: 'ci',
    ...extra,
  });
  await db
    .insert(schema.testRuns)
    .values([
      run(1, 1, 'feature/coupon'),
      run(2, 1, 'main', { status: 'passed' }),
      run(3, 2, 'main'),
      run(4, 1, 'secret', { origin: 'request', requesterId: 1 }),
    ]);
  await db.insert(schema.failureClusters).values([
    {
      id: 1,
      projectId: 1,
      fingerprint: 'fp',
      signature: 'Error',
      errorType: 'unknown',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
    },
    {
      id: 2,
      projectId: 2,
      fingerprint: 'fp2',
      signature: 'Error',
      errorType: 'unknown',
      firstSeenRunId: 3,
      lastSeenRunId: 3,
    },
  ]);
  await db.insert(schema.testRunsCases).values([
    { id: 11, testRunId: 1, testCaseId: 1, status: 'failed', line: 12, browserName: 'chromium', failureClusterId: 1 },
    { id: 12, testRunId: 1, testCaseId: 2, status: 'failed', line: 30, browserName: 'chromium', failureClusterId: 1 },
    { id: 13, testRunId: 1, testCaseId: 3, status: 'passed', line: 5, browserName: 'chromium' },
    { id: 14, testRunId: 2, testCaseId: 1, status: 'passed', line: 12, browserName: 'chromium' },
    { id: 15, testRunId: 4, testCaseId: 1, status: 'failed', line: 12, browserName: 'chromium' },
    { id: 19, testRunId: 3, testCaseId: 9, status: 'failed', line: 1, browserName: 'chromium', failureClusterId: 2 },
  ]);
  return () => close();
});

type Request = Parameters<typeof dispatchCi>[2];
type Source = Request['source'];

function dispatch(source: Source, request: Partial<Request> = {}, viewerId: number | null = 2) {
  return dispatchCi(
    db as never,
    1,
    { source, action: null, ref: null, inputs: null, ...request },
    { id: 2, name: 'Sam' },
    { origin: 'page', viewerId },
  );
}

const sent = () => scm.dispatched.at(-1)!;

/** The project's actions with one more that takes tagged tests only, the default for them. */
async function withTaggedAction() {
  const tagged = {
    id: 'tagged',
    name: 'Tagged',
    target: { type: 'github', workflow: 'tagged.yml', ref: 'main', argsInput: 'args' },
    inputs: [],
    accepts: ['tags'],
  };
  await db
    .update(schema.projects)
    .set({
      ciRerun: {
        enabled: true,
        actions: [...actions, tagged],
        defaults: { rerun: 'gh', suite: 'gh', flakeLab: 'lab', tags: 'tagged' },
      },
    })
    .where(eq(schema.projects.id, 1));
}

describe('a dispatch from every source', () => {
  test("a cluster's affected tests, on its last run's branch, recorded with the cluster", async () => {
    const outcome = await dispatch({ from: 'cluster', clusterId: 1 });
    expect(outcome).toMatchObject({ ok: true, dispatch: { kind: 'tests', ref: 'feature/coupon', tests: 2 } });
    expect(sent().args).toBe('"/tests/checkout.spec.ts:30" "/tests/checkout.spec.ts:12" --project="chromium"');
    const [row] = await db.select().from(schema.ciDispatches);
    expect(row).toMatchObject({ clusterId: 1, sourceRunId: 1, testCaseId: null, files: ['tests/checkout.spec.ts'] });
  });

  test("an execution's test, or every test of its cluster, on the execution's run", async () => {
    expect(await dispatch({ from: 'execution', executionId: 11, scope: 'test' })).toMatchObject({
      ok: true,
      dispatch: { tests: 1, args: '"/tests/checkout.spec.ts:12" --project="chromium"' },
    });
    expect(await dispatch({ from: 'execution', executionId: 12, scope: 'cluster' })).toMatchObject({
      ok: true,
      dispatch: { tests: 2 },
    });
    expect(await dispatch({ from: 'execution', executionId: 13, scope: 'cluster' })).toEqual({
      ok: false,
      error: 'invalid',
      message: 'This execution belongs to no failure cluster.',
    });
  });

  test("a run's failed tests, and the whole suite on the run's branch", async () => {
    expect(await dispatch({ from: 'run-failed', runId: 1 })).toMatchObject({
      ok: true,
      dispatch: { kind: 'tests', tests: 2, ref: 'feature/coupon' },
    });
    expect(sent().args).toBe('"/tests/checkout.spec.ts:12" "/tests/checkout.spec.ts:30" --project="chromium"');
    expect(await dispatch({ from: 'run-failed', runId: 2 })).toEqual({
      ok: false,
      error: 'invalid',
      message: 'No test failed in this run.',
    });
    expect(await dispatch({ from: 'run-suite', runId: 2 })).toMatchObject({
      ok: true,
      dispatch: { kind: 'suite', args: '', ref: 'main', tests: null },
    });
    expect(sent().args).toBe('');
  });

  test("a test's Flake Lab experiment on the branch of its newest team run, never a private or lab run", async () => {
    await db.insert(schema.testRuns).values({
      id: 5,
      projectId: 1,
      status: 'failed',
      branch: 'my-lab',
      startTime: new Date(Date.UTC(2026, 8, 1, 11)),
      metadata: { scm: { remoteUrl: GITHUB, branch: 'my-lab' } },
      origin: 'flake-lab',
    });
    await db
      .insert(schema.testRunsCases)
      .values({ id: 16, testRunId: 5, testCaseId: 1, status: 'failed', line: 12, browserName: 'chromium' });
    expect(await dispatch({ from: 'flake-lab', testCaseId: 1, flakeLab: 'verify' })).toMatchObject({
      ok: true,
      dispatch: { kind: 'flakeLab', actionId: 'lab', args: 'flake verify 1', ref: 'main' },
    });
    const [lab] = await db.select().from(schema.ciDispatches).where(eq(schema.ciDispatches.kind, 'flakeLab'));
    expect(lab).toMatchObject({ sourceRunId: 2, testCaseId: 1 });
  });

  test("a test's Flake Lab experiment, and the project's whole suite on its default branch", async () => {
    expect(await dispatch({ from: 'flake-lab', testCaseId: 1, flakeLab: 'verify' })).toMatchObject({
      ok: true,
      dispatch: { kind: 'flakeLab', actionId: 'lab', args: 'flake verify 1' },
    });
    // The project names no default branch: its runs' most common one, the latest of a tie (a private run aside).
    expect(await dispatch({ from: 'project' })).toMatchObject({ ok: true, dispatch: { kind: 'suite', ref: 'main' } });
    await db.update(schema.projects).set({ defaultBranch: 'trunk' }).where(eq(schema.projects.id, 1));
    expect(await dispatch({ from: 'project' }, { inputs: { SUITE: 'smoke' } })).toMatchObject({
      ok: true,
      dispatch: { ref: 'trunk', runId: null },
    });
    const [row] = await db.select().from(schema.ciDispatches).where(eq(schema.ciDispatches.ref, 'trunk'));
    expect(row).toMatchObject({ sourceRunId: null, clusterId: null, testCaseId: null, files: null });
  });

  test("the project's tests carrying some tags, as one --grep on its default branch, naming no test or file", async () => {
    await withTaggedAction();
    const outcome = await dispatch({ from: 'tags', tags: ['smoke', 'checkout'], match: 'all' });
    const args = ciTagsArgs(['smoke', 'checkout'], 'all');
    expect(outcome).toMatchObject({
      ok: true,
      dispatch: { kind: 'tags', actionId: 'tagged', args, ref: 'main', tests: null, runId: null },
    });
    expect(sent()).toMatchObject({ args, target: { workflow: 'tagged.yml' }, request: { ref: 'main' } });
    const [row] = await db.select().from(schema.ciDispatches);
    expect(row).toMatchObject({ kind: 'tags', sourceRunId: null, clusterId: null, testCaseId: null, files: null });
    // A branch asked for runs there; an action that takes no tags is refused, and no tag at all sends nothing.
    expect(await dispatch({ from: 'tags', tags: ['smoke'], match: 'any' }, { ref: 'release/2.0' })).toMatchObject({
      ok: true,
      dispatch: { ref: 'release/2.0', args: ciTagsArgs(['smoke'], 'any') },
    });
    expect(await dispatch({ from: 'tags', tags: ['smoke'], match: 'any' }, { action: 'gh' })).toEqual({
      ok: false,
      error: 'unavailable',
      message: 'The CI action "Smoke" does not accept Tagged tests.',
    });
    expect(await dispatch({ from: 'tags', tags: [], match: 'any' })).toEqual({
      ok: false,
      error: 'invalid',
      message: 'A dispatch of tagged tests names at least one tag.',
    });
    expect(scm.dispatched).toHaveLength(2);
  });

  test('finds no id of another project, and no private run of another person', async () => {
    const missing: Array<[Source, string]> = [
      [{ from: 'cluster', clusterId: 2 }, 'Failure cluster not found'],
      [{ from: 'execution', executionId: 19, scope: 'test' }, 'Test run case not found'],
      [{ from: 'run-failed', runId: 3 }, 'Test run not found'],
      [{ from: 'run-suite', runId: 404 }, 'Test run not found'],
      [{ from: 'flake-lab', testCaseId: 9, flakeLab: 'reproduce' }, 'Test case not found'],
      [{ from: 'run-suite', runId: 4 }, 'Test run not found'],
      [{ from: 'execution', executionId: 15, scope: 'test' }, 'Test run case not found'],
    ];
    for (const [source, message] of missing) {
      expect(await dispatch(source), JSON.stringify(source)).toEqual({ ok: false, error: 'not-found', message });
    }
    // Its requester sees their private run.
    expect((await dispatch({ from: 'run-suite', runId: 4 }, {}, 1)).ok).toBe(true);
    expect(scm.dispatched).toHaveLength(1);
  });
});

describe('the branch of a dispatch', () => {
  test('is the one asked, sent to the provider and recorded', async () => {
    expect(await dispatch({ from: 'cluster', clusterId: 1 }, { ref: 'release/2.0' })).toMatchObject({
      ok: true,
      dispatch: { ref: 'release/2.0' },
    });
    expect(sent().request.ref).toBe('release/2.0');
  });

  test('else the run’s, else the target’s for a run that has none', async () => {
    await db.update(schema.testRuns).set({ branch: null, metadata: { scm: { remoteUrl: GITHUB } } });
    expect(await dispatch({ from: 'run-suite', runId: 2 })).toMatchObject({ ok: true, dispatch: { ref: 'main' } });
    expect(sent().request.ref).toBeNull();
  });

  test('is refused by a job that runs its configured branch, and git’s rules apply', async () => {
    expect(await dispatch({ from: 'project' }, { action: 'job', ref: 'main' })).toEqual({
      ok: false,
      error: 'invalid',
      message: 'The CI action "Jenkins" runs its job\'s configured branch, so it takes no branch.',
    });
    expect(await dispatch({ from: 'project' }, { action: 'branch-job', ref: '%2e%2e' })).toMatchObject({
      ok: false,
      error: 'invalid',
      message: expect.stringMatching(/climbs out/),
    });
    expect(await dispatch({ from: 'project' }, { ref: 'a..b' })).toMatchObject({ ok: false, error: 'invalid' });
    expect(scm.dispatched).toHaveLength(0);
  });

  test('is the target’s when the run reported one git refuses', async () => {
    await db
      .update(schema.testRuns)
      .set({ branch: 'HEAD', metadata: { scm: { remoteUrl: GITHUB, branch: 'HEAD' } } })
      .where(eq(schema.testRuns.id, 1));
    expect(await dispatch({ from: 'cluster', clusterId: 1 })).toMatchObject({ ok: true, dispatch: { ref: 'main' } });
    expect(sent().request.ref).toBeNull();
  });
});

describe('the inputs and the action of a dispatch', () => {
  test('send the choice asked, and refuse a fixed input or one the action does not declare', async () => {
    expect((await dispatch({ from: 'cluster', clusterId: 1 }, { inputs: { SUITE: 'smoke' } })).ok).toBe(true);
    expect(sent().request.inputs).toEqual({ TARGET_ENV: 'staging', SUITE: 'smoke' });
    expect(await dispatch({ from: 'cluster', clusterId: 1 }, { inputs: { TARGET_ENV: 'prod' } })).toMatchObject({
      ok: false,
      error: 'invalid',
      message: 'The input "TARGET_ENV" of "Smoke" is fixed: it cannot be set.',
    });
    expect(await dispatch({ from: 'cluster', clusterId: 1 }, { inputs: { REGION: 'eu' } })).toMatchObject({
      ok: false,
      error: 'invalid',
    });
    expect(await dispatch({ from: 'cluster', clusterId: 1 }, { inputs: { SUITE: 'nightly' } })).toMatchObject({
      ok: false,
      error: 'invalid',
    });
  });

  test('pick the action that started the run with its values, then the run’s environment, then the default', async () => {
    expect((await dispatch({ from: 'cluster', clusterId: 1 })).ok).toBe(true);
    expect(sent().target.workflow).toBe('e2e.yml');
    await db.update(schema.testRuns).set({ environment: 'Staging' }).where(eq(schema.testRuns.id, 1));
    expect(await dispatch({ from: 'execution', executionId: 11, scope: 'test' })).toMatchObject({
      ok: true,
      dispatch: { actionId: 'nightly' },
    });
    // Run 1 was started by a dispatch of `gh` on the smoke suite.
    await db.insert(schema.ciDispatches).values({
      id: 'aaaaaaaaaaaaaaaa',
      projectId: 1,
      actionId: 'gh',
      origin: 'page',
      kind: 'suite',
      provider: 'github',
      args: '',
      inputs: { TARGET_ENV: 'staging', SUITE: 'smoke' },
      state: 'ended',
      runId: 1,
      createdAt: new Date('2026-09-01T09:59:00Z'),
    });
    expect(await dispatch({ from: 'run-failed', runId: 1 })).toMatchObject({ ok: true, dispatch: { actionId: 'gh' } });
    expect(sent().request.inputs).toEqual({ TARGET_ENV: 'staging', SUITE: 'smoke' });
  });

  test('answer an unknown action as not found, and one that does not take the source as not available', async () => {
    expect(await dispatch({ from: 'cluster', clusterId: 1 }, { action: 'nope' })).toEqual({
      ok: false,
      error: 'not-found',
      message: 'This project has no CI action "nope".',
    });
    expect(await dispatch({ from: 'cluster', clusterId: 1 }, { action: 'Flake Lab' })).toMatchObject({
      ok: false,
      error: 'unavailable',
      message: 'The CI action "Flake Lab" does not accept Re-runs.',
    });
    expect(await dispatch({ from: 'cluster', clusterId: 1 }, { action: 'gl' })).toMatchObject({
      ok: false,
      error: 'unavailable',
      message: 'The CI action "GitLab" does not serve this run\'s repository.',
    });
  });
});

describe('what a place is offered', () => {
  test('each action that takes its kind, with its target, branch, inputs and readiness, and the default', async () => {
    const result = await ciOffered(db as never, 1, { from: 'cluster', clusterId: 1 }, 2);
    expect(result.ok).toBe(true);
    const offered = result.ok ? result.offered : null;
    expect(offered).toMatchObject({ enabled: true, kind: 'tests', defaultActionId: 'gh', lastDispatch: null });
    expect(offered!.actions.map((a) => [a.id, a.available, a.reason])).toEqual([
      ['gh', true, null],
      ['gl', false, 'The CI action "GitLab" does not serve this run\'s repository.'],
      ['nightly', true, null],
    ]);
    expect(offered!.actions[0]).toEqual({
      id: 'gh',
      name: 'Smoke',
      target: { type: 'github', label: 'GitHub · e2e.yml' },
      environment: null,
      branch: { mode: 'list', default: 'feature/coupon' },
      inputs: gh.inputs,
      available: true,
      reason: null,
    });
    expect(offered!.actions[2]!.environment).toBe('staging');
  });

  test('no repository host’s action for a run of a repository other than the project’s', async () => {
    const fork = 'https://github.com/someone/shop';
    await db
      .update(schema.testRuns)
      .set({ metadata: { scm: { remoteUrl: fork, branch: 'feature/coupon' } } })
      .where(eq(schema.testRuns.id, 1));
    const result = await ciOffered(db as never, 1, { from: 'cluster', clusterId: 1 }, 2);
    const gh = result.ok ? result.offered.actions.find((a) => a.id === 'gh') : null;
    expect(gh).toMatchObject({
      available: false,
      reason: `Its run reported ${fork}, not the project’s repository, the only one its SCM credentials reach.`,
    });
    expect(await dispatch({ from: 'cluster', clusterId: 1 })).toMatchObject({ ok: false, error: 'unavailable' });
    expect(scm.dispatched).toHaveLength(0);
  });

  test('its last dispatch: a cluster’s last re-run, a test’s last Flake Lab run, none for a run', async () => {
    const rerun = await dispatch({ from: 'cluster', clusterId: 1 });
    const lab = await dispatch({ from: 'flake-lab', testCaseId: 1, flakeLab: 'reproduce' });
    const lastOf = async (source: Source) => {
      const result = await ciOffered(db as never, 1, source, 2);
      return result.ok ? result.offered.lastDispatch?.id : 'error';
    };
    expect(await lastOf({ from: 'cluster', clusterId: 1 })).toBe(rerun.ok && rerun.dispatch.id);
    expect(await lastOf({ from: 'execution', executionId: 11, scope: 'test' })).toBe(rerun.ok && rerun.dispatch.id);
    expect(await lastOf({ from: 'flake-lab', testCaseId: 1, flakeLab: 'verify' })).toBe(lab.ok && lab.dispatch.id);
    expect(await lastOf({ from: 'run-failed', runId: 1 })).toBeUndefined();
    expect(await lastOf({ from: 'project' })).toBeUndefined();
  });

  test('the suite’s actions, a fixed job with no branch default, a typed one with the project’s', async () => {
    const result = await ciOffered(db as never, 1, { from: 'project' }, 2);
    const offered = result.ok ? result.offered : null;
    expect(offered!.actions.map((a) => [a.id, a.branch])).toEqual([
      ['gh', { mode: 'list', default: 'main' }],
      ['nightly', { mode: 'list', default: 'main' }],
      ['job', { mode: 'fixed', default: null }],
      ['branch-job', { mode: 'typed', default: 'main' }],
    ]);
    expect(offered!.actions.every((a) => a.available)).toBe(true);
  });

  test('tagged tests: the actions that take them, before any tag is picked, on the project’s branch', async () => {
    await withTaggedAction();
    const result = await ciOffered(db as never, 1, { from: 'tags', tags: [], match: 'any' }, 2);
    const offered = result.ok ? result.offered : null;
    expect(offered).toMatchObject({ enabled: true, kind: 'tags', defaultActionId: 'tagged', lastDispatch: null });
    expect(offered!.actions.map((a) => [a.id, a.available, a.branch])).toEqual([
      ['tagged', true, { mode: 'list', default: 'main' }],
    ]);
  });

  test('with CI actions off, every action unavailable, and with a source of another project, not found', async () => {
    await db.update(schema.projects).set({ ciRerun: { enabled: false, actions, defaults: {} } });
    const off = await ciOffered(db as never, 1, { from: 'cluster', clusterId: 1 }, 2);
    expect(off.ok && off.offered.enabled).toBe(false);
    expect(off.ok && off.offered.actions.map((a) => a.reason)).toEqual(
      Array(3).fill('CI re-run is off for this project.'),
    );
    expect(await ciOffered(db as never, 1, { from: 'cluster', clusterId: 2 }, 2)).toEqual({
      ok: false,
      error: 'not-found',
      message: 'Failure cluster not found',
    });
  });
});

describe('the branches an action may run on', () => {
  const actor = { userId: 2, apiKeyId: null };

  test('the run branches, most recent first, then the repository’s through the action’s credential', async () => {
    expect(await ciActionBranches(db as never, 1, 'gh', null, actor)).toEqual([
      { name: 'main', source: 'runs' },
      { name: 'feature/coupon', source: 'runs' },
      { name: 'release/2.0', source: 'repository' },
    ]);
    expect(scm.listed).toEqual([{ actor, credentialId: null }]);
    expect(await ciActionBranches(db as never, 1, 'gh', 'REL', actor)).toEqual([
      { name: 'release/2.0', source: 'repository' },
    ]);
  });

  test('only the run branches for a CI server action, or a repository on another host, and null for none', async () => {
    expect(await ciActionBranches(db as never, 1, 'branch-job', null, actor)).toEqual([
      { name: 'main', source: 'runs' },
      { name: 'feature/coupon', source: 'runs' },
    ]);
    expect(await ciActionBranches(db as never, 1, 'gl', null, actor)).toHaveLength(2);
    expect(scm.listed).toHaveLength(0);
    expect(await ciActionBranches(db as never, 1, 'missing', null, actor)).toBeNull();
  });

  test('leave out a run branch git refuses, and read no repository while CI actions are off', async () => {
    await db.insert(schema.testRuns).values(
      ['HEAD', 'feature x'].map((branch, i) => ({
        id: 10 + i,
        projectId: 1,
        status: 'failed',
        branch,
        startTime: new Date(Date.UTC(2026, 8, 2, 10, i)),
        origin: 'ci',
      })),
    );
    expect((await ciActionBranches(db as never, 1, 'branch-job', null, actor))?.map((b) => b.name)).toEqual([
      'main',
      'feature/coupon',
    ]);
    await db
      .update(schema.projects)
      .set({ ciRerun: { enabled: false, actions, defaults: { rerun: 'gh' } } })
      .where(eq(schema.projects.id, 1));
    expect(await ciActionBranches(db as never, 1, 'gh', null, actor)).toEqual([
      { name: 'main', source: 'runs' },
      { name: 'feature/coupon', source: 'runs' },
    ]);
    expect(scm.listed).toHaveLength(0);
  });
});

describe('the dispatch record', () => {
  test('of tagged tests answers the run that carries its id, which keeps the origin ci, and no run that carries none', async () => {
    await withTaggedAction();
    const outcome = await dispatch({ from: 'tags', tags: ['smoke'], match: 'any' });
    const { id, at } = outcome.ok ? outcome.dispatch : { id: '', at: 0 };
    const tagRun = async (runId: number, metadata: Record<string, unknown>) => {
      await db.insert(schema.testRuns).values({
        id: runId,
        projectId: 1,
        status: 'passed',
        branch: 'main',
        isFullRun: 0,
        startTime: new Date(at + 60_000),
        metadata: { scm: { remoteUrl: GITHUB, branch: 'main' }, ...metadata },
        origin: 'ci',
      });
      await db.insert(schema.testRunsCases).values({ testRunId: runId, testCaseId: 3, status: 'passed' });
    };
    await tagRun(7, {});
    expect(await matchRunToCiDispatch(db as never, 7, 'finish')).toBeNull();
    await tagRun(8, { piwiOrigin: { kind: 'ci', ref: id } });
    expect(await matchRunToCiDispatch(db as never, 8, 'start')).toBe(id);
    const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, 8));
    expect((run!.metadata as { piwiOrigin: unknown }).piwiOrigin).toEqual({ kind: 'ci', ref: id });
    expect(await findCiDispatch(db as never, id)).toMatchObject({ dispatch: { state: 'running', runId: 8 } });
  });

  test('is listed newest first, open ones alone, by cluster or test', async () => {
    const rerun = await dispatch({ from: 'cluster', clusterId: 1 });
    const lab = await dispatch({ from: 'flake-lab', testCaseId: 1, flakeLab: 'reproduce' });
    const ids = (items: Array<{ id: string }>) => items.map((d) => d.id);
    const rerunId = rerun.ok ? rerun.dispatch.id : '';
    const labId = lab.ok ? lab.dispatch.id : '';
    expect(ids(await listCiDispatches(db as never, 1, { state: 'all', limit: 20 }))).toEqual([labId, rerunId]);
    expect(ids(await listCiDispatches(db as never, 1, { state: 'all', limit: 1 }))).toEqual([labId]);
    expect(ids(await listCiDispatches(db as never, 1, { state: 'all', clusterId: 1, limit: 20 }))).toEqual([rerunId]);
    expect(ids(await listCiDispatches(db as never, 1, { state: 'all', testCaseId: 1, limit: 20 }))).toEqual([labId]);
    expect(await listCiDispatches(db as never, 2, { state: 'all', limit: 20 })).toEqual([]);
    await db.update(schema.ciDispatches).set({ state: 'ended' }).where(eq(schema.ciDispatches.id, labId));
    expect(ids(await listCiDispatches(db as never, 1, { state: 'open', limit: 20 }))).toEqual([rerunId]);
    // Past the matching window, a dispatch no run answered is not open.
    const later = Date.now() + 7 * 60 * 60 * 1000;
    expect(await listCiDispatches(db as never, 1, { state: 'open', limit: 20 }, later)).toEqual([]);
    expect(await findCiDispatch(db as never, rerunId)).toMatchObject({ projectId: 1, dispatch: { id: rerunId } });
    expect(await findCiDispatch(db as never, 'ffffffffffffffff')).toBeNull();
  });
});

describe('the routes', () => {
  const project = (id = 1) => ({ id: String(id) });

  test('POST answers 201 with the dispatch, from a page or through an API key', async () => {
    const page = await call(postDispatch, { context: {}, params: project(), body: { source: { clusterId: 1 } } });
    expect(page).toMatchObject({ status: 201, body: { kind: 'tests', origin: 'page', byName: 'Sam' } });
    state.caller = asRole(ProjectRole.MAINTAINER, true);
    const key = await call(postDispatch, {
      context: { apiKeyId: 5 },
      params: project(),
      body: { source: { runId: 2 }, kind: 'suite', inputs: { SUITE: 'smoke' } },
    });
    expect(key).toMatchObject({ status: 201, body: { kind: 'suite', origin: 'api' } });
  });

  test('POST answers 400, 404 and 409 as the dispatch does', async () => {
    const post = (body: unknown) => call(postDispatch, { context: {}, params: project(), body });
    expect(await post({ source: { runId: 2 }, kind: 'tests' })).toMatchObject({
      status: 400,
      body: { message: 'This source starts a suite dispatch, not tests.' },
    });
    expect(await post({ source: { clusterId: 2 } })).toMatchObject({ status: 404 });
    expect(await post({ source: { clusterId: 1 }, action: 'nope' })).toMatchObject({ status: 404 });
    const first = await post({ source: { clusterId: 1 } });
    const again = await post({ source: { clusterId: 1 } });
    expect(again).toMatchObject({
      status: 409,
      body: { data: { dispatch: { id: (first.body as { id: string }).id } } },
    });
  });

  test('POST and the offered actions need run:control on the project', async () => {
    state.caller = asRole(ProjectRole.VIEWER);
    expect(await call(postDispatch, { context: {}, params: project(), body: { source: {} } })).toMatchObject({
      status: 403,
    });
    expect(await call(offeredRoute, { context: {}, params: project(), query: {} })).toMatchObject({ status: 403 });
    expect(await call(branchesRoute, { context: {}, params: { id: '1', actionId: 'gh' } })).toMatchObject({
      status: 403,
    });
  });

  test('the offered actions read the source from the query', async () => {
    const offered = await call(offeredRoute, {
      context: {},
      params: project(),
      query: { executionId: '11', scope: 'test' },
    });
    expect(offered).toMatchObject({ status: 200, body: { kind: 'tests', defaultActionId: 'gh' } });
    expect(await call(offeredRoute, { context: {}, params: project(), query: { executionId: '11' } })).toMatchObject({
      status: 400,
    });
    expect(await call(offeredRoute, { context: {}, params: project(), query: { runId: '3' } })).toMatchObject({
      status: 404,
    });
    expect(await call(branchesRoute, { context: {}, params: { id: '1', actionId: 'nope' } })).toMatchObject({
      status: 404,
    });
  });

  test('tagged tests: the offered actions with an empty tags key, and a dispatch of the tags in the body', async () => {
    await withTaggedAction();
    expect(await call(offeredRoute, { context: {}, params: project(), query: { tags: '' } })).toMatchObject({
      status: 200,
      body: { kind: 'tags', defaultActionId: 'tagged' },
    });
    const post = (source: unknown) => call(postDispatch, { context: {}, params: project(), body: { source } });
    expect(await post({ tags: ['@smoke', 'checkout'], match: 'all' })).toMatchObject({
      status: 201,
      body: { kind: 'tags', args: ciTagsArgs(['smoke', 'checkout'], 'all') },
    });
    expect(await post({ tags: [] })).toMatchObject({
      status: 400,
      body: { message: 'A dispatch of tagged tests names at least one tag.' },
    });
    expect(await post({ tags: ['$(id)'] })).toMatchObject({ status: 400, body: { message: /cannot be sent to CI/ } });
  });

  test('a Viewer reads a dispatch and the list; a caller who cannot read the project gets 404', async () => {
    const created = await dispatch({ from: 'cluster', clusterId: 1 });
    const id = created.ok ? created.dispatch.id : '';
    state.caller = asRole(ProjectRole.VIEWER);
    expect(await call(readDispatch, { context: {}, params: { id } })).toMatchObject({ status: 200, body: { id } });
    expect(
      await call(listDispatches, { context: {}, params: project(), query: { state: 'open', clusterId: '1' } }),
    ).toMatchObject({ status: 200, body: { items: [{ id }] } });
    expect(await call(listDispatches, { context: {}, params: project(), query: { state: 'waiting' } })).toMatchObject({
      status: 400,
    });
    expect(await call(readDispatch, { context: {}, params: { id: 'not-an-id' } })).toMatchObject({ status: 404 });
    // A refusal can name a credential and where it may be sent: only whoever may dispatch reads it.
    const detail = 'The credential "Team Jenkins" is sent only under https://jenkins.internal/.';
    await db.update(schema.ciDispatches).set({ state: 'refused', detail }).where(eq(schema.ciDispatches.id, id));
    expect(await call(readDispatch, { context: {}, params: { id } })).toMatchObject({ body: { detail: null } });
    expect(await call(listDispatches, { context: {}, params: project() })).toMatchObject({
      body: { items: [{ id, detail: null }] },
    });
    state.caller = asRole(ProjectRole.MAINTAINER);
    expect(await call(readDispatch, { context: {}, params: { id } })).toMatchObject({ body: { detail } });
    expect(await call(listDispatches, { context: {}, params: project() })).toMatchObject({
      body: { items: [{ id, detail }] },
    });
    state.caller = {
      ...asRole(ProjectRole.VIEWER),
      access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 2, role: ProjectRole.MAINTAINER }]),
    };
    expect(await call(readDispatch, { context: {}, params: { id } })).toMatchObject({
      status: 404,
      body: { message: 'CI dispatch not found' },
    });
  });
});
