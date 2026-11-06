import { errorMessage } from '~/utils';
import { MAX_BROWSER_STARS, parseStarredIds, STARRED_PROJECTS_STATE } from '~/utils/project-stars';

/** The cookie that keeps a browser's stars while sign-in is off. */
const STARS_COOKIE = 'piwi-starred-projects';
const ONE_YEAR_S = 60 * 60 * 24 * 365;

/**
 * The cookie values this tab wrote whose change events have not come back yet.
 * A change event that echoes one is this tab's own write and is skipped; any
 * other value comes from another tab.
 */
const ownCookieWrites: string[] = [];
/** Whether this tab follows the cookie's changes: once, so each change event is read once. */
let followingCookie = false;

/**
 * The projects the viewer starred, which lead the sidebar, Home's Project
 * health and the command palette's projects. A star changes order only.
 *
 * With sign-in on, the stars are the user's, kept on the server
 * (`/api/projects/stars`) and the same in every browser. With sign-in off there
 * is no user to keep them on, so this browser keeps them, in a cookie the
 * server render reads too: the sidebar renders in its starred order at once,
 * and every tab of the browser sees the same stars.
 */
export function useStarredProjects() {
  const config = useRuntimeConfig();
  const nuxtApp = useNuxtApp();
  const { authState } = useAuth();
  const toast = useToast();
  const requestFetch = useRequestFetch();

  const onServer = !!config.public.authEnabled;
  const cookie = onServer ? null : useCookie<unknown>(STARS_COOKIE, { maxAge: ONE_YEAR_S, sameSite: 'lax' });

  // The stars, one list for every component of the page: the signed-in user's, or this browser's cookie.
  const list = useState<number[]>(STARRED_PROJECTS_STATE, () => (cookie ? parseStarredIds(cookie.value) : []));
  // Whether the signed-in user's stars were read; a server render that could not read them leaves it false.
  const loaded = useState('starred-projects-loaded', () => false);
  // Counts this page's loads, so an older answer never replaces a newer one.
  const loads = useState('starred-projects-loads', () => 0);
  // The stars a request is changing, with the state each asks for.
  const pending = useState<Record<number, boolean>>('starred-projects-pending', () => ({}));

  // Another tab of this browser changed the cookie. One watcher for the tab, outlasting the component that started it.
  if (cookie && import.meta.client && !followingCookie) {
    followingCookie = true;
    nuxtApp.runWithContext(() =>
      effectScope(true).run(() => {
        const followed = useCookie<unknown>(STARS_COOKIE, { maxAge: ONE_YEAR_S, sameSite: 'lax' });
        watch(followed, (value) => {
          const echo = ownCookieWrites.indexOf(JSON.stringify(value));
          if (echo !== -1) ownCookieWrites.splice(0, echo + 1);
          else list.value = parseStarredIds(value);
        });
      }),
    );
  }

  const starred = computed(() => new Set(list.value));

  /** `ids` with `projectId` starred or not. */
  function withStar(ids: number[], projectId: number, star: boolean): number[] {
    const without = ids.filter((id) => id !== projectId);
    return star ? [...without, projectId] : without;
  }

  /** Read the signed-in user's stars from the server; nothing to read with sign-in off or signed out. */
  async function load(): Promise<void> {
    if (!onServer || !authState.value.authenticated) return;
    // The server render already read them into the page's state.
    if (nuxtApp.isHydrating && nuxtApp.payload.serverRendered && loaded.value) return;
    const asked = ++loads.value;
    try {
      const answer = await requestFetch<{ projectIds: number[] }>('/api/projects/stars');
      if (asked !== loads.value) return;
      // A star still being changed keeps the state its request asks for.
      let ids = answer.projectIds;
      for (const [id, star] of Object.entries(pending.value)) ids = withStar(ids, Number(id), star);
      list.value = ids;
      loaded.value = true;
    } catch {
      if (asked !== loads.value) return;
      // The pages keep their own order, never another user's stars.
      list.value = [];
      loaded.value = false;
    }
  }

  function isStarred(projectId: number): boolean {
    return starred.value.has(projectId);
  }

  function isPending(projectId: number): boolean {
    return projectId in pending.value;
  }

  /** Star or unstar a project: the order changes at once, and that star comes back if the server refuses. */
  async function toggle(projectId: number): Promise<void> {
    if (isPending(projectId)) return;
    const star = !isStarred(projectId);
    if (cookie) {
      if (star && list.value.length >= MAX_BROWSER_STARS) {
        toast.add({ title: `This browser keeps up to ${MAX_BROWSER_STARS} stars`, color: 'error' });
        return;
      }
      list.value = withStar(list.value, projectId, star);
      ownCookieWrites.push(JSON.stringify(list.value));
      cookie.value = list.value;
      return;
    }
    list.value = withStar(list.value, projectId, star);
    pending.value = { ...pending.value, [projectId]: star };
    try {
      await $fetch(`/api/projects/${projectId}/star`, { method: star ? 'PUT' : 'DELETE' });
    } catch (error) {
      list.value = withStar(list.value, projectId, !star);
      toast.add({
        title: star ? 'The project could not be starred' : 'The star could not be removed',
        description: errorMessage(error),
        color: 'error',
      });
    } finally {
      const { [projectId]: _done, ...rest } = pending.value;
      pending.value = rest;
    }
  }

  return { starred, isStarred, isPending, toggle, load };
}
