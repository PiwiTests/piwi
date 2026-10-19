import type { AuthUser, AuthState } from '~~/types/api';
import {
  InstanceRole,
  can as accessCan,
  holdsAnywhere,
  type AccessSummary,
  type Permission,
} from '#shared/permissions';
import {
  DEMO_USERS,
  DEFAULT_DEMO_USER_ID,
  DEMO_USER_STORAGE_KEY,
  demoAccessFor,
  findDemoUser,
} from '~/demo/demo-users';

export { type AuthUser, type AuthState };

/** Build the auth state for a demo identity id (used by the "act as" switcher). */
function demoStateFor(id: number): AuthState {
  const u = findDemoUser(id);
  return {
    authenticated: true,
    user: { id: u.id, username: u.username, role: u.instanceRole, name: u.name, access: demoAccessFor(u.id) },
  };
}

function readSelectedDemoUserId(): number {
  if (!import.meta.client) return DEFAULT_DEMO_USER_ID;
  const stored = Number(localStorage.getItem(DEMO_USER_STORAGE_KEY));
  return DEMO_USERS.some((u) => u.id === stored) ? stored : DEFAULT_DEMO_USER_ID;
}

/** A project id as pages and props hold it (a route param is a string); anything else is no project. */
function toProjectId(projectId: number | string | null | undefined): number | undefined {
  if (projectId === null || projectId === undefined || projectId === '') return undefined;
  const id = Number(projectId);
  return Number.isInteger(id) ? id : undefined;
}

export const useAuth = () => {
  const config = useRuntimeConfig();

  const authState = useState<AuthState>('auth', () => {
    if (config.public.demoMode) {
      return demoStateFor(readSelectedDemoUserId());
    }
    return { authenticated: false, user: null };
  });

  // Demo: the list of identities the "act as" switcher can pick from, and the
  // currently selected one.
  const demoUsers = DEMO_USERS;
  const currentDemoUserId = computed(() => authState.value.user?.id ?? DEFAULT_DEMO_USER_ID);

  /**
   * Switch the active demo identity.  Persists the choice and reloads so every
   * `useFetch`/SW-scoped request re-runs under the new identity (the demo
   * service worker applies that identity's access).
   */
  const setDemoUser = (id: number) => {
    if (!config.public.demoMode || !import.meta.client) return;
    localStorage.setItem(DEMO_USER_STORAGE_KEY, String(id));
    authState.value = demoStateFor(id);
    window.location.reload();
  };

  /**
   * Demo: take the active persona's access from the demo `/api/auth/me`, which
   * reads the in-browser database, so a role changed on the permission grid, in
   * a project's members or in a group shows at once. The seeded access stands in
   * until it answers, and stays when it fails. Does nothing outside the demo.
   */
  const refreshDemoAccess = async () => {
    if (!config.public.demoMode || !import.meta.client) return;
    try {
      const data = await $fetch<AuthState>('/api/auth/me');
      const user = authState.value.user;
      if (!data.authenticated || !data.user || !user || data.user.id !== user.id) return;
      authState.value = { authenticated: true, user: { ...user, role: data.user.role, access: data.user.access } };
    } catch {
      // Keep the seeded access.
    }
  };

  const fetchUser = async (): Promise<AuthState> => {
    if (config.public.demoMode) {
      const state = demoStateFor(readSelectedDemoUserId());
      authState.value = state;
      return state;
    }
    try {
      // During SSR, $fetch doesn't forward the browser's cookie header automatically.
      // useRequestHeaders forwards it so the session can be read server-side.
      const headers = import.meta.server ? useRequestHeaders(['cookie']) : {};
      const data = await $fetch<AuthState>('/api/auth/me', { headers });
      authState.value = data;
      return data;
    } catch {
      authState.value = { authenticated: false, user: null };
      return { authenticated: false, user: null };
    }
  };

  const login = async (username: string, password: string) => {
    const data = await $fetch<{ success: boolean; user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });

    if (data.success && data.user) {
      authState.value = {
        authenticated: true,
        user: data.user,
      };
    }

    return data;
  };

  const logout = async () => {
    await $fetch('/api/auth/logout', {
      method: 'POST',
    });
    clearApiConsoleToken();

    authState.value = {
      authenticated: false,
      user: null,
    };

    await navigateTo('/login');
  };

  /** The signed-in user's instance role and project roles, as `/api/auth/me` returns them. */
  const access = computed<AccessSummary | null>(() => authState.value.user?.access ?? null);

  /** Whether the signed-in user is an instance administrator. */
  const isAdmin = computed(() => authState.value.user?.role === InstanceRole.ADMINISTRATOR);

  /**
   * Whether the viewer holds `permission`: a project permission on `projectId`
   * (a route param string is accepted), an instance permission anywhere. A
   * project permission asked without a project is refused to a member; use
   * `canAnywhere` when no project is in context.
   *
   * True for everyone when authentication is disabled: there are no users then
   * (the default self-hosted install, the desktop build), and the server treats
   * every request as a virtual administrator. A UI affordance only, to hide or
   * disable a control; the server checks each route's `x-required-permission`.
   */
  const can = (permission: Permission, projectId?: number | string | null): boolean => {
    if (!config.public.authEnabled) return true;
    const summary = access.value;
    return summary !== null && accessCan(summary, permission, toProjectId(projectId));
  };

  /**
   * Whether the viewer holds `permission` on at least one project (or is an
   * administrator), for a control with no project in context, such as a
   * cross-project list. True for everyone when authentication is disabled, like
   * `can`.
   */
  const canAnywhere = (permission: Permission): boolean => {
    if (!config.public.authEnabled) return true;
    const summary = access.value;
    return summary !== null && holdsAnywhere(summary, permission);
  };

  /**
   * Whether admin-only surfaces should be shown (the instance permissions:
   * users, settings, storage, Setup).
   *
   * Differs from `isAdmin` in one case that matters: when authentication is
   * disabled there are no users at all, so nobody holds the administrator role
   * and gating on `isAdmin` alone would hide admin surfaces from *everyone* on
   * a default self-hosted install (and in the desktop build, which runs
   * single-user with auth off). The server draws the same distinction:
   * `requireAuth` returns a virtual administrator when auth is disabled.
   *
   * This is a UI affordance, never an authorization decision: the server still
   * checks each route's `x-required-permission`.
   */
  const canSeeAdmin = computed(() => !config.public.authEnabled || isAdmin.value);

  return {
    authState,
    fetchUser,
    login,
    logout,
    access,
    isAdmin,
    can,
    canAnywhere,
    canSeeAdmin,
    // Demo "act as" switcher
    demoUsers,
    currentDemoUserId,
    setDemoUser,
    refreshDemoAccess,
  };
};
