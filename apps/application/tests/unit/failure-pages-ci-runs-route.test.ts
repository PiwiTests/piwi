import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';

/**
 * The two failure pages, `GET /api/failure-clusters/:id` and `GET /api/test-run-cases/:id`, tell their next-step
 * policy that a CI re-run and a Flake Lab CI run are available only to a viewer who may start one (`run:control`):
 * a Viewer's Next row never offers Re-run in CI, Reproduce in CI or Verify in CI, which the server would refuse.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
const ci = vi.hoisted(() => ({
  rerun: vi.fn(async () => ({ available: true, reason: null, provider: 'github', enabled: true, hasToken: true })),
  flakeLab: vi.fn(async () => ({ available: true, reason: null })),
}));
const seen = vi.hoisted(() => ({ cluster: null as unknown, execution: null as unknown }));

vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
// Signed in as `state.caller`, held to the permission the route declares.
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);
// CI re-run and a Flake Lab CI target are configured for the project.
vi.mock('../../server/utils/ci-rerun', () => ({
  ciRerunAvailability: ci.rerun,
  flakeLabCiAvailability: ci.flakeLab,
}));
vi.mock('../../server/utils/ai-provider', () => ({ resolveAiConfig: async () => null }));
vi.mock('../../server/utils/wasted-settings', () => ({ resolveWastedSettings: async () => ({ isDefault: true }) }));
vi.mock('../../server/utils/scm/ownership', () => ({
  resolveOwners: async () => new Map(),
  codeownersOwnerResolver: () => async () => null,
}));
// What each page's next-step policy is told.
vi.mock('#shared/handlers/failure-clusters', () => ({
  getFailureCluster: async (_db: unknown, _id: number, opts: unknown) => {
    seen.cluster = opts;
    return { affectedTestCases: [], owner: null };
  },
}));
vi.mock('#shared/handlers/test-cases', () => ({
  getTestRunCase: async (_db: unknown, _id: number, _patterns: unknown, opts: unknown) => {
    seen.execution = opts;
    return {};
  },
}));

interface FakeEvent {
  context: Record<string, unknown>;
  params: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('apiError', apiError);

type Route = (event: FakeEvent) => Promise<unknown>;
const clusterRoute = underRoutePermission(
  state,
  (await import('../../server/api/failure-clusters/[id].get')).default as unknown as Route,
);
const executionRoute = underRoutePermission(
  state,
  (await import('../../server/api/test-run-cases/[id].get')).default as unknown as Route,
);

const asRole = (role: ProjectRole): RouteCaller => ({
  user: { id: 3, role: 'user', name: 'Sam', username: 'sam' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role }]),
});

const ask = (route: Route, id: number) => route({ context: {}, params: { id: String(id) } });

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  seen.cluster = null;
  seen.execution = null;
  ci.rerun.mockClear();
  ci.flakeLab.mockClear();
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'totals' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp-1',
    signature: 'page crashed',
    errorType: 'crash',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
  });
  await db.insert(schema.testRunsCases).values({ id: 1, testRunId: 1, testCaseId: 1, status: 'failed' });
});

afterEach(async () => {
  await close();
});

describe('a Viewer', () => {
  beforeEach(() => {
    state.caller = asRole(ProjectRole.VIEWER);
  });

  test('is offered no CI run on a failure cluster', async () => {
    await ask(clusterRoute, 1);
    expect(seen.cluster).toMatchObject({ ciRerunAvailable: false, flakeLabCiAvailable: undefined });
    expect(ci.rerun).not.toHaveBeenCalled();
  });

  test('is offered no CI run on an execution', async () => {
    await ask(executionRoute, 1);
    expect(seen.execution).toMatchObject({ ciRerunAvailable: false, flakeLabCiAvailable: false });
    expect(ci.rerun).not.toHaveBeenCalled();
    expect(ci.flakeLab).not.toHaveBeenCalled();
  });
});

describe('a Maintainer', () => {
  beforeEach(() => {
    state.caller = asRole(ProjectRole.MAINTAINER);
  });

  test('is offered a CI re-run and a Flake Lab CI run on a failure cluster', async () => {
    await ask(clusterRoute, 1);
    const opts = seen.cluster as { ciRerunAvailable: boolean; flakeLabCiAvailable: (id: number) => Promise<boolean> };
    expect(opts.ciRerunAvailable).toBe(true);
    expect(await opts.flakeLabCiAvailable(1)).toBe(true);
  });

  test('is offered a CI re-run and a Flake Lab CI run on an execution', async () => {
    await ask(executionRoute, 1);
    expect(seen.execution).toMatchObject({ ciRerunAvailable: true, flakeLabCiAvailable: true });
  });
});
