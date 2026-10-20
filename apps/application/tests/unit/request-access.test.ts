import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import { ADMIN_ACCESS, InstanceRole, type AccessSummary, type RoutePermission } from '#shared/permissions';
import type { User } from '../../server/database/schema';

/**
 * How a request is authorized: `requireAuth` identifies the caller, loads their
 * access once and applies the early check of the route's permission;
 * `requireProjectAccess` decides on the project; `getProjectScope` narrows a
 * list to the projects where a permission is held.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({
  db: null as unknown,
  route: [] as RoutePermission[],
  accessLoads: 0,
}));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
// The permission the route under test declares in its `x-required-permission` meta.
vi.mock('../../server/utils/route-required-permission', () => ({ getRouteRequiredPermissions: () => state.route }));
vi.mock('#shared/handlers/role-bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#shared/handlers/role-bindings')>();
  return {
    ...actual,
    getUserAccess: (...args: Parameters<typeof actual.getUserAccess>) => {
      state.accessLoads++;
      return actual.getUserAccess(...args);
    },
  };
});

interface FakeEvent {
  headers: Record<string, string>;
  context: { access?: AccessSummary; apiKeyId?: number };
}
vi.stubGlobal('getRequestHeader', (event: FakeEvent, name: string) => event.headers[name.toLowerCase()]);
// Authentication is on through PIWI_AUTH_ENABLED, which wins over the runtime config.
vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false }));

const { generateApiKey, getRequestAccess, requireAuth } = await import('../../server/utils/auth');
const { getProjectScope, requireProjectAccess } = await import('../../server/utils/project-access');

let db: TempDb;
let close: () => Promise<void>;
const keys = new Map<number, string>();

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.route = [];
  state.accessLoads = 0;
  process.env.PIWI_AUTH_ENABLED = 'true';
  await db.insert(schema.users).values([
    { id: 1, username: 'avery', password: '', role: InstanceRole.ADMINISTRATOR },
    { id: 2, username: 'robin', password: '', role: InstanceRole.MEMBER },
    { id: 3, username: 'sam', password: '', role: InstanceRole.MEMBER },
    { id: 4, username: 'noah', password: '', role: InstanceRole.MEMBER },
  ]);
  await db.insert(schema.projects).values([
    { id: 10, name: 'web' },
    { id: 11, name: 'api' },
    { id: 12, name: 'docs' },
  ]);
  await db.insert(schema.groups).values({ id: 100, name: 'Product owners' });
  await db.insert(schema.groupMembers).values({ groupId: 100, userId: 3 });
  await db.insert(schema.roleBindings).values([
    // robin: Maintainer on web, Viewer on api.
    { userId: 2, projectId: 10, role: 'maintainer' },
    { userId: 2, projectId: 11, role: 'viewer' },
    // sam: Contributor everywhere, through a group.
    { groupId: 100, projectId: null, role: 'contributor' },
  ]);
  for (const userId of [1, 2, 3, 4]) {
    const key = generateApiKey();
    await db.insert(schema.apiKeys).values({ userId, name: 'ci', keyHash: key.hash, keyPrefix: key.prefix });
    keys.set(userId, key.plaintext);
  }
});

afterEach(async () => {
  delete process.env.PIWI_AUTH_ENABLED;
  await close();
});

function as(userId: number): FakeEvent {
  return { headers: { authorization: `Bearer ${keys.get(userId)}` }, context: {} };
}

async function statusOf(promise: Promise<unknown>): Promise<{ statusCode: number; message: string } | 'ok'> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    const { statusCode, message } = error as { statusCode: number; message: string };
    return { statusCode, message };
  }
}

// The request as h3 reads it too: the bearer token is read through h3's own getRequestHeader.
const event = (e: FakeEvent) => Object.assign(e, { node: { req: { headers: e.headers } } }) as never;
const insufficient = { statusCode: 403, message: 'Insufficient permissions' };
const noAccess = { statusCode: 403, message: 'No access to this project' };

describe('requireAuth', () => {
  test('acts as an administrator holding every permission when authentication is off', async () => {
    delete process.env.PIWI_AUTH_ENABLED;
    const e: FakeEvent = { headers: {}, context: {} };
    state.route = ['users:manage'];
    const user = await requireAuth(event(e));
    expect(user.role).toBe(InstanceRole.ADMINISTRATOR);
    expect(e.context.access).toBe(ADMIN_ACCESS);
    expect(await getRequestAccess(event(e))).toBe(ADMIN_ACCESS);
    expect(await getProjectScope(db as never, user, 'run:delete')).toBe('all');
  });

  test('refuses an unknown key (401)', async () => {
    expect(await statusOf(requireAuth(event({ headers: { authorization: 'Bearer pd_nope' }, context: {} })))).toEqual({
      statusCode: 401,
      message: 'Invalid or expired API key',
    });
  });

  test('loads the access into the event context and records the key', async () => {
    const e = as(2);
    const user = await requireAuth(event(e));
    expect(user.id).toBe(2);
    expect(e.context.apiKeyId).toEqual(expect.any(Number));
    expect(e.context.access).toEqual({
      instanceRole: InstanceRole.MEMBER,
      allProjects: [],
      projects: { 10: ['maintainer'], 11: ['viewer'] },
    });
    expect(await getRequestAccess(event(e))).toBe(e.context.access);
  });

  test.each<[string, RoutePermission[], number, 'ok' | typeof insufficient]>([
    ['signed-in, for a member without any binding', ['signed-in'], 4, 'ok'],
    ['project:read, for a member without any binding', ['project:read'], 4, 'ok'],
    ['a project permission held on one project', ['triage:write'], 2, 'ok'],
    ['a project permission held through a group', ['issue:create'], 3, 'ok'],
    ['a project permission held nowhere', ['run:delete'], 2, insufficient],
    ['any of several, one held', ['run:delete', 'quarantine:write'], 2, 'ok'],
    ['an instance permission, for a member', ['users:manage'], 2, insufficient],
    ['an instance permission, for an administrator', ['users:manage'], 1, 'ok'],
    ['nothing declared', [], 4, 'ok'],
  ])('early check of the route meta: %s', async (_case, route, userId, expected) => {
    state.route = route;
    expect(await statusOf(requireAuth(event(as(userId))))).toEqual(expected);
  });

  test('an explicit permission overrides the route meta', async () => {
    state.route = ['users:manage'];
    expect(await statusOf(requireAuth(event(as(2)), 'signed-in'))).toBe('ok');
    state.route = [];
    expect(await statusOf(requireAuth(event(as(2)), ['run:delete']))).toEqual(insufficient);
  });
});

describe('requireProjectAccess', () => {
  test.each<[string, RoutePermission[], number, number, 'ok' | typeof insufficient | typeof noAccess]>([
    ['reads a project it is bound to', ['project:read'], 2, 11, 'ok'],
    ['reads a project through an all-projects group binding', ['project:read'], 3, 12, 'ok'],
    ['cannot read a project it is not bound to', ['project:read'], 2, 12, noAccess],
    ['a route declaring nothing needs project:read', [], 2, 12, noAccess],
    ['signed-in counts as project:read on a project', ['signed-in'], 4, 10, noAccess],
    ['holds the permission on this project', ['triage:write'], 2, 10, 'ok'],
    ['reads but lacks the permission on this project', ['triage:write'], 2, 11, insufficient],
    ['holds the permission elsewhere, not even read here', ['triage:write'], 2, 12, noAccess],
    ['an administrator holds everything everywhere', ['run:delete'], 1, 12, 'ok'],
  ])('%s', async (_case, route, userId, projectId, expected) => {
    state.route = route;
    expect(await statusOf(requireProjectAccess(event(as(userId)), projectId))).toEqual(expected);
  });

  test('an explicit permission overrides the route meta', async () => {
    state.route = ['project:read'];
    expect(await statusOf(requireProjectAccess(event(as(2)), 11, 'triage:write'))).toEqual(insufficient);
    expect(await statusOf(requireProjectAccess(event(as(2)), 10, 'triage:write'))).toBe('ok');
  });
});

describe('getProjectScope', () => {
  async function user(id: number): Promise<User> {
    return (await requireAuth(event(as(id)))) as User;
  }

  test('narrows to the projects where the permission is held', async () => {
    const robin = await user(2);
    expect(await getProjectScope(db as never, robin)).toEqual(new Set([10, 11]));
    expect(await getProjectScope(db as never, robin, 'triage:write')).toEqual(new Set([10]));
    expect(await getProjectScope(db as never, robin, 'run:delete')).toEqual(new Set());
  });

  test("is 'all' for an administrator and for a role held on all projects", async () => {
    expect(await getProjectScope(db as never, await user(1), 'run:delete')).toBe('all');
    const sam = await user(3);
    expect(await getProjectScope(db as never, sam, 'issue:create')).toBe('all');
    expect(await getProjectScope(db as never, sam, 'triage:write')).toEqual(new Set());
  });

  test('reuses the access requireAuth loaded for the same user', async () => {
    const robin = await user(2);
    expect(state.accessLoads).toBe(1);
    await getProjectScope(db as never, robin, 'triage:write');
    await getProjectScope(db as never, robin);
    expect(state.accessLoads).toBe(1);
  });
});
