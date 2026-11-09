import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, type RouteAccessState } from './route-access';

/** `POST /api/failure-clusters/:id/quarantine`: every test of the cluster quarantined with the reason given. */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
// Signed in as `state.caller`, held to the permission the route declares, as
// requireAuth and the project access helpers hold a request to it.
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);

interface FakeEvent {
  body?: unknown;
  params?: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('apiError', apiError);

type Handler = (event: FakeEvent) => Promise<{ tests: number; quarantined: number }>;
const quarantineCluster = (await import('../../server/api/failure-clusters/[id]/quarantine.post'))
  .default as unknown as Handler;

const robin = { id: 2, role: 'reporter', name: 'Robin', username: 'robin' } as User;

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.caller = {
    user: robin,
    access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.MAINTAINER }]),
  };
  await db
    .insert(schema.users)
    .values({ id: 2, username: 'robin', password: '', role: InstanceRole.MEMBER, name: 'Robin' });
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.roleBindings).values({ userId: 2, projectId: 1, role: ProjectRole.MAINTAINER });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp-1',
    signature: 'Timeout 5000ms exceeded',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
  });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'pays' });
  await db.insert(schema.testRunsCases).values({ testRunId: 1, testCaseId: 1, status: 'failed', failureClusterId: 1 });
});

afterEach(async () => {
  await close();
});

describe('POST /api/failure-clusters/:id/quarantine', () => {
  test('stores at most 500 characters of the reason, as the project quarantine route does', async () => {
    const result = await quarantineCluster({ params: { id: '1' }, body: { reason: 'x'.repeat(600) } });
    expect(result).toMatchObject({ tests: 1, quarantined: 1 });

    const [entry] = await db.select().from(schema.quarantinedTests);
    expect(entry!.reason).toBe('x'.repeat(500));
  });
});
