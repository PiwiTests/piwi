/**
 * Access management: the users, groups, permission grid and project members
 * routes, on top of the role bindings and groups data layer
 * (`./role-bindings`, `./groups`). Shared by the server routes and the demo,
 * which turn an `AccessError` (or a `GroupError`) into an HTTP error with its
 * status. The shapes are in `#shared/project-access`.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { groups, projects, users } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import {
  can,
  canGrantRole,
  InstanceRole,
  isAdministrator,
  PROJECT_ROLE_LABELS,
  ProjectRole,
  projectRolesOf,
  type AccessSummary,
} from '#shared/permissions';
import {
  accessSubjectKey,
  grantableProjectRoles,
  sortProjectAccessGroups,
  sortProjectAccessProjects,
  sortProjectAccessUsers,
  sortProjectMembers,
  type AccessSubject,
  type GroupListItem,
  type GroupView,
  type ProjectAccessGrid,
  type ProjectAccessUpdate,
  type ProjectMemberView,
  type ProjectMembersResponse,
  type ProjectMembersUpdate,
  type RoleBindingView,
  type UpdateUserRequest,
  type UserListItem,
  type UserProjectRoles,
  type UserProjectRolesResponse,
  type UserSummary,
} from '#shared/project-access';
import {
  getProjectMembers,
  listRoleBindings,
  replaceProjectBindings,
  replaceSubjectBindings,
  setRoleBinding,
  type RoleBindingRow,
  type RoleBindingSubject,
} from './role-bindings';
import {
  assertGroupsExist,
  getGroup,
  getGroupIdsByUser,
  getUserGroups,
  GroupError,
  listGroups,
  setUserGroups,
  type GroupDetails,
  type GroupSummary,
} from './groups';
import { createUserRecord, deleteUserRecord, listUsers, updateUserRecord } from './users';

/** A refusal the routes turn into an API error with `statusCode`. */
export class AccessError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** The status and message of a refusal from these handlers or the groups ones; null for any other error. */
export function accessRefusal(error: unknown): { statusCode: number; message: string } | null {
  if (error instanceof AccessError || error instanceof GroupError) {
    return { statusCode: error.statusCode, message: error.message };
  }
  return null;
}

const ADMINISTRATOR_OPENS_EVERYTHING = 'Administrators can open every project';

// ── Request bodies ────────────────────────────────────────────────────────────

const idSchema = z.number().int().positive();
const projectRoleSchema = z.enum(ProjectRole);
const subjectSchema = z.object({ type: z.enum(['user', 'group']), id: idSchema });

export const projectAccessUpdateSchema = z.object({
  subject: subjectSchema,
  projectId: idSchema.nullable(),
  role: projectRoleSchema.nullable(),
});

export const projectMembersUpdateSchema = z.object({
  entries: z.array(z.object({ subject: subjectSchema, role: projectRoleSchema })),
});

export const userProjectRolesSchema = z.object({
  allProjects: projectRoleSchema.nullable(),
  projects: z.array(z.object({ projectId: idSchema, role: projectRoleSchema })),
});

export const createUserSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8).optional(),
  // `reporter` and `user` are the roles of earlier versions, accepted for one release and stored as `member`.
  role: z.union([z.enum(InstanceRole), z.enum(['reporter', 'user'])]),
  name: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  groupIds: z.array(idSchema).optional(),
});

export const updateUserSchema = z.object({
  name: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  role: z.enum(InstanceRole).optional(),
  groupIds: z.array(idSchema).optional(),
});

export const groupCreateSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
});

export const groupPatchSchema = groupCreateSchema.partial();

export const groupMembersSchema = z.object({ userIds: z.array(idSchema) });

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The instance role a stored `users.role` stands for: anything but an administrator is a member. */
function instanceRoleOf(role: string): InstanceRole {
  return role === InstanceRole.ADMINISTRATOR ? InstanceRole.ADMINISTRATOR : InstanceRole.MEMBER;
}

function bindingSubject(subject: AccessSubject): RoleBindingSubject {
  return subject.type === 'user' ? { userId: subject.id } : { groupId: subject.id };
}

