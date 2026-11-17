import { commandWithRunVariables, type RunVariable } from '#shared/run-variables';

/** How long a project's run variables are read again rather than taken from the page's store, in milliseconds. */
const FRESH_MS = 60_000;

/** The reads on their way, by project id: the components of one page that ask for one project share a read. */
const reading = new Map<number, Promise<void>>();

interface Stored {
  variables: RunVariable[];
  readAt: number;
}

/**
 * A project's run variables, read in the browser from `GET /api/projects/:id/run-variables` and kept for the page a
 * minute, and the commands Piwi gives to copy with them: `command(text)` starts `text` with them in the shell the
 * viewer copies for (`useCommandShell`). No variable, an unknown project or a failed read leaves a command as it is.
 */
export function useProjectRunVariables(projectId: MaybeRefOrGetter<number | string | null | undefined>) {
  const store = useState<Record<string, Stored>>('project-run-variables', () => ({}));
  const { shell } = useCommandShell();

  /** The project's id, or null for none or one that is not an id. */
  const id = computed(() => {
    const value = Number(toValue(projectId) ?? Number.NaN);
    return Number.isInteger(value) && value > 0 ? value : null;
  });

  const variables = computed<RunVariable[]>(() => (id.value == null ? [] : (store.value[id.value]?.variables ?? [])));

  function read(id: number): Promise<void> {
    const stored = store.value[id];
    if (stored && Date.now() - stored.readAt < FRESH_MS) return Promise.resolve();
    let asked = reading.get(id);
    if (!asked) {
      asked = $fetch<{ runVariables: RunVariable[] }>(`/api/projects/${id}/run-variables`)
        .then((answer) => {
          store.value = { ...store.value, [id]: { variables: answer.runVariables, readAt: Date.now() } };
        })
        .catch(() => {
          // A project the viewer cannot read, or a failed read: its commands stay as they are.
        })
        .finally(() => reading.delete(id));
      reading.set(id, asked);
    }
    return asked;
  }

  /** Resolves once the project's run variables are read, so a copy made at once starts with them. */
  function ready(): Promise<void> {
    return id.value == null ? Promise.resolve() : read(id.value);
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

  function command(text: string): string;
  function command(text: string | null | undefined): string | null;
  function command(text: string | null | undefined): string | null {
    if (!text) return text ?? null;
    return commandWithRunVariables(text, variables.value, shell.value);
  }

  /** Keeps the project's run variables as just saved, so the page's commands start with them at once. */
  function remember(saved: RunVariable[]) {
    if (id.value != null) store.value = { ...store.value, [id.value]: { variables: saved, readAt: Date.now() } };
  }

  return { variables, shell, command, remember, ready };
}
