import { commandEnvironmentOf } from '~/utils/environment-filter';

function idOf(raw: number | string | null | undefined): number | null {
  const value = Number(raw ?? Number.NaN);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The environment a page's copied commands and its **Run on my machine** requests are for: one choice per project on
 * a page (kept with the page's view state), so every copy button and request of the page agree. Until the person picks
 * one, the environment of the run the page shows (`shown`, its id), unless it is archived or protected; on a page
 * that shows no run, none. A pick no longer among the project's environments that are not archived reads as that
 * start. Every caller on a page passes the same `shown`. With `protectedAllowed` false (a command that cannot keep to
 * a protected environment's required tags, such as Flake Lab's), a protected pick reads as none. `offered` is whether
 * the project has an environment to pick.
 */
export function useCommandEnvironment(
  projectId: MaybeRefOrGetter<number | string | null | undefined>,
  shown: MaybeRefOrGetter<number | null | undefined> = null,
  { protectedAllowed = true }: { protectedAllowed?: boolean } = {},
) {
  const picks = useViewState<Record<string, number | null>>('command-environment', () => ({}));
  const { active, byId } = useProjectEnvironments(projectId);
  const project = computed(() => idOf(toValue(projectId)));

  const environmentId = computed<number | null>({
    get: () =>
      project.value == null
        ? null
        : commandEnvironmentOf({
            picked: picks.value[project.value],
            active: active.value,
            shown: byId(toValue(shown)),
            protectedAllowed,
          }),
    set: (value) => {
      if (project.value != null) picks.value = { ...picks.value, [project.value]: value };
    },
  });

  const offered = computed(() => active.value.length > 0);

  return { environmentId, offered };
}