function toBindingView(row: RoleBindingRow): RoleBindingView {
  return { subject: { type: row.subject.kind, id: row.subject.id }, projectId: row.projectId, role: row.role };
}

async function requireProject(db: DrizzleDB, projectId: number): Promise<void> {
  const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!row) throw new AccessError(404, 'Project not found');
}

/** 404 for a missing user or group, 400 for an administrator, who needs no binding. */
async function requireBindableSubject(db: DrizzleDB, subject: AccessSubject): Promise<void> {
  if (subject.type === 'user') {
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, subject.id));
    if (!row) throw new AccessError(404, 'User not found');
    if (row.role === InstanceRole.ADMINISTRATOR) throw new AccessError(400, ADMINISTRATOR_OPENS_EVERYTHING);
    return;
  }
  const [row] = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, subject.id));
  if (!row) throw new AccessError(404, 'Group not found');
}

/**
 * Give an administrator the role `role` only while another administrator
 * remains, so two demotions or deletions at once cannot both pass. False when
 * `userId` is the last administrator.
 *
 * One transaction first writes every administrator row, which locks them:
 * a concurrent demotion waits there until this one commits, and its
 * conditional UPDATE then reads the administrators this one left. PostgreSQL's
 * read-committed statements each see what was committed when they start;
 * SQLite runs one writing transaction at a time.
 */
async function dropAdministratorRole(db: DrizzleDB, userId: number, role: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ role: sql`${users.role}` })
      .where(eq(users.role, InstanceRole.ADMINISTRATOR));
    const anotherAdministrator = sql`exists (select 1 from ${users} where ${users.role} = ${InstanceRole.ADMINISTRATOR} and ${users.id} <> ${userId})`;
    const changed = await tx
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(users.id, userId), anotherAdministrator))
      .returning({ id: users.id });
    return changed.length > 0;
  });
}

// ── Users ─────────────────────────────────────────────────────────────────────

type UserRow = Awaited<ReturnType<typeof listUsers>>['users'][number];

