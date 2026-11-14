import { capabilityHidden, type CapabilityId, type CapabilityState, type ProjectDecision } from '#shared/capabilities';
import { defineComponent } from 'vue';
import type { CapabilityStateItem, CapabilityStates } from '#shared/handlers/capabilities';

/** The `useAsyncData` key that holds one project's capability states. */
const projectCapabilitiesKey = (projectId: number) => `capabilities-project-${projectId}`;

/**
 * One project's capability states under its key, which every caller for the project shares: a caller asking while a
 * read is running joins it. A read that fails keeps the states last read or written for the project; with none, it
 * fails, and the payload holds no states for the project.
 */
function useProjectCapabilityStates(projectId: number, options: { lazy?: boolean; server?: boolean } = {}) {
  const nuxtApp = useNuxtApp();
  const requestFetch = useRequestFetch();
  const key = projectCapabilitiesKey(projectId);
  return useAsyncData<CapabilityStateItem[]>(
    key,
    () =>
      requestFetch<CapabilityStates>(`/api/projects/${projectId}/capabilities`)
        .then((r) => r.items)
        .catch((error: unknown) => {
          const kept = nuxtApp.payload.data[key] as CapabilityStateItem[] | undefined;
          if (kept) return kept;
          throw error;
        }),
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
 * read that fails keeps the states last read or written; a first one that fails
 * reads every capability as undecided.
 */
export async function useProjectCapabilities(projectId: number) {
  const { can } = useAuth();
  const nuxtApp = useNuxtApp();
  const isDesktop = useIsDesktop();

  const { data: items } = await useProjectCapabilityStates(projectId);

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

/** Reads one project's capability states in the browser, under the key `useProjectCapabilities` reads. Renders nothing. */
const ProjectCapabilitiesRead = defineComponent({
  props: { projectId: { type: Number, required: true } },
  setup(props) {
    void useProjectCapabilityStates(props.projectId, { lazy: true, server: false });
    return () => null;
  },
});

/**
 * What a project hides, for the layout, from the states held for it: those a page read or wrote, or those
 * `ProjectCapabilitiesRead` read. The layout renders `ProjectCapabilitiesRead` keyed by `routeProjectId`, the project
 * the router's route names, which changes as a navigation is confirmed, before the next page's setup: a page that
 * loads the states joins the same read. `isHidden(projectId, id)` is null until the project's states have been read
 * once; a refresh, or a later read that fails, keeps them.
 */
export function useLoadedProjectCapabilities() {
  const nuxtApp = useNuxtApp();
  const router = useRouter();
  const isDesktop = useIsDesktop();

  const routeProjectId = computed(() => {
    const match = router.currentRoute.value.path.match(/^\/projects\/(\d+)/);
    return match?.[1] ? parseInt(match[1], 10) : null;
  });

  const isHidden = (projectId: number, id: CapabilityId): boolean | null => {
    const items = nuxtApp.payload.data[projectCapabilitiesKey(projectId)] as CapabilityStateItem[] | undefined;
    if (!items) return null;
    return capabilityHidden(id, items.find((item) => item.id === id)?.state ?? 'undecided', isDesktop);
  };

  return { isHidden, routeProjectId, ProjectCapabilitiesRead };
}
