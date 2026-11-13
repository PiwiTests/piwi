import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { buildAccessSummary, InstanceRole, ProjectRole } from '#shared/permissions';
import { recordRouteMeta, type RouteAccessState } from './route-access';

/** `DELETE /api/test-runs/:id` called as different people, on a team run and on a private run. */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(
  () => ({ db: null, caller: null, routePermission: [], deleted: [] }) as RouteAccessState & { deleted: number[] },
);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);
vi.mock('../../server/utils/retention', () => ({
  deleteRunsByIds: async (_db: unknown, ids: number[]) => {
    state.deleted.push(...ids);
    return { deletedRuns: ids.length };
  },
}));

interface FakeEvent {
  params?: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('apiError', apiError);

const deleteRun = (await import('../../server/api/test-runs/[id].delete')).default as (
  event: FakeEvent,
) => Promise<unknown>;

const REQUESTER = 5;
const TEAMMATE = 6;
const ADMIN = 7;
const ROLES = {
  [REQUESTER]: ProjectRole.CONTRIBUTOR,
  [TEAMMATE]: ProjectRole.CONTRIBUTOR,
  [ADMIN]: ProjectRole.PROJECT_ADMIN,
};

let temp: Awaited<ReturnType<typeof openTempDb>>;
let teamRun: number;
let privateRun: number;

function as(userId: keyof typeof ROLES) {
  state.caller = {
    user: { id: userId, username: `user-${userId}`, role: InstanceRole.MEMBER } as User,
    access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ROLES[userId] }]),
  };
}

function remove(id: number) {
  return deleteRun({ params: { id: String(id) } });
}

beforeEach(async () => {
  temp = await openTempDb();
  state.db = temp.db as never;
  state.deleted = [];
  await temp.db
    .insert(schema.users)
    .values(
      Object.keys(ROLES).map((id) => ({ id: Number(id), username: `user-${id}`, password: 'x', role: 'member' })),
    );
  await temp.db.insert(schema.projects).values({ id: 1, name: 'shop' });
  const runs = await temp.db
    .insert(schema.testRuns)
    .values([
      { projectId: 1, status: 'passed', startTime: new Date(), origin: 'ci' },
      {
        projectId: 1,
        status: 'failed',
        startTime: new Date(),
        metadata: { piwiOrigin: { kind: 'request', ref: 'a'.repeat(32) } },
        origin: 'request',
        requesterId: REQUESTER,
      },
    ])
    .returning();
  teamRun = runs[0]!.id;
  privateRun = runs[1]!.id;
});

afterEach(async () => {
  state.caller = null;
  await temp.close();
});

describe('deleting a run', () => {
  test('a team run takes run:delete', async () => {
    as(REQUESTER);
    await expect(remove(teamRun)).rejects.toMatchObject({ statusCode: 403 });
    as(ADMIN);
    await remove(teamRun);
    expect(state.deleted).toEqual([teamRun]);
  });

  test('a private run is deleted by its requester, purged by run:delete, and missing to anyone else', async () => {
    as(TEAMMATE);
    await expect(remove(privateRun)).rejects.toMatchObject({ statusCode: 404 });
    expect(state.deleted).toEqual([]);
    as(REQUESTER);
    await remove(privateRun);
    as(ADMIN);
    await remove(privateRun);
    expect(state.deleted).toEqual([privateRun, privateRun]);
  });
});
