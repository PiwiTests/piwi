import { capabilityHidden, type CapabilityId, type CapabilityState, type ProjectDecision } from '#shared/capabilities';
import type { CapabilityStateItem, CapabilityStates } from '#shared/handlers/capabilities';

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
 * read failure resolves to an empty list.
 */
export async function useProjectCapabilities(projectId: number) {
  const { can } = useAuth();
  const requestFetch = useRequestFetch();
  const isDesktop = useIsDesktop();

  const { data: items } = await useAsyncData<CapabilityStateItem[]>(
    `capabilities-project-${projectId}`,
    () =>
      requestFetch<CapabilityStates>(`/api/projects/${projectId}/capabilities`)
        .then((r) => r.items)
        .catch(() => []),
    { default: () => [], dedupe: 'defer', getCachedData: reuseWithinRender },
  );

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
  }

  const decide = (id: CapabilityId, decision: ProjectDecision | null) => decideMany({ [id]: decision });

  const canDecide = computed(() => can('project:manage', projectId));

  return { capabilities: items, state, isHidden, canDecide, decide, decideMany };
}