function toUserListItem(row: UserRow, groupIds: number[]): UserListItem {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    instanceRole: instanceRoleOf(row.role),
    groupIds,
    email: row.email,
    emailVerified: row.emailVerified,
    oauthProvider: row.oauthProvider,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Every user with their instance role and groups: what administrators see. */
export async function listUserItems(db: DrizzleDB): Promise<UserListItem[]> {
  const [{ users: rows }, groupIdsByUser] = await Promise.all([listUsers(db), getGroupIdsByUser(db)]);
  return rows.map((row) => toUserListItem(row, groupIdsByUser.get(row.id) ?? []));
}

/** Every user's id and names: what a project admin needs to add someone to their project. */
export async function listUserSummaries(db: DrizzleDB): Promise<UserSummary[]> {
  const rows = await db.select({ id: users.id, username: users.username, name: users.name }).from(users);
  return sortProjectAccessUsers(rows);
}

async function userItem(db: DrizzleDB, userId: number): Promise<UserListItem> {
  const { users: rows } = await listUsers(db);
  const row = rows.find((r) => r.id === userId);
  if (!row) throw new AccessError(404, 'User not found');
  const groupIds = (await getUserGroups(db, userId)).map((g) => g.id).sort((a, b) => a - b);
  return toUserListItem(row, groupIds);
}

/**
 * Create an account. `password` is stored as given (the server hashes it
 * first). A new member holds no project role until one is granted.
 */
export async function createUserAccount(
  db: DrizzleDB,
  input: {
    username: string;
    password: string;
    role: InstanceRole;
    name?: string;
    email?: string | null;
    groupIds?: number[];
  },
  createdBy: number | null,
): Promise<UserListItem> {
  if (input.groupIds) await assertGroupsExist(db, input.groupIds);
  let created: Awaited<ReturnType<typeof createUserRecord>>;
  try {
    created = await createUserRecord(db, {
      username: input.username,
      password: input.password,
      role: input.role,
      name: input.name,
      email: input.email || null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Username already exists')
      throw new AccessError(409, error.message);
    if (error instanceof Error && error.message === 'Email already in use') throw new AccessError(409, error.message);
    throw error;
  }
  if (!created) throw new Error('Failed to create user');
  if (input.groupIds?.length) await setUserGroups(db, created.id, input.groupIds, createdBy);
  return userItem(db, created.id);
}

/**
 * Change a user's name, email, instance role or groups. Anyone may change
 * their own name and email; only an administrator changes another user, an
 * instance role or groups. With `guardLastAdministrator` (authentication on),
 * the last administrator cannot be demoted. `instanceRoleChanged` tells the
 * server to revoke the user's sessions.
 */
export async function updateUserAccount(
  db: DrizzleDB,
  userId: number,
  patch: UpdateUserRequest,
  actor: { userId: number | null; access: AccessSummary },
  options: { guardLastAdministrator: boolean },
): Promise<{ user: UserListItem; instanceRoleChanged: boolean }> {
  const admin = isAdministrator(actor.access);
  if (!admin && actor.userId !== userId) throw new AccessError(403, 'Insufficient permissions');
  if (!admin && patch.role !== undefined) throw new AccessError(403, 'Only administrators can change roles');
  if (!admin && patch.groupIds !== undefined) throw new AccessError(403, 'Only administrators can change groups');

  const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!target) throw new AccessError(404, 'User not found');
  const demoted =
    patch.role !== undefined && patch.role !== InstanceRole.ADMINISTRATOR && target.role === InstanceRole.ADMINISTRATOR;
  if (patch.groupIds) await assertGroupsExist(db, patch.groupIds);
  if (options.guardLastAdministrator && demoted && !(await dropAdministratorRole(db, userId, patch.role!))) {
    throw new AccessError(400, 'Cannot demote the last administrator');
  }

  const { groupIds, ...fields } = patch;
  try {
    await updateUserRecord(db, userId, fields);
  } catch (error) {
    if (error instanceof Error && error.message === 'Email already in use') throw new AccessError(409, error.message);
    if (error instanceof Error && error.message === 'User not found') throw new AccessError(404, error.message);
    throw error;
  }
  if (groupIds) await setUserGroups(db, userId, groupIds, actor.userId || null);
  return {
    user: await userItem(db, userId),
    instanceRoleChanged: patch.role !== undefined && patch.role !== target.role,
  };
}

/**
 * Delete an account. With `guard` (authentication on), nobody deletes their
 * own account and the last administrator stays.
 */
export async function deleteUserAccount(
  db: DrizzleDB,
  userId: number,
  actorId: number | null,
  options: { guard: boolean },
): Promise<{ success: true }> {
  if (options.guard) {
    if (actorId === userId) throw new AccessError(400, 'You cannot delete your own account');
    const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
    if (!target) throw new AccessError(404, 'User not found');
    // The administrator role goes first, in one conditional statement, so the last one is never deleted.
    if (target.role === InstanceRole.ADMINISTRATOR && !(await dropAdministratorRole(db, userId, InstanceRole.MEMBER))) {
      throw new AccessError(400, 'Cannot delete the last administrator');
    }
  }
  try {
    await deleteUserRecord(db, userId);
  } catch (error) {
    if (error instanceof Error && error.message === 'User not found') throw new AccessError(404, error.message);
    throw error;
  }
  return { success: true };
}

/** A user's own role bindings and their groups; null for an unknown user. */
export async function getUserProjectRoles(db: DrizzleDB, userId: number): Promise<UserProjectRolesResponse | null> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) return null;
  const bindings = await listRoleBindings(db, { userId });
  return {
    allProjects: bindings.find((b) => b.projectId === null)?.role ?? null,
    projects: bindings
      .filter((b): b is RoleBindingRow & { projectId: number } => b.projectId !== null)
      .map((b) => ({ projectId: b.projectId, role: b.role }))
      .sort((a, b) => a.projectId - b.projectId),
    groups: await getUserGroups(db, userId),
  };
}

/**
 * Replace a user's own role bindings. Their groups' bindings are untouched.
 * A project listed twice keeps its last role.
 */
