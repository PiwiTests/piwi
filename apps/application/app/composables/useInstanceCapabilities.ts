import { capabilityHidden, type CapabilityId, type CapabilityState, type InstanceDecision } from '#shared/capabilities';
import type { CapabilityStateItem, CapabilityStates } from '#shared/handlers/capabilities';

/**
 * The resolved instance-level state of every optional capability.
 *
 * Backed by `useAsyncData` keyed `capabilities-instance`, so the states are
 * fetched during SSR and hydrated from the payload rather than fetched only on
 * the client. It is async: `await` it at the top of `<script setup>` (as
 * `SubscribeBell.vue` does with `useFetch`), which resolves under the page's
 * Suspense boundary so a declined capability's chrome is absent from the first
 * render instead of flashing in and disappearing after hydration. Repeated calls
 * share one fetch through the key.
 *
 * `state(id)` is the resolved state, `isHidden(id)` is true when a capability is
 * declined, not applicable or never offered by the desktop build (so a surface
 * renders nothing), `canDecide` gates
 * the decline controls to administrators (`settings:manage`), `decide` writes
 * one decision and `decideMany` writes several at once (`null` clears a
 * decision). A read failure resolves to an empty list.
 */
export async function useInstanceCapabilities() {
  const { canSeeAdmin } = useAuth();
  const requestFetch = useRequestFetch();
  const isDesktop = useIsDesktop();

  const { data: items } = await useAsyncData<CapabilityStateItem[]>(
    'capabilities-instance',
    () =>
      requestFetch<CapabilityStates>('/api/capabilities')
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

  async function decideMany(decisions: Partial<Record<CapabilityId, InstanceDecision | null>>) {
    const res = await $fetch<CapabilityStates>('/api/capabilities', { method: 'PATCH', body: { decisions } });
    items.value = res.items;
  }

  const decide = (id: CapabilityId, decision: InstanceDecision | null) => decideMany({ [id]: decision });

  return { capabilities: items, state, isHidden, canDecide: canSeeAdmin, decide, decideMany };
}
