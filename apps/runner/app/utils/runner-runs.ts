/**
 * The runs this window shows: the tests a team instance asked for and the person confirmed. The shell starts each
 * one (`desktop_run_requested_tests`) and streams its output as `piwi:local-run` events under the id the start
 * resolves with, so events that arrive before the id is known wait here and are applied once it is.
 */
import type { RunPage } from '@piwitests/core/run-channel';

export type RunnerRunStatus = 'running' | 'passed' | 'failed' | 'stopped' | 'error';

export interface RunnerRun {
  key: number;
  requestId: string;
  instance: string;
  projectId: number;
  title: string;
  /** The shell's id for the run; null until the start resolves. */
  shellId: number | null;
  status: RunnerRunStatus;
  stopRequested: boolean;
  /**
   * **Hold failures**: a failure no pause bar shows waits in the window for an answer while the run shows there, as a
   * `page.pause()` does. Off until the person turns it on.
   */
  holdFailures: boolean;
  exitCode: number | null;
  /**
   * The run's page on the instance (**Run #78 · Open**), once its own process named it to the hub (`HubSession.page`),
   * kept after the run ended; null until then.
   */
  page: RunPage | null;
  /** The last `RUNNER_MAX_LINES` lines of output. */
  lines: string[];
}

/** One `piwi:local-run` event: a line of output, an error line, or the exit of the run. */
export interface RunnerRunEvent {
  id: number;
  kind: string;
  line?: string | null;
  code?: number | null;
}

export interface RunnerRunStart {
  requestId: string;
  instance: string;
  projectId: number;
  title: string;
}

export interface RunnerRunBackend {
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

/** Output lines kept per run. */
export const RUNNER_MAX_LINES = 2000;
/** Finished runs kept in the list; a running one is never dropped. */
export const RUNNER_MAX_FINISHED = 15;
/** Events kept while their run's id is unknown. */
const MAX_WAITING_EVENTS = 500;

/**
 * Whether the hub's run `ref` is the shell's run `shellId`: the shell names each run it starts `desktop-<id>` on the
 * host's run channel (`PIWI_RUN_REF`), ending in `-unattended` for a run nobody attends.
 */
export function isRunnerRunRef(ref: string, shellId: number | null): boolean {
  if (shellId === null) return false;
  return ref === `desktop-${shellId}` || ref === `desktop-${shellId}-unattended`;
}

/** The shell's id of the run the hub's `ref` names; null for a ref the shell did not make. */
export function runnerShellIdOf(ref: string): number | null {
  const match = /^desktop-(\d+)(?:-unattended)?$/.exec(ref);
  return match ? Number(match[1]) : null;
}

/** The refs the window says `show` for: the running runs whose Hold failures is on. */
export function runnerShownRefs(runs: readonly RunnerRun[]): string[] {
  return runs
    .filter((run) => run.status === 'running' && run.holdFailures && run.shellId !== null)
    .map((run) => `desktop-${run.shellId}`);
}

/** Keeps on each run the page the hub's live run of it names (`HubSession.page`), so it stays once the run ended. */
export function noteRunPages(
  runs: readonly RunnerRun[],
  sessions: ReadonlyArray<{ ref: string; page?: RunPage }>,
): void {
  for (const session of sessions) {
    if (!session.page) continue;
    const run = runs.find((r) => isRunnerRunRef(session.ref, r.shellId));
    if (run && (run.page?.id !== session.page.id || run.page.url !== session.page.url)) run.page = { ...session.page };
  }
}

/** The status a run ends in: the person's stop wins, then the exit code. */
export function finishedStatus(run: Pick<RunnerRun, 'stopRequested'>, code: number | null): RunnerRunStatus {
  if (run.stopRequested) return 'stopped';
  if (code === 0) return 'passed';
  return code === null ? 'error' : 'failed';
}

/** Applies one event to the run it belongs to. */
export function applyRunEvent(run: RunnerRun, event: RunnerRunEvent): void {
  if (run.status !== 'running') return;
  if (event.kind === 'exit') {
    run.exitCode = event.code ?? null;
    run.status = finishedStatus(run, run.exitCode);
    return;
  }
  if (
    (event.kind === 'stdout' || event.kind === 'stderr' || event.kind === 'error') &&
    typeof event.line === 'string'
  ) {
    run.lines.push(event.line);
    if (run.lines.length > RUNNER_MAX_LINES) run.lines.splice(0, run.lines.length - RUNNER_MAX_LINES);
  }
}

/**
 * The list of runs, newest first. `runs` is the array the window renders (a reactive one in the app), and every change
 * goes through it, so a run object is read back from the array before it is changed.
 */
export function createRunnerRuns(runs: RunnerRun[], backend: RunnerRunBackend) {
  let nextKey = 1;
  let waiting: RunnerRunEvent[] = [];

  function trim(): void {
    let finished = 0;
    for (let i = 0; i < runs.length; i++) {
      if (runs[i]!.status === 'running') continue;
      finished++;
      if (finished > RUNNER_MAX_FINISHED) {
        runs.splice(i, 1);
        i--;
      }
    }
  }

  /** Hands an event to its run; one for a run whose id is not known yet waits for it. */
  function handle(event: RunnerRunEvent): void {
    const run = runs.find((r) => r.shellId === event.id);
    if (run) {
      applyRunEvent(run, event);
      trim();
      return;
    }
    waiting.push(event);
    if (waiting.length > MAX_WAITING_EVENTS) waiting.splice(0, waiting.length - MAX_WAITING_EVENTS);
  }

  /** Starts the run the person confirmed; the shell takes its command and its request token from the host. */
  async function start(input: RunnerRunStart): Promise<RunnerRun> {
    runs.unshift({
      key: nextKey++,
      requestId: input.requestId,
      instance: input.instance,
      projectId: input.projectId,
      title: input.title,
      shellId: null,
      status: 'running',
      stopRequested: false,
      holdFailures: false,
      exitCode: null,
      page: null,
      lines: [],
    });
    const run = runs[0]!;
    try {
      const id = await backend.invoke<number>('desktop_run_requested_tests', { requestId: input.requestId });
      run.shellId = id;
      const mine = waiting.filter((event) => event.id === id);
      waiting = waiting.filter((event) => event.id !== id);
      for (const event of mine) applyRunEvent(run, event);
    } catch (error) {
      run.lines.push(error instanceof Error ? error.message : String(error));
      run.status = 'error';
    }
    trim();
    return run;
  }

  /**
   * Stops a run as Ctrl+C would: the shell asks the process to wind down and kills it after a grace period. The run
   * stays `running` until the process exits; asking again kills it at once.
   */
  async function stop(run: RunnerRun): Promise<void> {
    if (run.status !== 'running' || run.shellId === null) return;
    run.stopRequested = true;
    try {
      await backend.invoke('desktop_stop_local_tests', { runId: run.shellId });
    } catch {
      // The process already exited between the check and the stop.
    }
  }

  return { runs, handle, start, stop };
}
