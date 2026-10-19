import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import { buildAccessSummary, InstanceRole, ProjectRole, type AccessSummary } from '#shared/permissions';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler module (which imports the barrel) is loaded.
delete process.env.PIWI_DATABASE_URL;
const {
  AccessError,
  createUserAccount,
  deleteUserAccount,
  getProjectAccessGrid,
  getProjectMembersResponse,
  getProjectMemberViews,
  getUserProjectRoles,
  listUserItems,
  listUserSummaries,
  replaceProjectMembers,
  setProjectAccessCell,
  setUserProjectRoles,
  updateUserAccount,
} = await import('../../shared/handlers/project-access');

let db: TempDb;
let close: () => Promise<void>;

const ADMIN = buildAccessSummary(InstanceRole.ADMINISTRATOR, []);
const member = (...grants: { projectId: number | null; role: ProjectRole }[]): AccessSummary =>
  buildAccessSummary(InstanceRole.MEMBER, grants);

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.users).values([
    { id: 1, username: 'avery', password: '', role: 'administrator', name: 'Avery' },
    { id: 2, username: 'quinn', password: '', role: 'member', name: 'Quinn' },
    { id: 3, username: 'sam', password: '', role: 'member', name: 'Sam' },
    { id: 4, username: 'noah', password: '', role: 'member' },
  ]);
  await db.insert(schema.projects).values([
    { id: 10, name: 'web', label: 'Web' },
    { id: 11, name: 'api', label: 'API' },
  ]);
  await db.insert(schema.groups).values([
    { id: 100, name: 'QA' },
    { id: 101, name: 'Product owners' },
  ]);
  await db.insert(schema.groupMembers).values([
    { groupId: 100, userId: 2 },
    { groupId: 101, userId: 3 },
  ]);
});

afterEach(() => close());

async function bind(values: Partial<typeof schema.roleBindings.$inferInsert> & { role: string }) {
  await db.insert(schema.roleBindings).values(values);
}

async function storedBindings() {
  const rows = await db.select().from(schema.roleBindings);
  return rows
    .map((row) => ({ userId: row.userId, groupId: row.groupId, projectId: row.projectId, role: row.role }))
    .sort(
      (a, b) =>
        (a.userId ?? 0) - (b.userId ?? 0) ||
        (a.groupId ?? 0) - (b.groupId ?? 0) ||
        (a.projectId ?? 0) - (b.projectId ?? 0),
    );
}