export async function setUserProjectRoles(
  db: DrizzleDB,
  userId: number,
  roles: UserProjectRoles,
  createdBy: number | null,
): Promise<UserProjectRolesResponse> {
  await requireBindableSubject(db, { type: 'user', id: userId });
  const projectIds = [...new Set(roles.projects.map((p) => p.projectId))];
  if (projectIds.length > 0) {
    const found = await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, projectIds));
    const foundIds = new Set(found.map((row) => row.id));
    const missing = projectIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) throw new AccessError(400, `Project(s) not found: ${missing.join(', ')}`);
  }
  await replaceSubjectBindings(
    db,
    { userId },
    [...(roles.allProjects ? [{ projectId: null, role: roles.allProjects }] : []), ...roles.projects],
    createdBy,
  );
  return (await getUserProjectRoles(db, userId))!;
}

// ── Groups ────────────────────────────────────────────────────────────────────

function toGroupListItem(group: GroupSummary): GroupListItem {
  return { id: group.id, name: group.name, description: group.description, memberCount: group.memberCount };
}

function toGroupView(group: GroupDetails): GroupView {
  return {
    ...toGroupListItem(group),
    members: group.members.map((m) => ({ id: m.id, username: m.username, name: m.name })),
  };
}

/** Every group with its member count, by name. */
export async function listGroupItems(db: DrizzleDB): Promise<GroupListItem[]> {
  return (await listGroups(db)).map(toGroupListItem);
}

/** One group with its members. Throws a 404 `GroupError` when it does not exist. */
export async function getGroupView(db: DrizzleDB, groupId: number): Promise<GroupView> {
  const group = await getGroup(db, groupId);
  if (!group) throw new GroupError(404, 'Group not found');
  return toGroupView(group);
}

// ── The permission grid ───────────────────────────────────────────────────────

/** Every user and group, every project and every role binding: the data behind Settings → Permissions. */
export async function getProjectAccessGrid(db: DrizzleDB): Promise<ProjectAccessGrid> {
  const [userRows, groupRows, projectRows, bindings, groupIdsByUser] = await Promise.all([
    db.select({ id: users.id, username: users.username, name: users.name, role: users.role }).from(users),
    listGroupItems(db),
    db.select({ id: projects.id, name: projects.name, label: projects.label }).from(projects),
    listRoleBindings(db),
    getGroupIdsByUser(db),
  ]);
  return {
    users: sortProjectAccessUsers(
      userRows.map((user) => ({
        id: user.id,
        username: user.username,
        name: user.name,
        instanceRole: instanceRoleOf(user.role),
        groupIds: groupIdsByUser.get(user.id) ?? [],
      })),
    ),
    groups: sortProjectAccessGroups(groupRows),
    projects: sortProjectAccessProjects(projectRows),
    bindings: bindings.map(toBindingView),
  };
}

/** Every binding of one subject. */
async function getSubjectBindings(db: DrizzleDB, subject: AccessSubject): Promise<RoleBindingView[]> {
  const filter = subject.type === 'user' ? { userId: subject.id } : { groupId: subject.id };
  return (await listRoleBindings(db, filter)).map(toBindingView);
}

/**
 * Set one cell of the grid: give the subject a role on a project, or on all
 * projects, or remove its binding there (null role). Idempotent. Returns the
 * subject's bindings after the change.
 */
export async function setProjectAccessCell(
  db: DrizzleDB,
  update: ProjectAccessUpdate,
  createdBy: number | null,
): Promise<RoleBindingView[]> {
  await requireBindableSubject(db, update.subject);
  if (update.projectId !== null) await requireProject(db, update.projectId);
  await setRoleBinding(db, {
    subject: bindingSubject(update.subject),
    projectId: update.projectId,
    role: update.role,
    createdBy,
  });
  return getSubjectBindings(db, update.subject);
}

// ── A project's members ───────────────────────────────────────────────────────

