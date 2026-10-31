/**
 * Access management: the request and response shapes of the users, groups,
 * permission grid and project members routes, and the permission grid's data
 * model. Pure — shared by the server routes, the demo mirror, and the Settings
 * → Users, Groups and Permissions pages and the project Members panel.
 *
 * Access is stored as role bindings (`#shared/handlers/role-bindings`): a user
 * or a group holds one project role on one project, or on all projects,
 * current and future (`projectId` null). A user also holds every role their
 * groups hold. Administrators open every project without any binding. The
 * roles and what they grant are in `#shared/permissions`.
 */
import { foldText } from '#shared/utils/fold-text';
import {
  canGrantRole,
  InstanceRole,
  isAdministrator,
  isLegacyRole,
  PROJECT_ROLES,
  projectRolesOf,
  type AccessSummary,
  type LegacyRole,
  type ProjectRole,
} from '#shared/permissions';

// ── Subjects ──────────────────────────────────────────────────────────────────

export type AccessSubjectType = 'user' | 'group';

/** Who a role binding is for. */
export interface AccessSubject {
  type: AccessSubjectType;
  id: number;
}

/** A stable key for a subject (`user:3`, `group:1`). */
export function accessSubjectKey(subject: AccessSubject): string {
  return `${subject.type}:${subject.id}`;
}

export function sameAccessSubject(a: AccessSubject, b: AccessSubject): boolean {
  return a.type === b.type && a.id === b.id;
}

/** One role binding as the API returns it; `projectId` null is all projects. */
export interface RoleBindingView {
  subject: AccessSubject;
  projectId: number | null;
  role: ProjectRole;
}

// ── Users (`/api/users`) ──────────────────────────────────────────────────────

