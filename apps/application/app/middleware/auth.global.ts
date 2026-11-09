import { canOpenSettingsPath } from '~/utils/settings-metadata';

// Pages that must work without a session: signing in, and the account-recovery
// pages reached from emailed links.
const PUBLIC_PATHS = ['/login', '/forgot-password', '/reset-password'];

export default defineNuxtRouteMiddleware(async (to) => {
  if (PUBLIC_PATHS.includes(to.path)) {
    return;
  }

  const { authState, fetchUser, isAdmin, can, access } = useAuth();
  const config = useRuntimeConfig();

  // Check if auth is enabled
  if (!config.public.authEnabled) {
    return;
  }

  // Fetch user if not already loaded. The demo signs nobody in: its "act as"
  // identity is already in the auth state, and the guards below apply to it.
  if (!config.public.demoMode && !authState.value.authenticated) {
    const result = await fetchUser();

    if (!result.authenticated) {
      // Signing in comes back to the page asked for (`login.vue` reads `redirect`).
      return navigateTo(to.fullPath === '/' ? '/login' : { path: '/login', query: { redirect: to.fullPath } });
    }
  }

  // Edit pages: a project's needs `project:manage` on that project, any other
  // one an administrator.
  if (to.path.includes('/edit')) {
    const projectEdit = /^\/projects\/(\d+)\/edit\/?$/.exec(to.path);
    const allowed = projectEdit ? can('project:manage', projectEdit[1]) : isAdmin.value;
    if (!allowed) return navigateTo('/');
  }

  // Settings pages needing an instance permission (Users, Tags, Storage, AI,
  // the Setup pages…): the nav hides them, and this stops a direct URL
  // rendering a page whose every API call would 403. The server checks the
  // permission on those endpoints; `/settings` itself redirects to the first
  // page the viewer may open. Note the early returns above: with auth disabled
  // every visitor is a virtual admin, which keeps them reachable on a default
  // install.
  if (!canOpenSettingsPath(to.path, access.value)) {
    return navigateTo('/settings');
  }
});
