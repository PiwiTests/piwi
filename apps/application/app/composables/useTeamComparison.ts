/**
 * Compare with team instance, in the desktop app: how a local execution's test (`execution`), or a local test
 * (`test-case`), does in the CI of the team project its folder is also linked to, as the app's server asks the team
 * instance (`/api/desktop/team/…/comparison`). Read in the browser, after the page shows; nothing outside the desktop
 * app, where there is no team instance to ask.
 */
import type { DesktopTeamComparison } from '~~/server/utils/desktop-team-comparison';

export function useTeamComparison(
  kind: 'execution' | 'test-case',
  id: MaybeRefOrGetter<number | string | null | undefined>,
) {
  const isDesktop = useIsDesktop();
  const path = computed(() => {
    const value = toValue(id);
    if (!isDesktop || value == null || value === '') return null;
    return `/api/desktop/team/${kind === 'execution' ? 'executions' : 'test-cases'}/${value}/comparison`;
  });
  const { data } = useFetch<DesktopTeamComparison>(() => path.value ?? '', {
    key: computed(() => `team-comparison:${path.value ?? 'none'}`),
    server: false,
    lazy: true,
    immediate: path.value !== null,
    watch: [path],
  });
  const comparison = computed(() => (path.value ? (data.value ?? null) : null));
  return { comparison, shown: computed(() => teamComparisonShown(comparison.value)) };
}
