import { commandEnvironmentDefault } from '~/utils/environment-filter';

function idOf(raw: number | string | null | undefined): number | null {
  const value = Number(raw ?? Number.NaN);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The environment a page's copied commands and its **Run on my machine** requests are for: one choice per project on
 * a page (kept with the page's view state), so every copy button and request of the page agree. Until the person picks
 * one, the environment of the run the page shows (`shown`, its id), unless it is archived or protected; on a page
 * that shows no run, none. Every caller on a page passes the same `shown`. `offered` is whether the project has an
 * environment to pick.
 */
export function useCommandEnvironment(
  projectId: MaybeRefOrGetter<number | string | null | undefined>,
  shown: MaybeRefOrGetter<number | null | undefined> = null,
) {
  const picks = useViewState<Record<string, number | null>>('command-environment', () => ({}));
  const { active, byId } = useProjectEnvironments(projectId);
  const project = computed(() => idOf(toValue(projectId)));

  const environmentId = computed<number | null>({
    get: () => {
      if (project.value == null) return null;
      const picked = picks.value[project.value];
      if (picked !== undefined) return picked;
      return commandEnvironmentDefault(byId(toValue(shown)));
    },
    set: (value) => {
      if (project.value != null) picks.value = { ...picks.value, [project.value]: value };
    },
  });

  const offered = computed(() => active.value.length > 0);

  return { environmentId, offered };
}