/** A user as administrators see them (`users:manage`). */
export interface UserListItem {
  id: number;
  username: string;
  name: string | null;
  /** The stored instance role (`users.role`). */
  role: string;
  instanceRole: InstanceRole;
  /** The groups the user belongs to, ascending. */
  groupIds: number[];
  email: string | null;
  emailVerified: boolean;
  oauthProvider: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A user as a project admin sees them, to add them to a project. */
export interface UserSummary {
  id: number;
  username: string;
  name: string | null;
}

/** `GET /api/users`: the full rows for administrators, the summaries for project admins. */
export interface UsersListResponse {
  items: UserListItem[] | UserSummary[];
  authEnabled: boolean;
}

/** `PATCH /api/users/{id}`. `role` and `groupIds` are for administrators only. */
export interface UpdateUserRequest {
  name?: string | null;
  email?: string | null;
  role?: InstanceRole;
  groupIds?: number[];
}

/** `POST /api/users` and `PATCH /api/users/{id}`. */
export interface UserWriteResponse {
  success: true;
  user: UserListItem;
}

/** The instance role a create request asks for, a legacy role counting as a member. */
export function requestedInstanceRole(role: InstanceRole | LegacyRole): InstanceRole {
  return isLegacyRole(role) ? InstanceRole.MEMBER : role;
}

/** A user's own role bindings: `PUT /api/users/{id}/projects` takes it as is. */
export interface UserProjectRoles {
  /** The role held on all projects, null for none. */
  allProjects: ProjectRole | null;
  /** The roles held on one project each, by project id. */
  projects: { projectId: number; role: ProjectRole }[];
}

/** `GET /api/users/{id}/projects`: the user's own bindings and the groups that add to them. */
export interface UserProjectRolesResponse extends UserProjectRoles {
  groups: { id: number; name: string }[];
}

// ── Groups (`/api/groups`) ────────────────────────────────────────────────────

export interface GroupListItem {
  id: number;
  name: string;
  description: string | null;
  memberCount: number;
}

export interface GroupMemberItem {
  id: number;
  username: string;
  name: string | null;
}

/** `GET /api/groups/{id}`, and what the group writes return. */
export interface GroupView extends GroupListItem {
  members: GroupMemberItem[];
}

/** `GET /api/groups`. */
export interface GroupsListResponse {
  groups: GroupListItem[];
}

/** `POST`, `PATCH /api/groups/{id}` and `PUT /api/groups/{id}/members`. */
export interface GroupWriteResponse {
  success: true;
  group: GroupView;
}

// ── The permission grid (`/api/project-access`) ───────────────────────────────

/** One user's row on the permission grid. */
export interface ProjectAccessUser {
  id: number;
  username: string;
  name: string | null;
  instanceRole: InstanceRole;
  /** The groups the user belongs to, ascending. */
  groupIds: number[];
}

/** One column of the permission grid. */
export interface ProjectAccessProject {
  id: number;
  name: string;
  label: string | null;
}

/** Every user and group, every project, and every role binding. */
export interface ProjectAccessGrid {
  users: ProjectAccessUser[];
  groups: GroupListItem[];
  projects: ProjectAccessProject[];
  bindings: RoleBindingView[];
}

/** `GET /api/project-access`. */
export interface ProjectAccessResponse extends ProjectAccessGrid {
  authEnabled: boolean;
}

/** `PUT /api/project-access`: one cell; a null role removes the binding. */
export interface ProjectAccessUpdate {
  subject: AccessSubject;
  projectId: number | null;
  role: ProjectRole | null;
}

/** `PUT /api/project-access`: every binding of the subject after the change. */
export interface ProjectAccessUpdateResponse {
  bindings: RoleBindingView[];
}

/** A role a subject holds on a cell from elsewhere than its own binding there. */
export interface InheritedRole {
  role: ProjectRole;
  /** `all-projects`: the subject's own all-projects binding; `group`: a binding of one of the user's groups. */
  source: 'all-projects' | 'group';
  groupId?: number;
  groupName?: string;
}

/**
 * How one cell reads: `role` is the subject's own binding there (what the
 * cell's selector edits), `inherited` the roles it holds there anyway, and
 * `admin` an administrator, who opens every project and is not editable.
 */
export interface ProjectAccessCellState {
  role: ProjectRole | null;
  inherited: InheritedRole[];
  admin: boolean;
}

/** The grid's bindings by subject and scope (`null` for all projects). */
export type ProjectAccessBindingIndex = Map<string, Map<number | null, ProjectRole>>;

export function indexProjectAccessBindings(bindings: readonly RoleBindingView[]): ProjectAccessBindingIndex {
  const index: ProjectAccessBindingIndex = new Map();
  for (const binding of bindings) {
    const key = accessSubjectKey(binding.subject);
    let scopes = index.get(key);
    if (!scopes) index.set(key, (scopes = new Map()));
    scopes.set(binding.projectId, binding.role);
  }
  return index;
}

/** The role a subject's own binding gives it on `projectId` (null: on all projects). */
export function boundRole(
  index: ProjectAccessBindingIndex,
  subject: AccessSubject,
  projectId: number | null,
): ProjectRole | null {
  return index.get(accessSubjectKey(subject))?.get(projectId) ?? null;
}

/**
 * The state of the cell of `subject` for `projectId`, or for all projects when
 * it is null. Pass an index built once when reading many cells.
 */
export function projectAccessCellState(
  grid: Pick<ProjectAccessGrid, 'users' | 'groups' | 'bindings'>,
  subject: AccessSubject,
  projectId: number | null,
  index: ProjectAccessBindingIndex = indexProjectAccessBindings(grid.bindings),
): ProjectAccessCellState {
  const inherited: InheritedRole[] = [];
  const role = boundRole(index, subject, projectId);
  if (projectId !== null) {
    const allProjects = boundRole(index, subject, null);
    if (allProjects) inherited.push({ role: allProjects, source: 'all-projects' });
  }
  if (subject.type === 'group') return { role, inherited, admin: false };

  const user = grid.users.find((u) => u.id === subject.id);
  if (!user) return { role, inherited, admin: false };
  const groupsById = new Map(grid.groups.map((g) => [g.id, g]));
  for (const groupId of user.groupIds) {
    const group = groupsById.get(groupId);
    if (!group) continue;
    const groupSubject: AccessSubject = { type: 'group', id: groupId };
    const roles = [boundRole(index, groupSubject, projectId)];
    if (projectId !== null) roles.push(boundRole(index, groupSubject, null));
    for (const groupRole of roles) {
      if (groupRole) inherited.push({ role: groupRole, source: 'group', groupId, groupName: group.name });
    }
  }
  return { role, inherited, admin: user.instanceRole === InstanceRole.ADMINISTRATOR };
}

/** The bindings after setting one cell — the same change the server applies. */
export function withRoleBinding(bindings: readonly RoleBindingView[], update: ProjectAccessUpdate): RoleBindingView[] {
  const next = bindings.filter(
    (b) => !(sameAccessSubject(b.subject, update.subject) && b.projectId === update.projectId),
  );
  if (update.role !== null) next.push({ subject: update.subject, projectId: update.projectId, role: update.role });
  return next;
}

/** The bindings with the subject's replaced by `subjectBindings` (a `PUT /api/project-access` answer). */
export function withSubjectBindings(
  bindings: readonly RoleBindingView[],
  subject: AccessSubject,
  subjectBindings: readonly RoleBindingView[],
): RoleBindingView[] {
  return [...bindings.filter((b) => !sameAccessSubject(b.subject, subject)), ...subjectBindings];
}

/** A stable key for one cell; `projectId` null is the all-projects cell. */
export function projectAccessCellKey(subject: AccessSubject, projectId: number | null): string {
  return `${accessSubjectKey(subject)}:${projectId ?? 'all'}`;
}

// ── Names and order ───────────────────────────────────────────────────────────

/** The name shown for a user. */
export function projectAccessUserName(user: Pick<ProjectAccessUser, 'name' | 'username'>): string {
  return user.name || user.username;
}

/** The name shown for a project. */
export function projectAccessProjectName(project: Pick<ProjectAccessProject, 'name' | 'label'>): string {
  return project.label || project.name;
}

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Users sorted by the name shown. */
export function sortProjectAccessUsers<T extends Pick<ProjectAccessUser, 'id' | 'name' | 'username'>>(users: T[]): T[] {
  return [...users].sort((a, b) => byText(projectAccessUserName(a), projectAccessUserName(b)) || a.id - b.id);
}

/** Groups sorted by name. */
export function sortProjectAccessGroups<T extends Pick<GroupListItem, 'id' | 'name'>>(groups: T[]): T[] {
  return [...groups].sort((a, b) => byText(a.name, b.name) || a.id - b.id);
}

/** Projects sorted by the name shown. */
export function sortProjectAccessProjects<T extends ProjectAccessProject>(projects: T[]): T[] {
  return [...projects].sort((a, b) => byText(projectAccessProjectName(a), projectAccessProjectName(b)) || a.id - b.id);
}

/** One row of the grid: a group or a user. */
export type ProjectAccessRow =
  | { subject: AccessSubject & { type: 'group' }; name: string; group: GroupListItem }
  | { subject: AccessSubject & { type: 'user' }; name: string; user: ProjectAccessUser };

/** The grid's rows: groups first, by name, then users, by the name shown. */
export function projectAccessRows(grid: Pick<ProjectAccessGrid, 'users' | 'groups'>): ProjectAccessRow[] {
  return [
    ...sortProjectAccessGroups(grid.groups).map((group) => ({
      subject: { type: 'group' as const, id: group.id },
      name: group.name,
      group,
    })),
    ...sortProjectAccessUsers(grid.users).map((user) => ({
      subject: { type: 'user' as const, id: user.id },
      name: projectAccessUserName(user),
      user,
    })),
  ];
}

/** `query` in any of `fields`, ignoring case and accents; an empty query matches everything. */
export function matchesProjectAccessQuery(query: string, fields: (string | null | undefined)[]): boolean {
  const needle = foldText(query.trim());
  if (!needle) return true;
  return fields.some((field) => field != null && foldText(field).includes(needle));
}

// ── A project's members (`/api/projects/{id}/members`) ────────────────────────

/**
 * Where a member's role on the project comes from: `direct`, a binding on this
 * project (what the members editor changes); `all-projects`, the subject's
 * binding on all projects; `group`, a binding of a group the user belongs to;
 * `administrator`, the instance role, which holds every permission.
 */
export type ProjectMemberSource = 'direct' | 'all-projects' | 'group' | 'administrator';

/** One role a user or a group holds on the project. A subject holding several has one row each. */
export interface ProjectMemberView {
  subject: AccessSubject;
  /** The user's username; null for a group. */
  username: string | null;
  /** The name shown: the user's name or username, or the group's name. */
  name: string;
  /** For an administrator, Project admin: it holds every project permission. */
  role: ProjectRole;
  source: ProjectMemberSource;
  /** The group the role comes through, for `source: 'group'`. */
  groupId?: number;
  groupName?: string;
}

/** `GET /api/projects/{id}/members`. */
export interface ProjectMembersResponse {
  members: ProjectMemberView[];
  /** Whether the caller may change the project's direct bindings. */
  canManage: boolean;
  /** The roles the caller may grant on this project. */
  grantableRoles: ProjectRole[];
}

/** `PUT /api/projects/{id}/members`: the project's direct bindings, replacing the current ones. */
/** A member to set: a user may carry the whole username a project admin found them by. */
export interface ProjectMemberSubject extends AccessSubject {
  username?: string;
}

export interface ProjectMembersUpdate {
  entries: { subject: ProjectMemberSubject; role: ProjectRole }[];
}

/** `PUT /api/projects/{id}/members`: the members after the change. */
export interface ProjectMembersUpdateResponse {
  success: true;
  members: ProjectMemberView[];
}

const SOURCE_ORDER: Record<ProjectMemberSource, number> = {
  direct: 0,
  'all-projects': 1,
  group: 2,
  administrator: 3,
};

/** Members in the order the panel lists them: groups, then users, by name; a subject's own binding first. */
export function sortProjectMembers<T extends ProjectMemberView>(members: T[]): T[] {
  return [...members].sort(
    (a, b) =>
      (a.subject.type === b.subject.type ? 0 : a.subject.type === 'group' ? -1 : 1) ||
      byText(a.name, b.name) ||
      a.subject.id - b.subject.id ||
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      byText(a.groupName ?? '', b.groupName ?? ''),
  );
}

/** The roles `access` may grant on a project: every role for an administrator, else those `canGrantRole` allows. */
export function grantableProjectRoles(access: AccessSummary, projectId: number): ProjectRole[] {
  if (isAdministrator(access)) return [...PROJECT_ROLES];
  const roles = projectRolesOf(access, projectId);
  return PROJECT_ROLES.filter((role) => canGrantRole(roles, role));
}

/** The direct bindings among `members`, as `PUT /api/projects/{id}/members` takes them. */
export function directProjectMemberEntries(members: readonly ProjectMemberView[]): ProjectMembersUpdate['entries'] {
  return members.filter((m) => m.source === 'direct').map((m) => ({ subject: m.subject, role: m.role }));
}
