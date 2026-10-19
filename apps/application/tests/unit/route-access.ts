/**
 * Calling a route handler in a unit test as a caller with a given access,
 * held to the permission its meta declares, the way `requireAuth` and the
 * project access helpers hold a request to it (`#shared/permissions`).
 *
 * Wire it in with `vi.mock` and a `vi.hoisted` state:
 *
 *   const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
 *   vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
 *   vi.mock('../../server/utils/project-access', async (importOriginal) =>
 *     (await import('./route-access')).projectAccessMock(state, await importOriginal()));
 *   vi.stubGlobal('defineRouteMeta', (meta) => recordRouteMeta(state, meta));
 */
import type { User } from '../../server/database/schema';
import { apiError } from '../../server/utils/api-error';
import {
  can,
  passesEarlyCheck,
  passesProjectCheck,
  projectScopeFor,
  routePermissionList,
  type AccessSummary,
  type ProjectPermission,
  type RoutePermission,
} from '#shared/permissions';

export interface RouteCaller {
  user: User;
  access: AccessSummary;
}

export interface RouteAccessState {
  db: unknown;
  caller: RouteCaller | null;
  /** The permission of the route being called, from its `x-required-permission`. */
  routePermission: RoutePermission[];
}

/** The meta a route declared when its module was loaded. */
export function recordRouteMeta(
  state: Pick<RouteAccessState, 'routePermission'>,
  meta: { openAPI?: Record<string, unknown> },
): void {
  state.routePermission = routePermissionList(meta.openAPI?.['x-required-permission']);
}

/**
 * A route handler held to the permission its own meta declared, for a test
 * that loads several routes: pass the handler right after importing its module.
 */
export function underRoutePermission<H extends (...args: never[]) => unknown>(
  state: Pick<RouteAccessState, 'routePermission'>,
  handler: H,
): H {
  const permission = state.routePermission;
  return ((...args: Parameters<H>) => {
    state.routePermission = permission;
    return handler(...args);
  }) as H;
}

function caller(state: RouteAccessState): RouteCaller {
  if (!state.caller) throw apiError({ statusCode: 401, message: 'Authentication required' });
  return state.caller;
}

function required(state: RouteAccessState, permission?: RoutePermission | RoutePermission[]): RoutePermission[] {
  return permission === undefined ? state.routePermission : routePermissionList(permission);
}

async function requireAuth(state: RouteAccessState, permission?: RoutePermission | RoutePermission[]) {
  const { user, access } = caller(state);
  if (!passesEarlyCheck(access, required(state, permission))) {
    throw apiError({ statusCode: 403, message: 'Insufficient permissions' });
  }
  return user;
}

async function requireProjectAccess(
  state: RouteAccessState,
  projectId: number,
  permission?: RoutePermission | RoutePermission[],
) {
  const user = await requireAuth(state, permission);
  if (!passesProjectCheck(caller(state).access, required(state, permission), projectId)) {
    throw apiError({ statusCode: 403, message: 'No access to this project' });
  }
  return user;
}

export function authMock(state: RouteAccessState) {
  return {
    requireAuth: (_event: unknown, permission?: RoutePermission | RoutePermission[]) => requireAuth(state, permission),
    getRequestAccess: async () => caller(state).access,
    isAuthEnabled: () => true,
  };
}

export function projectAccessMock<T extends object>(state: RouteAccessState, original: T) {
  return {
    ...original,
    requireProjectAccess: (_event: unknown, projectId: number, permission?: RoutePermission | RoutePermission[]) =>
      requireProjectAccess(state, projectId, permission),
    requireResolvedProjectAccess: async (
      _event: unknown,
      id: number,
      resolve: (db: never, id: number) => Promise<number | null>,
      notFoundLabel: string,
      permission?: RoutePermission | RoutePermission[],
    ) => {
      const projectId = await resolve(state.db as never, id);
      if (!projectId) throw apiError({ statusCode: 404, message: `${notFoundLabel} not found` });
      const user = await requireProjectAccess(state, projectId, permission);
      return { db: state.db, projectId, user };
    },
    getProjectScope: async (_db: unknown, _user: unknown, permission: ProjectPermission = 'project:read') =>
      projectScopeFor(caller(state).access, permission),
    canAccessProject: async (
      _db: unknown,
      _user: unknown,
      projectId: number,
      permission: ProjectPermission = 'project:read',
    ) => can(caller(state).access, permission, projectId),
  };
}
