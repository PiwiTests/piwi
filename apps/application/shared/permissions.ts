/**
 * Authorization model: instance roles, project roles and the permissions each
 * one grants. Pure and dependency-free — shared by the server (`requireAuth`,
 * the project access helpers, the MCP tools), the demo mirror and the UI
 * (`useAuth().can`). The design record is `proposals/roles-and-groups.md`.
 *
 * - A **permission** is one action on one kind of resource (`issue:create`).
 *   Every route declares the one it needs in its `x-required-permission` meta.
 * - An **instance role** is stored on the user: `administrator` holds every
 *   permission everywhere, `member` holds none by itself.
 * - A **project role** is held through a **role binding**: a user or a group
 *   holds it on one project, or on all projects (current and future). A user's
 *   permissions on a project are the union of every role they hold there,
 *   directly or through their groups. There are no deny rules.
 */

// ── Roles ─────────────────────────────────────────────────────────────────────

/** The role a user holds on the whole instance, stored in `users.role`. */
export enum InstanceRole {
  ADMINISTRATOR = 'administrator',
  MEMBER = 'member',
}

/** A role held on projects through a role binding, stored in `role_bindings.role`. */
export enum ProjectRole {
  VIEWER = 'viewer',
  CONTRIBUTOR = 'contributor',
  MAINTAINER = 'maintainer',
  PROJECT_ADMIN = 'project_admin',
  UPLOADER = 'uploader',
}

/** Every project role, in the order the UI lists them. */
export const PROJECT_ROLES: readonly ProjectRole[] = [
  ProjectRole.VIEWER,
  ProjectRole.CONTRIBUTOR,
  ProjectRole.MAINTAINER,
  ProjectRole.PROJECT_ADMIN,
  ProjectRole.UPLOADER,
];

/** The name the UI shows for each role. */
export const INSTANCE_ROLE_LABELS: Record<InstanceRole, string> = {
  [InstanceRole.ADMINISTRATOR]: 'Administrator',
  [InstanceRole.MEMBER]: 'Member',
};

export const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = {
  [ProjectRole.VIEWER]: 'Viewer',
  [ProjectRole.CONTRIBUTOR]: 'Contributor',
  [ProjectRole.MAINTAINER]: 'Maintainer',
  [ProjectRole.PROJECT_ADMIN]: 'Project admin',
  [ProjectRole.UPLOADER]: 'Uploader',
};

/** One line on what each project role is for, shown next to the role selectors. */
export const PROJECT_ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  [ProjectRole.VIEWER]: 'Reads everything in the project.',
  [ProjectRole.CONTRIBUTOR]: 'Files issues, pins links, edits bug reports, schedules reports, adds markers.',
  [ProjectRole.MAINTAINER]:
    'Triages failures, quarantines tests, runs AI diagnosis, uploads runs, creates share links.',
  [ProjectRole.PROJECT_ADMIN]: 'Edits the project settings and members, deletes runs.',
  [ProjectRole.UPLOADER]: 'For CI: reads the project and uploads runs, nothing else.',
};

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);
}

// ── Permissions ───────────────────────────────────────────────────────────────

/** Permissions checked on one project. Held through project roles. */
export const PROJECT_PERMISSIONS = [
  'project:read',
  'issue:create',
  'link:write',
  'bug-report:write',
  'report:write',
  'marker:write',
  'share:create',
  'triage:write',
  'quarantine:write',
  'ai:run',
  'run:control',
  'test-assets:write',
  'run:submit',
  'project:manage',
  'project:members',
  'run:delete',
] as const;

/** Permissions on the whole instance. Only an administrator holds them. */
export const INSTANCE_PERMISSIONS = [
  'users:manage',
  'groups:manage',
  'settings:manage',
  'connections:manage',
  'storage:manage',
  'tags:manage',
  'project:create',
  'project:delete',
] as const;

export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];
export type InstancePermission = (typeof INSTANCE_PERMISSIONS)[number];
export type Permission = ProjectPermission | InstancePermission;

/**
 * What a route's `x-required-permission` meta may hold: a permission, several
 * (any one of them is enough), or `signed-in` for a route any signed-in user
 * may call (their own profile, API keys, dashboards, channels, subscriptions).
 * A route with no meta value is public or authenticated by a token of its own.
 */
export const SIGNED_IN = 'signed-in';
export type RoutePermission = Permission | typeof SIGNED_IN;

/**
 * What each permission lets someone do, in plain words: the rows of
 * Settings → Roles and of the matrix in `apps/docs/operate/project-access.md`
 * (a unit test keeps the docs table equal to these labels and to `ROLE_PERMISSIONS`).
 */
