import { capabilityHidden, type CapabilityId, type CapabilityState, type ProjectDecision } from '#shared/capabilities';
import type { CapabilityStateItem, CapabilityStates } from '#shared/handlers/capabilities';

/** The `useAsyncData` key that holds one project's capability states, or no project's. */
const projectCapabilitiesKey = (projectId: number | null) =>
  projectId === null ? 'capabilities-project-none' : `capabilities-project-${projectId}`;

/**
 * One project's capability states under its key, which every caller for the project shares: a caller asking while a
 * read is running joins it. No project reads an empty list. A read that fails keeps the states last read or written
 * for the project; the first one resolves to an empty list.
 */
function useProjectCapabilityStates(
  projectId: () => number | null,
  options: { lazy?: boolean; server?: boolean } = {},
) {
  const nuxtApp = useNuxtApp();
  const requestFetch = useRequestFetch();
  return useAsyncData<CapabilityStateItem[]>(
    () => projectCapabilitiesKey(projectId()),
    () => {
      const id = projectId();
      if (id === null) return Promise.resolve([]);
      return requestFetch<CapabilityStates>(`/api/projects/${id}/capabilities`)
        .then((r) => r.items)
        .catch(() => (nuxtApp.payload.data[projectCapabilitiesKey(id)] as CapabilityStateItem[] | undefined) ?? []);
    },
    { default: () => [], dedupe: 'defer', getCachedData: reuseWithinRender, ...options },
  );
}

/**
 * The resolved state of every optional capability for one project: the
 * project's evidence and decision over the instance's.
 *
 * Backed by `useAsyncData` keyed `capabilities-project-<id>`, so the states are
 * fetched during SSR and hydrated from the payload rather than fetched only on
 * the client. It is async: `await` it at the top of `<script setup>` (as
 * `SubscribeBell.vue` does with `useFetch`), which resolves under the page's
 * Suspense boundary so a declined capability's chrome is absent from the first
 * render instead of flashing in and disappearing after hydration. Repeated calls
 * for the same project share one fetch through the key.
 *
 * `state(id)` is the resolved state, `isHidden(id)` is true when declined, not
 * applicable or never offered by the desktop build, `canDecide` gates the controls to holders of `project:manage` on
 * the project, `decide` writes one decision and `decideMany` writes several at
 * once (`enabled` overrides an instance decline; `null` clears a decision). A
 * read that fails keeps the states last read or written; the first one resolves
 * to an empty list.
 */
export async function useProjectCapabilities(projectId: number) {
  const { can } = useAuth();
  const nuxtApp = useNuxtApp();
  const isDesktop = useIsDesktop();

  const { data: items } = await useProjectCapabilityStates(() => projectId);

  const stateMap = computed(() => {
    const map = new Map<CapabilityId, CapabilityState>();
    for (const item of items.value ?? []) map.set(item.id, item.state);
    return map;
  });

  const state = (id: CapabilityId): CapabilityState => stateMap.value.get(id) ?? 'undecided';
  const isHidden = (id: CapabilityId): boolean => capabilityHidden(id, state(id), isDesktop);

  async function decideMany(decisions: Partial<Record<CapabilityId, ProjectDecision | null>>) {
    const res = await $fetch<CapabilityStates>(`/api/projects/${projectId}/capabilities`, {
      method: 'PATCH',
      body: { decisions },
    });
    items.value = res.items;
    nuxtApp.payload.data[projectCapabilitiesKey(projectId)] = res.items;
  }

  const decide = (id: CapabilityId, decision: ProjectDecision | null) => decideMany({ [id]: decision });

  const canDecide = computed(() => can('project:manage', projectId));

  return { capabilities: items, state, isHidden, canDecide, decide, decideMany };
}

/**
 * What the project the route names hides, for the layout. Its states load in the browser, without holding up a
 * navigation, once per visit to the project, under the key `useProjectCapabilities` reads: a page that loads them
 * joins the same read, and a decision a page writes reaches this reader. `isHidden(projectId, id)` is null until the
 * states of that project have arrived.
 */
export function useRouteProjectCapabilities() {
  const router = useRouter();
  const isDesktop = useIsDesktop();

  // The router's route changes as a navigation is confirmed, before the next page's setup, so the read starts
  // before a page that loads the states asks for them.
  const projectId = computed(() => {
    const match = router.currentRoute.value.path.match(/^\/projects\/(\d+)/);
    return match?.[1] ? parseInt(match[1], 10) : null;
  });
  const { data, status } = useProjectCapabilityStates(() => projectId.value, { lazy: true, server: false });

  const stateMap = computed(() =>
    status.value === 'success' ? new Map(data.value.map((item) => [item.id, item.state])) : null,
  );

  const isHidden = (forProject: number, id: CapabilityId): boolean | null => {
    const states = stateMap.value;
    if (!states || projectId.value !== forProject) return null;
    return capabilityHidden(id, states.get(id) ?? 'undecided', isDesktop);
  };

  return { isHidden };
}
