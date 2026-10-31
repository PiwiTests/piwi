import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import { InstanceRole, ProjectRole, can, type AccessSummary } from '#shared/permissions';
import { DEMO_GROUPS, DEMO_USERS, demoAccessFor } from '~~/app/demo/demo-users';

/**
 * The demo mirror of access control: the "act as" personas, seeded the way
 * `scripts/generate-demo-seed.mjs` seeds them, sent through the demo router,
 * which holds each route to the permission its server twin declares.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));

const { handleDemoRequest } = await import('~~/app/demo/api/router');

const AVERY = 1;
const CI = 2;
const SAM = 3;
const PRIYA = 4;
const NOAH = 5;
const QUINN = 6;
const JORDAN = 7;

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values([1, 2, 3, 4].map((id) => ({ id, name: `project-${id}` })));
  await db
    .insert(schema.users)
    .values(
      DEMO_USERS.map((u) => ({ id: u.id, username: u.username, password: '', role: u.instanceRole, name: u.name })),
    );
  await db
    .insert(schema.groups)
    .values(DEMO_GROUPS.map((g) => ({ id: g.id, name: g.name, description: g.description })));
  await db
    .insert(schema.groupMembers)
    .values(DEMO_GROUPS.flatMap((g) => g.memberIds.map((userId) => ({ groupId: g.id, userId }))));
  await db
    .insert(schema.roleBindings)
    .values([
      ...DEMO_GROUPS.flatMap((g) => g.bindings.map((b) => ({ groupId: g.id, projectId: b.projectId, role: b.role }))),
      ...DEMO_USERS.filter((u) => u.instanceRole !== InstanceRole.ADMINISTRATOR).flatMap((u) =>
        u.bindings.map((b) => ({ userId: u.id, projectId: b.projectId, role: b.role })),
      ),
    ]);
});

afterAll(() => close());

function as(userId: number) {
  return {
    get: (path: string, query?: string) => handleDemoRequest(path, 'GET', undefined, query, userId) as Promise<any>,
    put: (path: string, body: unknown) => handleDemoRequest(path, 'PUT', body, undefined, userId) as Promise<any>,
    post: (path: string, body: unknown) => handleDemoRequest(path, 'POST', body, undefined, userId) as Promise<any>,
  };
}

async function refusal(promise: Promise<unknown>): Promise<{ statusCode: number; message: string } | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const { statusCode, message } = error as { statusCode: number; message: string };
    return { statusCode, message };
  }
}

const marker = { label: 'Deploy', occurredAt: '2025-03-01T10:00:00Z', category: 'deploy' };

describe('the personas', () => {
  test("each persona's seeded access is what the demo loads for them", async () => {
    for (const user of DEMO_USERS) {
      const me = await as(user.id).get('/api/auth/me');
      const sort = (a: AccessSummary) => ({
        instanceRole: a.instanceRole,
        allProjects: [...a.allProjects].sort(),
        projects: Object.fromEntries(Object.entries(a.projects).map(([id, roles]) => [id, [...roles].sort()])),
      });
      expect(sort(me.user.access), user.username).toEqual(sort(demoAccessFor(user.id)));
    }
  });

  test('cover the roles the switcher promises', () => {
    expect(can(demoAccessFor(AVERY), 'users:manage')).toBe(true);
    expect(can(demoAccessFor(QUINN), 'project:members', 1)).toBe(true);
    expect(can(demoAccessFor(QUINN), 'triage:write', 2)).toBe(true);
    expect(can(demoAccessFor(QUINN), 'project:members', 2)).toBe(false);
    expect(can(demoAccessFor(JORDAN), 'quarantine:write', 4)).toBe(true);
    expect(can(demoAccessFor(PRIYA), 'issue:create', 2)).toBe(true);
    expect(can(demoAccessFor(PRIYA), 'triage:write', 2)).toBe(false);
    expect(can(demoAccessFor(PRIYA), 'project:read', 1)).toBe(false);
    expect(can(demoAccessFor(CI), 'run:submit', 3)).toBe(true);
    expect(can(demoAccessFor(CI), 'issue:create', 3)).toBe(false);
    expect(can(demoAccessFor(SAM), 'project:read', 1)).toBe(true);
    expect(can(demoAccessFor(SAM), 'marker:write', 1)).toBe(false);
    expect(demoAccessFor(NOAH)).toEqual({ instanceRole: InstanceRole.MEMBER, allProjects: [], projects: {} });
  });
});

describe('the demo router holds each route to its permission', () => {
  test('the project list follows the read scope', async () => {
    const ids = async (userId: number) =>
      (await as(userId).get('/api/projects')).items
        .map((p: { id: number }) => p.id)
        .sort((a: number, b: number) => a - b);
    expect(await ids(AVERY)).toEqual([1, 2, 3, 4]);
    expect(await ids(SAM)).toEqual([1]);
    expect(await ids(PRIYA)).toEqual([2, 3]);
    expect(await ids(NOAH)).toEqual([]);
  });

  test('a write needs its permission on the project it acts on', async () => {
    // Priya contributes to project 2, reads nothing of 1; Sam reads 1 and writes nothing.
    expect(await refusal(as(PRIYA).post('/api/projects/2/markers', marker))).toBeNull();
    expect(await refusal(as(PRIYA).post('/api/projects/1/markers', marker))).toEqual({
      statusCode: 403,
      message: 'No access to this project',
    });
    expect(await refusal(as(SAM).post('/api/projects/1/markers', marker))).toEqual({
      statusCode: 403,
      message: 'Insufficient permissions',
    });
  });

  test('instance permissions are for the administrator only', async () => {
    expect((await as(AVERY).get('/api/project-access')).users).toHaveLength(DEMO_USERS.length);
    expect((await refusal(as(QUINN).get('/api/project-access')))?.statusCode).toBe(403);
    expect((await refusal(as(JORDAN).get('/api/settings/ai')))?.statusCode).toBe(403);
  });

  test('a Project admin manages the members of their project only, and lists users by name', async () => {
    const members = await as(QUINN).get('/api/projects/1/members');
    expect(members.canManage).toBe(true);
    expect(members.members).toContainEqual(
      expect.objectContaining({
        subject: { type: 'user', id: QUINN },
        role: ProjectRole.PROJECT_ADMIN,
        source: 'direct',
      }),
    );
    expect((await refusal(as(QUINN).get('/api/projects/2/members')))?.statusCode).toBe(403);

    const users = await as(QUINN).get('/api/users');
    expect(Object.keys(users.items[0]).sort()).toEqual(['id', 'name', 'username']);
    // Noah holds no role yet: Quinn finds him by his whole username only, and cannot name him by id alone.
    const listsNoah = (list: { items: { id: number }[] }) => list.items.some((u) => u.id === NOAH);
    expect(listsNoah(users)).toBe(false);
    expect(listsNoah(await as(QUINN).get('/api/users', 'lookup=NOAH-Newcomer'))).toBe(true);
    const noahByIdOnly = { entries: [{ subject: { type: 'user', id: NOAH }, role: ProjectRole.VIEWER }] };
    expect(await refusal(as(QUINN).put('/api/projects/1/members', noahByIdOnly))).toEqual({
      statusCode: 400,
      message: `User(s) not found: ${NOAH}`,
    });
    expect((await as(QUINN).get('/api/groups')).groups.map((g: { name: string }) => g.name)).toEqual([
      'Product owners',
      'QA',
    ]);
  });

  test('a grid change applies on the next request', async () => {
    await as(AVERY).put('/api/project-access', {
      subject: { type: 'user', id: NOAH },
      projectId: 4,
      role: ProjectRole.VIEWER,
    });
    expect((await as(NOAH).get('/api/projects')).items.map((p: { id: number }) => p.id)).toEqual([4]);
    expect((await as(NOAH).get('/api/auth/me')).user.access.projects).toEqual({ 4: [ProjectRole.VIEWER] });
  });
});