export const PERMISSION_LABELS: Record<Permission, string> = {
  'project:read': 'Read runs, executions, clusters, analytics',
  'issue:create': 'File a Jira issue',
  'link:write': 'Pin, edit and remove links',
  'bug-report:write': 'Edit a bug report',
  'report:write': 'Save and schedule reports',
  'marker:write': 'Add and edit timeline markers',
  'share:create': 'Create share links, share a dashboard',
  'triage:write': 'Triage clusters and gaps',
  'quarantine:write': 'Quarantine and release tests',
  'ai:run': 'Run AI diagnosis (spends tokens)',
  'run:control': 'Re-run in CI, bisect, Flake Lab, fix attempts',
  'test-assets:write': 'Edit selections and test functions',
  'run:submit': 'Upload runs',
  'project:manage': 'Edit project settings and Jira binding',
  'project:members': "Manage the project's members",
  'run:delete': 'Delete runs, release kept runs',
  'users:manage': 'Manage users and their roles',
  'groups:manage': 'Manage groups',
  'settings:manage': 'Change instance settings (AI, email, analysis)',
  'connections:manage': 'Manage issue tracker connections',
  'storage:manage': 'Manage storage, cleanup and imports',
  'tags:manage': 'Manage tags',
  'project:create': 'Create projects',
  'project:delete': 'Delete projects',
};

export function isProjectPermission(value: unknown): value is ProjectPermission {
  return typeof value === 'string' && (PROJECT_PERMISSIONS as readonly string[]).includes(value);
}

export function isInstancePermission(value: unknown): value is InstancePermission {
  return typeof value === 'string' && (INSTANCE_PERMISSIONS as readonly string[]).includes(value);
}

export function isRoutePermission(value: unknown): value is RoutePermission {
  return value === SIGNED_IN || isProjectPermission(value) || isInstancePermission(value);
}

const VIEWER_PERMISSIONS: readonly ProjectPermission[] = ['project:read'];
const CONTRIBUTOR_PERMISSIONS: readonly ProjectPermission[] = [
  ...VIEWER_PERMISSIONS,
  'issue:create',
  'link:write',
  'bug-report:write',
  'report:write',
  'marker:write',
];
const MAINTAINER_PERMISSIONS: readonly ProjectPermission[] = [
  ...CONTRIBUTOR_PERMISSIONS,
  'share:create',
  'triage:write',
  'quarantine:write',
  'ai:run',
  'run:control',
  'test-assets:write',
  'run:submit',
];
const PROJECT_ADMIN_PERMISSIONS: readonly ProjectPermission[] = [
  ...MAINTAINER_PERMISSIONS,
  'project:manage',
  'project:members',
  'run:delete',
];

/** The permission matrix of `proposals/roles-and-groups.md` §4.3. */
export const ROLE_PERMISSIONS: Record<ProjectRole, readonly ProjectPermission[]> = {
  [ProjectRole.VIEWER]: VIEWER_PERMISSIONS,
  [ProjectRole.CONTRIBUTOR]: CONTRIBUTOR_PERMISSIONS,
  [ProjectRole.MAINTAINER]: MAINTAINER_PERMISSIONS,
  [ProjectRole.PROJECT_ADMIN]: PROJECT_ADMIN_PERMISSIONS,
  [ProjectRole.UPLOADER]: ['project:read', 'run:submit'],
};

