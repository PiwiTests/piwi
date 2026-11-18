import type { EnvironmentForRun } from '@piwitests/core/environments';
import { commandWithEnvironment, type RunVariable } from '#shared/run-variables';

/** How long a project's run variables are read again rather than taken from the page's store, in milliseconds. */
const FRESH_MS = 60_000;

/** The reads on their way, by project and environment: the components of one page that ask for one share a read. */
const reading = new Map<string, Promise<void>>();

interface Stored {
  variables: RunVariable[];
  environment: EnvironmentForRun | null;
  readAt: number;
}

function idOf(raw: number | string | null | undefined): number | null {
  const value = Number(raw ?? Number.NaN);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function storeKey(projectId: number, environmentId: number | null): string {
  return environmentId == null ? String(projectId) : `${projectId}:${environmentId}`;
}

/**
 * A project's run variables, read in the browser from `GET /api/projects/:id/run-variables` and kept for the page a
 * minute, and the commands Piwi gives to copy with them: `command(text)` starts `text` with them in the shell the
 * viewer copies for (`useCommandShell`). With an environment, the project's and the environment's merged, `environment`
 * is what the instance answered for it, and a command also sets `PIWI_ENVIRONMENT` and, for a protected environment,
 * the `--grep-invert` of its required tags (`commandWithEnvironment`). No variable, an unknown project or a failed read
 * leaves a command as it is.
 */
export function useProjectRunVariables(
  projectId: MaybeRefOrGetter<number | string | null | undefined>,
  environmentId: MaybeRefOrGetter<number | string | null | undefined> = null,
) {
  const store = useState<Record<string, Stored>>('project-run-variables', () => ({}));
  const { shell } = useCommandShell();

  /** The project's id, or null for none or one that is not an id. */
  const id = computed(() => idOf(toValue(projectId)));
  const environment = computed(() => idOf(toValue(environmentId)));
  const key = computed(() => (id.value == null ? null : storeKey(id.value, environment.value)));

  const variables = computed<RunVariable[]>(() => (key.value == null ? [] : (store.value[key.value]?.variables ?? [])));
  const environmentForRun = computed<EnvironmentForRun | null>(() =>
    key.value == null ? null : (store.value[key.value]?.environment ?? null),
  );

  function read(project: number, environmentOfRun: number | null): Promise<void> {
    const at = storeKey(project, environmentOfRun);
    const stored = store.value[at];
    if (stored && Date.now() - stored.readAt < FRESH_MS) return Promise.resolve();
    let asked = reading.get(at);
    if (!asked) {
      const query = environmentOfRun == null ? '' : `?environment=${environmentOfRun}`;
      asked = $fetch<{ runVariables: RunVariable[]; environment?: EnvironmentForRun | null }>(
        `/api/projects/${project}/run-variables${query}`,
      )
        .then((answer) => {
          store.value = {
            ...store.value,
            [at]: { variables: answer.runVariables, environment: answer.environment ?? null, readAt: Date.now() },
          };
        })
        .catch(() => {
          // A project the viewer cannot read, an environment they may not run, or a failed read: commands stay as
          // they are.
        })
        .finally(() => reading.delete(at));
      reading.set(at, asked);
    }
    return asked;
  }

  /** Resolves once the run variables are read, so a copy made at once starts with them. */
  function ready(): Promise<void> {
    return id.value == null ? Promise.resolve() : read(id.value, environment.value);
  }

  onMounted(() => {
    watch(
      [id, environment],
      ([project, environmentOfRun]) => {
        if (project != null) void read(project, environmentOfRun);
      },
      { immediate: true },
    );
  });

  function command(text: string): string;
  function command(text: string | null | undefined): string | null;
  function command(text: string | null | undefined): string | null {
    if (!text) return text ?? null;
    return commandWithEnvironment(text, variables.value, environmentForRun.value, shell.value);
  }

  /** The store without the project's entries, its own and each environment's merged ones. */
  function without(project: number): Record<string, Stored> {
    const prefix = `${project}:`;
    return Object.fromEntries(
      Object.entries(store.value).filter(([at]) => at !== String(project) && !at.startsWith(prefix)),
    );
  }

  /**
   * Drops what the page keeps of the project's run variables, its own and each environment's merged ones, after a
   * change to them or to an environment, so the next command reads them again.
   */
  function forget() {
    if (id.value != null) store.value = without(id.value);
  }

  /**
   * Keeps the project's run variables as just saved, so the page's commands start with them at once, and drops each
   * environment's merged ones, read again when next asked.
   */
  function remember(saved: RunVariable[]) {
    if (id.value != null) {
      store.value = {
        ...without(id.value),
        [storeKey(id.value, null)]: { variables: saved, environment: null, readAt: Date.now() },
      };
    }
  }

  return { variables, environment: environmentForRun, shell, command, remember, forget, ready };
}
