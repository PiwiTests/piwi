import { createRunnerRuns, type RunnerRun, type RunnerRunEvent } from '~/utils/runner-runs';

let book: ReturnType<typeof createRunnerRuns> | null = null;
let unlisten: (() => void) | null = null;

/**
 * The runs of this window, shared by everything that shows them. Browser-only: the bridge to the shell exists in the
 * Tauri webview alone, and `listen()` (once, from the app's `onMounted`) starts hearing the shell's run events.
 */
export function useRunnerRuns() {
  const runs = useState<RunnerRun[]>('runner-runs', () => []);

  function runBook() {
    book ??= createRunnerRuns(runs.value, {
      invoke: (command, args) => {
        const core = tauriCore();
        return core ? core.invoke(command, args) : Promise.reject(new Error('Piwi Runner is not running in its app'));
      },
    });
    return book;
  }

  async function listen(): Promise<void> {
    const events = tauriEvent();
    if (!events || unlisten) return;
    runBook();
    unlisten = await events.listen<RunnerRunEvent>('piwi:local-run', ({ payload }) => book?.handle(payload));
  }

  function startRequest(input: { requestId: string; instance: string; projectId: number; title: string }) {
    return runBook().start(input);
  }

  function stopRun(run: RunnerRun) {
    return runBook().stop(run);
  }

  /** Turns a run's Hold failures on or off (`runnerShownRefs` tells the hub). */
  function setHold(run: RunnerRun, on: boolean) {
    const kept = runs.value.find((r) => r.key === run.key);
    if (kept) kept.holdFailures = on;
  }

  return { runs, listen, startRequest, stopRun, setHold };
}