export function roleGrants(role: ProjectRole, permission: ProjectPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** The project roles that grant a permission, in `PROJECT_ROLES` order. */
export function rolesGranting(permission: ProjectPermission): ProjectRole[] {
  return PROJECT_ROLES.filter((role) => roleGrants(role, permission));
}

/**
 * Whether `granter` may hand `role` to someone else on a project: a project
 * admin may grant any project role up to their own; nobody else may grant.
 * Administrators are not subject to this check.
 */
export function canGrantRole(granterRoles: readonly ProjectRole[], role: ProjectRole): boolean {
  if (!granterRoles.includes(ProjectRole.PROJECT_ADMIN)) return false;
  return isProjectRole(role);
}

// ── A user's access ───────────────────────────────────────────────────────────

/**
 * Everything needed to authorize a user, loaded once per request on the server
 * and returned by `/api/auth/me` for the UI.
 *
 * `allProjects` holds the roles granted on all projects (own bindings and
 * group bindings with no project); `projects` the roles granted on one project
 * only, keyed by project id. A project's roles are the union of both.
 */
export interface AccessSummary {
  instanceRole: InstanceRole;
  allProjects: ProjectRole[];
  projects: Record<number, ProjectRole[]>;
}

/** The access of an administrator, and of everyone when authentication is off. */
export const ADMIN_ACCESS: AccessSummary = Object.freeze({
  instanceRole: InstanceRole.ADMINISTRATOR,
  allProjects: [],
  projects: {},
}) as AccessSummary;

/** One role binding row, as read for building an `AccessSummary`. */
export interface RoleBindingGrant {
  projectId: number | null;
  role: ProjectRole;
}

/** Fold a user's role bindings (own and through groups) into an `AccessSummary`. */
export function buildAccessSummary(instanceRole: InstanceRole, grants: readonly RoleBindingGrant[]): AccessSummary {
  const allProjects = new Set<ProjectRole>();
  const projects: Record<number, ProjectRole[]> = {};
  for (const grant of grants) {
    if (!isProjectRole(grant.role)) continue;
    if (grant.projectId === null) {
      allProjects.add(grant.role);
      continue;
    }
    const roles = (projects[grant.projectId] ??= []);
    if (!roles.includes(grant.role)) roles.push(grant.role);
  }
  return { instanceRole, allProjects: [...allProjects], projects };
}

export function isAdministrator(access: AccessSummary): boolean {
  return access.instanceRole === InstanceRole.ADMINISTRATOR;
}

/** Every project role the user holds on one project (union of all-projects and that project's roles). */
export function projectRolesOf(access: AccessSummary, projectId: number): ProjectRole[] {
  const own = access.projects[projectId] ?? [];
  return [...new Set([...access.allProjects, ...own])];
}

/**
 * Whether the user holds a permission: an instance permission anywhere, a
 * project permission on `projectId`. A project permission asked without a
 * project id is never granted to a member — use `holdsAnywhere` for that.
 */
export function can(access: AccessSummary, permission: Permission, projectId?: number): boolean {
  if (isAdministrator(access)) return true;
  if (!isProjectPermission(permission) || projectId === undefined) return false;
  return projectRolesOf(access, projectId).some((role) => roleGrants(role, permission));
}

/** Whether the user holds a permission on at least one project (or is an administrator). */
export function holdsAnywhere(access: AccessSummary, permission: Permission): boolean {
  if (isAdministrator(access)) return true;
  if (!isProjectPermission(permission)) return false;
  if (access.allProjects.some((role) => roleGrants(role, permission))) return true;
  return Object.values(access.projects).some((roles) => roles.some((role) => roleGrants(role, permission)));
}

/**
 * The projects on which the user holds a permission: `'all'` (administrator,
 * or granted on all projects) or the set of project ids. Same shape as the
 * server's `ProjectScope`, so list handlers keep taking it unchanged.
 */
export function projectScopeFor(access: AccessSummary, permission: ProjectPermission): 'all' | Set<number> {
  if (isAdministrator(access)) return 'all';
  if (access.allProjects.some((role) => roleGrants(role, permission))) return 'all';
  const ids = new Set<number>();
  for (const [id, roles] of Object.entries(access.projects)) {
    if (roles.some((role) => roleGrants(role, permission))) ids.add(Number(id));
  }
  return ids;
}

// ── Route requirements ────────────────────────────────────────────────────────

/** Normalize a route's `x-required-permission` meta value to a list (empty = public / token). */
export function routePermissionList(value: unknown): RoutePermission[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list.filter(isRoutePermission);
}

/**
 * The early check `requireAuth` applies before the handler runs:
 * - `signed-in` passes for any signed-in user;
 * - an instance permission needs an administrator;
 * - `project:read` passes for any signed-in user, because which projects they
 *   read is decided by the project scope (a member with no binding sees an
 *   empty dashboard, not an error);
 * - any other project permission needs it on at least one project. The real
 *   decision is made per project by `requireProjectAccess`.
 * With several permissions, any one passing is enough.
 */
export function passesEarlyCheck(access: AccessSummary, required: readonly RoutePermission[]): boolean {
  if (required.length === 0) return true;
  return required.some((permission) => {
    if (permission === SIGNED_IN || permission === 'project:read') return true;
    return holdsAnywhere(access, permission);
  });
}

/** Whether the user holds one of `required` on `projectId` (`signed-in` counts as `project:read` there). */
export function passesProjectCheck(
  access: AccessSummary,
  required: readonly RoutePermission[],
  projectId: number,
): boolean {
  const list = required.length === 0 ? (['project:read'] as const) : required;
  return list.some((permission) => can(access, permission === SIGNED_IN ? 'project:read' : permission, projectId));
}

// ── The roles of earlier versions ─────────────────────────────────────────────

/**
 * An instance role of an earlier version, which `POST /api/users` still
 * accepts: the account is created as a member.
 */
export type LegacyRole = 'reporter' | 'user';

export function isLegacyRole(value: unknown): value is LegacyRole {
  return value === 'reporter' || value === 'user';
}