/** Every role held on a project, one row per role and source. */
export async function getProjectMemberViews(db: DrizzleDB, projectId: number): Promise<ProjectMemberView[]> {
  const members = await getProjectMembers(db, projectId);
  const rows: ProjectMemberView[] = [];
  for (const group of members.groups) {
    for (const grant of group.grants) {
      rows.push({
        subject: { type: 'group', id: group.id },
        username: null,
        name: group.name,
        role: grant.role,
        source: grant.source.via === 'project' ? 'direct' : 'all-projects',
      });
    }
  }
  for (const user of members.users) {
    const base = {
      subject: { type: 'user', id: user.id } as const,
      username: user.username,
      name: user.name || user.username,
    };
    if (user.administrator) {
      rows.push({ ...base, role: ProjectRole.PROJECT_ADMIN, source: 'administrator' });
      continue;
    }
    for (const { role, source } of user.grants) {
      if (source.via === 'group') {
        rows.push({ ...base, role, source: 'group', groupId: source.groupId, groupName: source.groupName });
      } else {
        rows.push({ ...base, role, source: source.via === 'project' ? 'direct' : 'all-projects' });
      }
    }
  }
  return sortProjectMembers(rows);
}

/** `GET /api/projects/{id}/members` for the caller holding `access`. 404 for an unknown project. */
export async function getProjectMembersResponse(
  db: DrizzleDB,
  projectId: number,
  access: AccessSummary,
): Promise<ProjectMembersResponse> {
  await requireProject(db, projectId);
  return {
    members: await getProjectMemberViews(db, projectId),
    canManage: can(access, 'project:members', projectId),
    grantableRoles: grantableProjectRoles(access, projectId),
  };
}

/**
 * Replace the project's direct bindings (not the all-projects ones) with
 * `entries`; a subject listed twice keeps its last role. An administrator may
 * set any; anyone else only grants, changes and removes the roles
 * `canGrantRole` lets them grant with the roles they hold on this project
 * (403 otherwise). 404 for an unknown project, 400 for an unknown user or
 * group, or for an administrator, who needs no binding.
 */
export async function replaceProjectMembers(
  db: DrizzleDB,
  projectId: number,
  entries: ProjectMembersUpdate['entries'],
  granter: { userId: number | null; access: AccessSummary },
): Promise<void> {
  await requireProject(db, projectId);
  const bySubject = new Map(entries.map((entry) => [accessSubjectKey(entry.subject), entry]));
  const wanted = [...bySubject.values()];

  const userIds = wanted.filter((e) => e.subject.type === 'user').map((e) => e.subject.id);
  if (userIds.length > 0) {
    const found = await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, userIds));
    const foundIds = new Set(found.map((row) => row.id));
    const missing = userIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) throw new AccessError(400, `User(s) not found: ${missing.join(', ')}`);
    if (found.some((row) => row.role === InstanceRole.ADMINISTRATOR)) {
      throw new AccessError(400, ADMINISTRATOR_OPENS_EVERYTHING);
    }
  }
  const groupIds = wanted.filter((e) => e.subject.type === 'group').map((e) => e.subject.id);
  if (groupIds.length > 0) await assertGroupsExist(db, groupIds);

  if (!isAdministrator(granter.access)) {
    const granterRoles = projectRolesOf(granter.access, projectId);
    const current = new Map(
      (await listRoleBindings(db, { projectId })).map((b) => [
        accessSubjectKey({ type: b.subject.kind, id: b.subject.id }),
        b.role,
      ]),
    );
    // Every role this call grants, changes away from or removes.
    const touched: ProjectRole[] = [];
    for (const [key, entry] of bySubject) {
      const before = current.get(key);
      if (before === entry.role) continue;
      touched.push(entry.role);
      if (before) touched.push(before);
    }
    for (const [key, role] of current) if (!bySubject.has(key)) touched.push(role);
    const refused = touched.find((role) => !canGrantRole(granterRoles, role));
    if (refused) {
      throw new AccessError(403, `You cannot grant or remove the ${PROJECT_ROLE_LABELS[refused]} role on this project`);
    }
  }

  await replaceProjectBindings(
    db,
    projectId,
    wanted.map((entry) => ({ subject: bindingSubject(entry.subject), role: entry.role })),
    granter.userId || null,
  );
}
