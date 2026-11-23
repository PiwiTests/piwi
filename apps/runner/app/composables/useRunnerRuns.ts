import type { RunRequestTest } from '@piwitests/core/run-request';
import {
  createRunnerRuns,
  withUnlistedStop,
  type RunnerRun,
  type RunnerRunEvent,
  type RunnerUnlistedStops,
} from '~/utils/runner-runs';

let book: ReturnType<typeof createRunnerRuns> | null = null;
let unlisten: (() => void) | null = null;

/**
 * The runs of this window, shared by everything that shows them. Browser-only: the bridge to the shell exists in the
 * Tauri webview alone, and `listen()` (once, from the app's `onMounted`) starts hearing the shell's run events.
 */
export function useRunnerRuns() {
  const runs = useState<RunnerRun[]>('runner-runs', () => []);
  /** The run the person chose in the list: a run's key, or the ref of a run the hub has that the window holds none for. */
  const chosen = useState<number | string | null>('runner-chosen-run', () => null);
  /** The runs the window holds no entry for that were asked to stop, and when (`RunnerUnlistedStops`). */
  const unlistedStops = useState<RunnerUnlistedStops>('runner-unlisted-stops', () => ({}));

  function noteUnlistedStop(shellId: number) {
    unlistedStops.value = withUnlistedStop(unlistedStops.value, runs.value, shellId, Date.now());
  }

  function runBook() {
    book ??= createRunnerRuns(runs.value, {
      invoke: (command, args) => {
        const core = tauriCore();
        return core ? core.invoke(command, args) : Promise.reject(new Error('Piwi Runner is not running in its app'));
      },
    });
    return book;
  }

  /**
   * Hears the shell's run events, then asks which runs wind down after a stop that began before this window loaded,
   * so a run it holds no entry for shows stopping, with Force stop.
   */
  async function listen(): Promise<void> {
    const events = tauriEvent();
    if (!events || unlisten) return;
    runBook();
    unlisten = await events.listen<RunnerRunEvent>('piwi:local-run', ({ payload }) => {
      if (payload.kind === 'stopping') noteUnlistedStop(payload.id);
      book?.handle(payload);
    });
    const shell = await tauriCore()
      ?.invoke<{ stopping?: number[] }>('desktop_local_runs')
      .catch(() => null);
    for (const shellId of shell?.stopping ?? []) noteUnlistedStop(shellId);
  }

  /** Starts the run of a request the person confirmed, as the confirmation's `start` names it, and shows it. */
  function startRequest(input: {
    requestId: string;
    instance: string;
    projectId: number;
    projectName: string | null;
    cases: RunRequestTest[];
    title: string;
  }) {
    const { cases, ...run } = input;
    const started = runBook().start({ ...run, tests: cases });
    // The run book lists the run first before it waits for the shell.
    chosen.value = runs.value[0]?.key ?? null;
    return started;
  }

  function stopRun(run: RunnerRun) {
    return runBook().stop(run);
  }

  /** Turns a run's Hold failures on or off (`runnerShownRefs` tells the hub). */
  function setHold(run: RunnerRun, on: boolean) {
    const kept = runs.value.find((r) => r.key === run.key);
    if (kept) kept.holdFailures = on;
  }

  /**
   * Stops a run the hub still shows but this window has no entry for (it was reloaded while the run went on), by the
   * shell's id of it; asked again, the shell kills it.
   */
  function stopShellRun(shellId: number) {
    noteUnlistedStop(shellId);
    const core = tauriCore();
    return core ? core.invoke('desktop_stop_local_tests', { runId: shellId }).catch(() => {}) : Promise.resolve();
  }

  /** Removes the runs that ended from the list. */
  function clearFinished() {
    runBook().clearFinished();
  }

  return { runs, chosen, unlistedStops, listen, startRequest, stopRun, setHold, stopShellRun, clearFinished };
}
