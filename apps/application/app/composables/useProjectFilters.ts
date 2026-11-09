import { computed, type WritableComputedRef } from 'vue';
import type { FilterBarState } from '~/components/shared/FilterBar.vue';

/** The project page's filters with nothing picked: the default branch, every environment, full runs only. */
export function defaultProjectFilters(): FilterBarState {
  return { environments: [], branches: [], fullRunsOnly: true, allBranches: false };
}

function isDefaultProjectFilters(filters: FilterBarState): boolean {
  return (
    filters.environments.length === 0 && filters.branches.length === 0 && filters.fullRunsOnly && !filters.allBranches
  );
}

/**
 * The project page's filters, kept in one cookie per project while they
 * differ from the defaults: a project whose filters were never changed, or
 * were reset, has no cookie, so the cookies a browser sends do not grow with
 * every project it opens. The project page reads and writes them; the status
 * filter settings copy them.
 */
export function useProjectFilters(projectId: string | number): WritableComputedRef<FilterBarState> {
  const cookie = useCookie<FilterBarState | undefined>(`piwi-filters-project-${projectId}`, {
    encode: (v) => JSON.stringify(v),
    decode: (v) => {
      try {
        return v ? { ...defaultProjectFilters(), ...(JSON.parse(v) as Partial<FilterBarState>) } : undefined;
      } catch {
        return undefined;
      }
    },
  });
  if (cookie.value && isDefaultProjectFilters(cookie.value)) cookie.value = undefined;
  return computed({
    get: () => cookie.value ?? defaultProjectFilters(),
    set: (filters) => {
      cookie.value = isDefaultProjectFilters(filters) ? undefined : filters;
    },
  });
}