async function refusal(promise: Promise<unknown>): Promise<{ statusCode: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AccessError || (error as { statusCode?: number }).statusCode) {
      const { statusCode, message } = error as { statusCode: number; message: string };
      return { statusCode, message };
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('getProjectAccessGrid', () => {
  test('lists every user, group, project and binding, sorted by the names shown', async () => {
    await bind({ userId: 2, projectId: 10, role: 'project_admin' });
    await bind({ groupId: 100, projectId: null, role: 'maintainer' });

    const grid = await getProjectAccessGrid(db);
    expect(grid.users).toEqual([
      { id: 1, username: 'avery', name: 'Avery', instanceRole: InstanceRole.ADMINISTRATOR, groupIds: [] },
      { id: 4, username: 'noah', name: null, instanceRole: InstanceRole.MEMBER, groupIds: [] },
      { id: 2, username: 'quinn', name: 'Quinn', instanceRole: InstanceRole.MEMBER, groupIds: [100] },
      { id: 3, username: 'sam', name: 'Sam', instanceRole: InstanceRole.MEMBER, groupIds: [101] },
    ]);
    expect(grid.groups).toEqual([
      { id: 101, name: 'Product owners', description: null, memberCount: 1 },
      { id: 100, name: 'QA', description: null, memberCount: 1 },
    ]);
    expect(grid.projects.map((p) => p.label)).toEqual(['API', 'Web']);
    expect(grid.bindings).toEqual([
      { subject: { type: 'user', id: 2 }, projectId: 10, role: ProjectRole.PROJECT_ADMIN },
      { subject: { type: 'group', id: 100 }, projectId: null, role: ProjectRole.MAINTAINER },
    ]);
  });

  test('a stored role of an earlier version reads as member', async () => {
    await db.update(schema.users).set({ role: 'reporter' }).where(eq(schema.users.id, 4));
    const grid = await getProjectAccessGrid(db);
    expect(grid.users.find((u) => u.id === 4)?.instanceRole).toBe(InstanceRole.MEMBER);
  });
});

describe('setProjectAccessCell', () => {
  test("sets, replaces and removes one cell, idempotently, returning the subject's bindings", async () => {
    const subject = { type: 'user' as const, id: 3 };
    await setProjectAccessCell(db, { subject, projectId: 10, role: ProjectRole.VIEWER }, 1);
    const again = await setProjectAccessCell(db, { subject, projectId: 10, role: ProjectRole.VIEWER }, 1);
    expect(again).toEqual([{ subject, projectId: 10, role: ProjectRole.VIEWER }]);

    const replaced = await setProjectAccessCell(db, { subject, projectId: 10, role: ProjectRole.MAINTAINER }, 1);
    expect(replaced).toEqual([{ subject, projectId: 10, role: ProjectRole.MAINTAINER }]);

    const withAll = await setProjectAccessCell(db, { subject, projectId: null, role: ProjectRole.VIEWER }, 1);
    expect(withAll).toHaveLength(2);

    await setProjectAccessCell(db, { subject, projectId: null, role: null }, 1);
    expect(await setProjectAccessCell(db, { subject, projectId: null, role: null }, 1)).toEqual([
      { subject, projectId: 10, role: ProjectRole.MAINTAINER },
    ]);
    const [row] = await db.select().from(schema.roleBindings);
    expect(row).toMatchObject({ userId: 3, projectId: 10, createdBy: 1 });
  });

  test('binds a group like a user', async () => {
    const bindings = await setProjectAccessCell(
      db,
      { subject: { type: 'group', id: 101 }, projectId: 11, role: ProjectRole.CONTRIBUTOR },
      null,
    );
    expect(bindings).toEqual([{ subject: { type: 'group', id: 101 }, projectId: 11, role: ProjectRole.CONTRIBUTOR }]);
  });

  test('refuses an administrator, and unknown users, groups and projects', async () => {
    const cell = (type: 'user' | 'group', id: number, projectId: number | null = 10) =>
      setProjectAccessCell(db, { subject: { type, id }, projectId, role: ProjectRole.VIEWER }, null);
    expect(await refusal(cell('user', 1))).toEqual({
      statusCode: 400,
      message: 'Administrators can open every project',
    });
    expect(await refusal(cell('user', 99))).toEqual({ statusCode: 404, message: 'User not found' });
    expect(await refusal(cell('group', 99))).toEqual({ statusCode: 404, message: 'Group not found' });
    expect(await refusal(cell('user', 3, 99))).toEqual({ statusCode: 404, message: 'Project not found' });
    expect(await storedBindings()).toEqual([]);
  });
});

describe('project members', () => {
  beforeEach(async () => {
    await bind({ userId: 2, projectId: 10, role: 'project_admin' });
    await bind({ groupId: 100, projectId: null, role: 'maintainer' });
    await bind({ groupId: 101, projectId: 10, role: 'contributor' });
    await bind({ userId: 4, projectId: null, role: 'uploader' });
    await bind({ userId: 3, projectId: 11, role: 'viewer' });
  });

  test('one row per role and source: groups, then users, by name', async () => {
    const rows = await getProjectMemberViews(db, 10);
    expect(rows.map((r) => [r.subject.type, r.name, r.role, r.source, r.groupName ?? null])).toEqual([
      ['group', 'Product owners', ProjectRole.CONTRIBUTOR, 'direct', null],
      ['group', 'QA', ProjectRole.MAINTAINER, 'all-projects', null],
      ['user', 'Avery', ProjectRole.PROJECT_ADMIN, 'administrator', null],
      ['user', 'noah', ProjectRole.UPLOADER, 'all-projects', null],
      ['user', 'Quinn', ProjectRole.PROJECT_ADMIN, 'direct', null],
      ['user', 'Quinn', ProjectRole.MAINTAINER, 'group', 'QA'],
      ['user', 'Sam', ProjectRole.CONTRIBUTOR, 'group', 'Product owners'],
    ]);
    expect(rows.find((r) => r.name === 'noah')).toMatchObject({ username: 'noah', subject: { type: 'user', id: 4 } });
  });

  test('says whether the caller manages them and which roles they may grant; 404 for an unknown project', async () => {
    const quinn = member(
      { projectId: 10, role: ProjectRole.PROJECT_ADMIN },
      { projectId: null, role: ProjectRole.MAINTAINER },
    );
    const forQuinn = await getProjectMembersResponse(db, 10, quinn);
    expect(forQuinn.canManage).toBe(true);
    expect(forQuinn.grantableRoles).toHaveLength(5);
    const onOther = await getProjectMembersResponse(db, 11, quinn);
    expect(onOther).toMatchObject({ canManage: false, grantableRoles: [] });
    expect(await refusal(getProjectMembersResponse(db, 99, ADMIN))).toEqual({
      statusCode: 404,
      message: 'Project not found',
    });
  });

  test("replaces the project's direct bindings only; a subject listed twice keeps its last role", async () => {
    await replaceProjectMembers(
      db,
      10,
      [
        { subject: { type: 'user', id: 3 }, role: ProjectRole.VIEWER },
        { subject: { type: 'user', id: 3 }, role: ProjectRole.MAINTAINER },
        { subject: { type: 'group', id: 100 }, role: ProjectRole.CONTRIBUTOR },
      ],
      { userId: 1, access: ADMIN },
    );
    expect(await storedBindings()).toEqual([
      { userId: null, groupId: 100, projectId: null, role: 'maintainer' },
      { userId: null, groupId: 100, projectId: 10, role: 'contributor' },
      { userId: 3, groupId: null, projectId: 10, role: 'maintainer' },
      { userId: 3, groupId: null, projectId: 11, role: 'viewer' },
      { userId: 4, groupId: null, projectId: null, role: 'uploader' },
    ]);
  });

  test('refuses unknown users and groups, and administrators, before changing anything', async () => {
    const replace = (entries: Parameters<typeof replaceProjectMembers>[2]) =>
      refusal(replaceProjectMembers(db, 10, entries, { userId: 1, access: ADMIN }));
    expect(await replace([{ subject: { type: 'user', id: 98 }, role: ProjectRole.VIEWER }])).toEqual({
      statusCode: 400,
      message: 'User(s) not found: 98',
    });
    expect(await replace([{ subject: { type: 'group', id: 98 }, role: ProjectRole.VIEWER }])).toEqual({
      statusCode: 400,
      message: 'Group(s) not found: 98',
    });
    expect(await replace([{ subject: { type: 'user', id: 1 }, role: ProjectRole.VIEWER }])).toMatchObject({
      statusCode: 400,
    });
    expect(await refusal(replaceProjectMembers(db, 99, [], { userId: 1, access: ADMIN }))).toMatchObject({
      statusCode: 404,
    });
    expect(await storedBindings()).toHaveLength(5);
  });

  test("a Project admin edits their project's bindings; a role they cannot grant is refused", async () => {
    const quinn = member({ projectId: 10, role: ProjectRole.PROJECT_ADMIN });
    await replaceProjectMembers(
      db,
      10,
      [
        { subject: { type: 'user', id: 2 }, role: ProjectRole.PROJECT_ADMIN },
        { subject: { type: 'user', id: 4 }, role: ProjectRole.VIEWER },
      ],
      { userId: 2, access: quinn },
    );
    expect((await storedBindings()).filter((b) => b.projectId === 10)).toEqual([
      { userId: 2, groupId: null, projectId: 10, role: 'project_admin' },
      { userId: 4, groupId: null, projectId: 10, role: 'viewer' },
    ]);

    // A Maintainer of the project holds no role they could grant.
    const maintainer = member({ projectId: 10, role: ProjectRole.MAINTAINER });
    const refused = await refusal(
      replaceProjectMembers(db, 10, [{ subject: { type: 'user', id: 3 }, role: ProjectRole.VIEWER }], {
        userId: 3,
        access: maintainer,
      }),
    );
    expect(refused.statusCode).toBe(403);
    // Quinn is Project admin of web only.
    expect((await refusal(replaceProjectMembers(db, 11, [], { userId: 2, access: quinn }))).statusCode).toBe(403);
    expect((await storedBindings()).filter((b) => b.projectId === 11)).toHaveLength(1);
  });

  test('the Project admin role held through a group lets its members grant', async () => {
    await bind({ groupId: 100, projectId: 11, role: 'project_admin' });
    const viaGroup = member({ projectId: 11, role: ProjectRole.PROJECT_ADMIN });
    await replaceProjectMembers(db, 11, [{ subject: { type: 'group', id: 101 }, role: ProjectRole.VIEWER }], {
      userId: 2,
      access: viaGroup,
    });
    expect((await storedBindings()).filter((b) => b.projectId === 11)).toEqual([
      { userId: null, groupId: 101, projectId: 11, role: 'viewer' },
    ]);
  });
});

describe("a user's own project roles", () => {
  test('replaces the own bindings, all projects included, and leaves the groups’ alone', async () => {
    await bind({ userId: 3, projectId: 10, role: 'viewer' });
    await bind({ groupId: 101, projectId: 11, role: 'contributor' });

    const result = await setUserProjectRoles(
      db,
      3,
      {
        allProjects: ProjectRole.VIEWER,
        projects: [
          { projectId: 11, role: ProjectRole.VIEWER },
          { projectId: 11, role: ProjectRole.MAINTAINER },
        ],
      },
      1,
    );
    expect(result).toEqual({
      allProjects: ProjectRole.VIEWER,
      projects: [{ projectId: 11, role: ProjectRole.MAINTAINER }],
      groups: [{ id: 101, name: 'Product owners' }],
    });
    expect(await storedBindings()).toEqual([
      { userId: null, groupId: 101, projectId: 11, role: 'contributor' },
      { userId: 3, groupId: null, projectId: null, role: 'viewer' },
      { userId: 3, groupId: null, projectId: 11, role: 'maintainer' },
    ]);

    await setUserProjectRoles(db, 3, { allProjects: null, projects: [] }, 1);
    expect(await getUserProjectRoles(db, 3)).toEqual({
      allProjects: null,
      projects: [],
      groups: [{ id: 101, name: 'Product owners' }],
    });
  });

  test('null for an unknown user; refuses an administrator and an unknown project', async () => {
    expect(await getUserProjectRoles(db, 99)).toBeNull();
    expect((await refusal(setUserProjectRoles(db, 1, { allProjects: null, projects: [] }, null))).statusCode).toBe(400);
    expect(
      await refusal(
        setUserProjectRoles(
          db,
          3,
          { allProjects: null, projects: [{ projectId: 99, role: ProjectRole.VIEWER }] },
          null,
        ),
      ),
    ).toEqual({ statusCode: 400, message: 'Project(s) not found: 99' });
    expect((await refusal(setUserProjectRoles(db, 99, { allProjects: null, projects: [] }, null))).statusCode).toBe(
      404,
    );
  });
});

describe('users', () => {
  test('administrators see instance roles and groups; others only ids and names, by the name shown', async () => {
    const items = await listUserItems(db);
    expect(items.find((u) => u.id === 2)).toMatchObject({
      username: 'quinn',
      role: 'member',
      instanceRole: InstanceRole.MEMBER,
      groupIds: [100],
    });
    expect(items.find((u) => u.id === 1)?.instanceRole).toBe(InstanceRole.ADMINISTRATOR);
    expect(await listUserSummaries(db)).toEqual([
      { id: 1, username: 'avery', name: 'Avery' },
      { id: 4, username: 'noah', name: null },
      { id: 2, username: 'quinn', name: 'Quinn' },
      { id: 3, username: 'sam', name: 'Sam' },
    ]);
  });

  test('a new user joins their groups; a taken username or email is a 409, an unknown group a 400 that creates nobody', async () => {
    const created = await createUserAccount(
      db,
      {
        username: 'jordan',
        password: 'x',
        role: InstanceRole.MEMBER,
        email: 'jordan@example.com',
        groupIds: [100, 101],
      },
      1,
    );
    expect(created).toMatchObject({ username: 'jordan', instanceRole: InstanceRole.MEMBER, groupIds: [100, 101] });
    expect(
      await refusal(createUserAccount(db, { username: 'jordan', password: 'x', role: InstanceRole.MEMBER }, 1)),
    ).toEqual({ statusCode: 409, message: 'Username already exists' });
    expect(
      await refusal(
        createUserAccount(
          db,
          { username: 'kim', password: 'x', role: InstanceRole.MEMBER, email: 'Jordan@example.com' },
          1,
        ),
      ),
    ).toEqual({ statusCode: 409, message: 'Email already in use' });
    expect(
      await refusal(
        createUserAccount(db, { username: 'kim', password: 'x', role: InstanceRole.MEMBER, groupIds: [7] }, 1),
      ),
    ).toEqual({ statusCode: 400, message: 'Group(s) not found: 7' });
    expect((await listUserSummaries(db)).some((u) => u.username === 'kim')).toBe(false);
  });

  describe('updateUserAccount', () => {
    const asAdmin = { userId: 1, access: ADMIN };
    const guard = { guardLastAdministrator: true };

    test('the last administrator cannot be demoted while authentication is on', async () => {
      expect(await refusal(updateUserAccount(db, 1, { role: InstanceRole.MEMBER }, asAdmin, guard))).toEqual({
        statusCode: 400,
        message: 'Cannot demote the last administrator',
      });
      await db.update(schema.users).set({ role: 'administrator' }).where(eq(schema.users.id, 4));
      const { user, instanceRoleChanged } = await updateUserAccount(
        db,
        1,
        { role: InstanceRole.MEMBER },
        asAdmin,
        guard,
      );
      expect(user.instanceRole).toBe(InstanceRole.MEMBER);
      expect(instanceRoleChanged).toBe(true);
    });

    test('two administrators demoted at once leave one administrator', async () => {
      await db.update(schema.users).set({ role: 'administrator' }).where(eq(schema.users.id, 4));
      const results = await Promise.allSettled([
        updateUserAccount(db, 1, { role: InstanceRole.MEMBER }, asAdmin, guard),
        updateUserAccount(db, 4, { role: InstanceRole.MEMBER }, asAdmin, guard),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const admins = await db.select().from(schema.users).where(eq(schema.users.role, 'administrator'));
      expect(admins).toHaveLength(1);
    });

    test('without authentication the rule does not apply', async () => {
      const { user } = await updateUserAccount(db, 1, { role: InstanceRole.MEMBER }, asAdmin, {
        guardLastAdministrator: false,
      });
      expect(user.instanceRole).toBe(InstanceRole.MEMBER);
    });

    test('keeping the same role is not a change', async () => {
      const { instanceRoleChanged } = await updateUserAccount(db, 3, { role: InstanceRole.MEMBER }, asAdmin, guard);
      expect(instanceRoleChanged).toBe(false);
    });

    test('anyone changes their own name; only an administrator another user, a role or groups', async () => {
      const sam = { userId: 3, access: member({ projectId: 10, role: ProjectRole.PROJECT_ADMIN }) };
      expect((await updateUserAccount(db, 3, { name: 'Samuel' }, sam, guard)).user.name).toBe('Samuel');
      expect((await refusal(updateUserAccount(db, 2, { name: 'Q' }, sam, guard))).statusCode).toBe(403);
      expect(
        (await refusal(updateUserAccount(db, 3, { role: InstanceRole.ADMINISTRATOR }, sam, guard))).statusCode,
      ).toBe(403);
      expect((await refusal(updateUserAccount(db, 3, { groupIds: [100] }, sam, guard))).statusCode).toBe(403);
    });

    test("an administrator sets a user's groups; an unknown group or user is refused", async () => {
      const { user } = await updateUserAccount(db, 3, { groupIds: [100] }, asAdmin, guard);
      expect(user.groupIds).toEqual([100]);
      expect((await refusal(updateUserAccount(db, 3, { groupIds: [7] }, asAdmin, guard))).statusCode).toBe(400);
      expect((await refusal(updateUserAccount(db, 99, { name: 'x' }, asAdmin, guard))).statusCode).toBe(404);
    });

    test('an email another account uses is a 409', async () => {
      await updateUserAccount(db, 2, { email: 'q@example.com' }, asAdmin, guard);
      expect(await refusal(updateUserAccount(db, 3, { email: 'Q@example.com' }, asAdmin, guard))).toEqual({
        statusCode: 409,
        message: 'Email already in use',
      });
    });
  });

  test('deleting a user removes their bindings and memberships; the lockout guards hold', async () => {
    await bind({ userId: 3, projectId: 10, role: 'viewer' });
    await deleteUserAccount(db, 3, 1, { guard: true });
    expect(await storedBindings()).toEqual([]);
    expect(await db.select().from(schema.groupMembers).where(eq(schema.groupMembers.userId, 3))).toEqual([]);

    expect(await refusal(deleteUserAccount(db, 1, 1, { guard: true }))).toEqual({
      statusCode: 400,
      message: 'You cannot delete your own account',
    });
    expect(await refusal(deleteUserAccount(db, 1, 2, { guard: true }))).toEqual({
      statusCode: 400,
      message: 'Cannot delete the last administrator',
    });
    expect((await refusal(deleteUserAccount(db, 99, 1, { guard: true }))).statusCode).toBe(404);
  });

  test('two administrators deleted at once leave one administrator', async () => {
    await db.update(schema.users).set({ role: 'administrator' }).where(eq(schema.users.id, 4));
    const results = await Promise.allSettled([
      deleteUserAccount(db, 1, 2, { guard: true }),
      deleteUserAccount(db, 4, 2, { guard: true }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const admins = await db.select().from(schema.users).where(eq(schema.users.role, 'administrator'));
    expect(admins).toHaveLength(1);
  });
});
