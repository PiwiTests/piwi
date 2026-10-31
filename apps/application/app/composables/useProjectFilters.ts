import type { FilterBarState } from '~/components/shared/FilterBar.vue';

/** The project page's filters with nothing picked: the default branch, every environment, full runs only. */
export function defaultProjectFilters(): FilterBarState {
  return { environments: [], branches: [], fullRunsOnly: true, allBranches: false };
}

/**
 * The project page's filters, kept in one cookie per project. The project
 * page reads and writes them; the status filter settings copy them.
 */
export function useProjectFilters(projectId: string | number) {
  return useCookie<FilterBarState>(`piwi-filters-project-${projectId}`, {
    default: defaultProjectFilters,
    encode: (v) => JSON.stringify(v),
    decode: (v) => {
      try {
        return { ...defaultProjectFilters(), ...(v ? (JSON.parse(v) as Partial<FilterBarState>) : {}) };
      } catch {
        return defaultProjectFilters();
      }
    },
  });
}
