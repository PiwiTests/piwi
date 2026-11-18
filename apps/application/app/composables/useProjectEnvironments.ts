import { resolveEnvironment } from '@piwitests/core/environments';
import type { EnvironmentRecord } from '#shared/environments';

/** How long a project's environments are read again rather than taken from the page's store, in milliseconds. */
const FRESH_MS = 60_000;

const reading = new Map<number, Promise<void>>();

interface Stored {
  environments: EnvironmentRecord[];
  readAt: number;
}

/**
 * A project's environments, read from `GET /api/projects/:id/environments` and kept for the page a minute: every
 * picker and filter of the project reads them. `active` leaves the archived ones out; `forLabel` names the environment
 * a run's label resolves to, as the instance resolved it when the run was stored.
 */
export function useProjectEnvironments(projectId: MaybeRefOrGetter<number | string | null | undefined>) {
  const store = useState<Record<string, Stored>>('project-environments', () => ({}));

  const id = computed(() => {
    const value = Number(toValue(projectId) ?? Number.NaN);
    return Number.isInteger(value) && value > 0 ? value : null;
  });

  const environments = computed<EnvironmentRecord[]>(() =>
    id.value == null ? [] : (store.value[id.value]?.environments ?? []),
  );
  const active = computed(() => environments.value.filter((environment) => !environment.archived));
  const loaded = computed(() => id.value != null && store.value[id.value] !== undefined);

  function read(project: number, force = false): Promise<void> {
    const stored = store.value[project];
    if (!force && stored && Date.now() - stored.readAt < FRESH_MS) return Promise.resolve();
    let asked = force ? undefined : reading.get(project);
    if (!asked) {
      asked = $fetch<{ environments: EnvironmentRecord[] }>(`/api/projects/${project}/environments`)
        .then((answer) => {
          store.value = { ...store.value, [project]: { environments: answer.environments, readAt: Date.now() } };
        })
        .catch(() => {
          // A project the viewer cannot read, or a failed read: the pickers offer no environment.
        })
        .finally(() => reading.delete(project));
      reading.set(project, asked);
    }
    return asked;
  }

  onMounted(() => {
    watch(
      id,
      (value) => {
        if (value != null) void read(value);
      },
      { immediate: true },
    );
  });

  /** Reads the list again now, after a change. */
  function refresh(): Promise<void> {
    return id.value == null ? Promise.resolve() : read(id.value, true);
  }

  function byId(environmentId: number | null | undefined): EnvironmentRecord | null {
    return environmentId == null ? null : (environments.value.find((e) => e.id === environmentId) ?? null);
  }

  /** The environment a run's label resolves to, by key or alias, ignoring case. */
  function forLabel(label: string | null | undefined): EnvironmentRecord | null {
    return byId(resolveEnvironment(label, environments.value));
  }

  return { environments, active, loaded, refresh, byId, forLabel };
}
