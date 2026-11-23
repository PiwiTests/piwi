/**
 * The runs this window shows: the tests a team instance asked for and the person confirmed. The shell starts each
 * one (`desktop_run_requested_tests`) and streams its output as `piwi:local-run` events under the id the start
 * resolves with, so events that arrive before the id is known wait here and are applied once it is.
 */
import type { RunPage } from '@piwitests/core/run-channel';
import type { RunRequestTest } from '@piwitests/core/run-request';
import {
  runOutputLine,
  runOutputSummary,
  type RunOutputLine,
  type RunOutputResult,
  type RunResultRow,
} from '@piwitests/run-ui/run-output';

export type RunnerRunStatus = 'running' | 'passed' | 'failed' | 'stopped' | 'error';

export interface RunnerRun {
  key: number;
  requestId: string;
  instance: string;
  projectId: number;
  /** The name the instance gives the project; null when it gives none. */
  projectName: string | null;
  title: string;
  /** The tests the request asked for. */
  tests: RunRequestTest[];
  /** When the person confirmed it, and when its process ended (null while it runs), in ms since the epoch. */
  startedAt: number;
  endedAt: number | null;
  /** The shell's id for the run; null until the start resolves. */
  shellId: number | null;
  status: RunnerRunStatus;
  /** The run was asked to stop: by the person here, or by the team instance, which the shell says (`stopping`). */
  stopRequested: boolean;
  /** When the run was asked to stop, in ms since the epoch: Force stop waits a moment after it. */
  stopRequestedAt?: number | null;
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
  /** The last `RUNNER_MAX_LINES` lines of output, numbered from 1 in the run. */
  lines: RunOutputLine[];
  /** The lines the run printed so far, its first ones dropped from `lines` included. */
  linesTotal: number;
}

/**
 * One `piwi:local-run` event: a line of output, an error line, the start of a stop (`stopping`, whoever asked), or the
 * exit of the run, with whether it was stopped.
 */
export interface RunnerRunEvent {
  id: number;
  kind: string;
  line?: string | null;
  code?: number | null;
  stopped?: boolean | null;
}

export interface RunnerRunStart {
  requestId: string;
  instance: string;
  projectId: number;
  projectName: string | null;
  tests: RunRequestTest[];
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

/** The status a run ends in: a stop wins, then the exit code. */
export function finishedStatus(run: Pick<RunnerRun, 'stopRequested'>, code: number | null): RunnerRunStatus {
  if (run.stopRequested) return 'stopped';
  if (code === 0) return 'passed';
  return code === null ? 'error' : 'failed';
}

/** Marks a run asked to stop at `at`, keeping the time of the first ask. */
function noteStop(run: RunnerRun, at: number): void {
  if (!run.stopRequested) run.stopRequestedAt = at;
  run.stopRequested = true;
}

/**
 * Applies one event, heard at `at`, to the run it belongs to. The shell says when a stop begins (`stopping`), whoever
 * asked it, the team instance included: the run shows stopping and its Stop becomes Force stop. An exit the shell says
 * was stopped ends the run stopped.
 */
export function applyRunEvent(run: RunnerRun, event: RunnerRunEvent, at: number = Date.now()): void {
  if (run.status !== 'running') return;
  if (event.kind === 'stopping') {
    noteStop(run, at);
    return;
  }
  if (event.kind === 'exit') {
    if (event.stopped) noteStop(run, at);
    run.exitCode = event.code ?? null;
    run.status = finishedStatus(run, run.exitCode);
    run.endedAt = at;
    return;
  }
  if (
    (event.kind === 'stdout' || event.kind === 'stderr' || event.kind === 'error') &&
    typeof event.line === 'string'
  ) {
    pushRunnerLine(run, event.line, event.kind !== 'stdout');
  }
}

/** Adds a line to a run's output, keeping its last `RUNNER_MAX_LINES`. */
function pushRunnerLine(run: RunnerRun, printed: string, error: boolean): void {
  run.linesTotal = (run.linesTotal ?? 0) + 1;
  run.lines.push(runOutputLine(run.linesTotal, printed, error));
  if (run.lines.length > RUNNER_MAX_LINES) run.lines.splice(0, run.lines.length - RUNNER_MAX_LINES);
}

/** The runs that ended, the last to end first. */
export function runnerFinishedRuns(runs: readonly RunnerRun[]): RunnerRun[] {
  return runs.filter((run) => run.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
}

/**
 * The hub's live runs no run of `runs` is: the window was reloaded while they went on, so it holds no entry for them.
 */
export function runnerUnlistedSessions<S extends { ref: string; ended: boolean }>(
  sessions: readonly S[],
  runs: readonly RunnerRun[],
): S[] {
  return sessions.filter((session) => !session.ended && !runs.some((run) => isRunnerRunRef(session.ref, run.shellId)));
}

/**
 * The shell's runs this window holds no entry for (it was reloaded while they went on) that were asked to stop, by
 * shell id, each with when the window first heard so: a stop asked here, a `stopping` event, or the shell's list of the
 * runs that wind down (`desktop_local_runs`).
 */
export type RunnerUnlistedStops = Record<number, number>;

/** `stops` with shell run `shellId` asked to stop at `at`, unless a run of `runs` is that run or its stop is known. */
export function withUnlistedStop(
  stops: RunnerUnlistedStops,
  runs: readonly RunnerRun[],
  shellId: number,
  at: number,
): RunnerUnlistedStops {
  if (stops[shellId] !== undefined || runs.some((run) => run.shellId === shellId)) return stops;
  return { ...stops, [shellId]: at };
}

/** A spec path with POSIX separators and no leading `./`. */
const posixPath = (file: string) => file.replaceAll('\\', '/').replace(/^\.\//, '');

/**
 * How closely the output's result is the requested test, 0 when it is not: same file (its very path counts more than a
 * path ending in it), then same line or same title (a run that selects by title, as lines moved, prints another
 * line), then same project (a request may run its tests in another one).
 */
function requestedTestScore(result: RunOutputResult, test: RunRequestTest): number {
  const [printed, asked] = [posixPath(result.file), posixPath(test.filePath)];
  const samePath = printed === asked;
  if (!samePath && !printed.endsWith(`/${asked}`) && !asked.endsWith(`/${printed}`)) return 0;
  const sameLine = test.line != null && result.line === test.line;
  const sameTitle = result.title === test.title || result.title.endsWith(` › ${test.title}`);
  if (!sameLine && !sameTitle) return 0;
  const sameProject = !test.projectName || !result.project || test.projectName === result.project;
  return (samePath ? 8 : 0) + (sameLine ? 4 : 0) + (sameTitle ? 2 : 0) + (sameProject ? 1 : 0);
}

/** The output's result that is most closely the requested test; none when none is. */
function resultOfTest(results: readonly RunOutputResult[], test: RunRequestTest): RunOutputResult | null {
  let best: RunOutputResult | null = null;
  let bestScore = 0;
  for (const result of results) {
    const score = requestedTestScore(result, test);
    if (score > bestScore) [best, bestScore] = [result, score];
  }
  return best;
}

/**
 * How each test the request asked for came out, as the run's output tells it (`runOutputSummary`, the closest result
 * by `resultOfTest`): failed, flaky or interrupted with the first lines of its error, passed or skipped by the list
 * reporter's result lines. A test the
 * output names no result for passed when the run passed and skipped none, else its result is unknown. Null while the run
 * goes on, and when its output holds no summary.
 */
export function runnerTestResults(run: Pick<RunnerRun, 'status' | 'tests' | 'lines'>): RunResultRow[] | null {
  if (run.status === 'running') return null;
  const summary = runOutputSummary(run.lines);
  if (!summary) return null;
  return run.tests.map((test, index): RunResultRow => {
    const result = resultOfTest(summary.results, test);
    const passed = run.status === 'passed' && summary.counts.skipped === 0;
    return {
      key: String(index),
      status: result?.status ?? (passed ? 'passed' : 'unknown'),
      title: test.title,
      place: test.line != null ? `${test.filePath}:${test.line}` : test.filePath,
      project: test.projectName,
      error: result?.error ?? [],
    };
  });
}

/** How long a run took, or has taken so far at `now`, in ms. */
export function runnerRunDuration(run: Pick<RunnerRun, 'startedAt' | 'endedAt'>, now: number): number {
  return Math.max(0, (run.endedAt ?? now) - run.startedAt);
}

/**
 * The list of runs, newest first. `runs` is the array the window renders (a reactive one in the app), and every change
 * goes through it, so a run object is read back from the array before it is changed. `now` is the clock.
 */
export function createRunnerRuns(runs: RunnerRun[], backend: RunnerRunBackend, now: () => number = Date.now) {
  let nextKey = 1;
  let waiting: RunnerRunEvent[] = [];

  /** Drops the runs that ended longest ago beyond `RUNNER_MAX_FINISHED`: never a running one, nor one that just ended. */
  function trim(): void {
    const dropped = new Set(runnerFinishedRuns(runs).slice(RUNNER_MAX_FINISHED));
    for (let i = runs.length - 1; i >= 0; i--) {
      if (dropped.has(runs[i]!)) runs.splice(i, 1);
    }
  }

  /** Hands an event to its run; one for a run whose id is not known yet waits for it. */
  function handle(event: RunnerRunEvent): void {
    const run = runs.find((r) => r.shellId === event.id);
    if (run) {
      applyRunEvent(run, event, now());
      trim();
      return;
    }
    waiting.push(event);
    if (waiting.length > MAX_WAITING_EVENTS) waiting.splice(0, waiting.length - MAX_WAITING_EVENTS);
  }

  /**
   * Starts the run the person confirmed; the shell takes its command and its request token from the host. A request
   * the requester stopped before its run started starts nothing (a null id), and the run ends stopped.
   */
  async function start(input: RunnerRunStart): Promise<RunnerRun> {
    runs.unshift({
      key: nextKey++,
      requestId: input.requestId,
      instance: input.instance,
      projectId: input.projectId,
      projectName: input.projectName,
      title: input.title,
      tests: input.tests,
      startedAt: now(),
      endedAt: null,
      shellId: null,
      status: 'running',
      stopRequested: false,
      holdFailures: false,
      exitCode: null,
      page: null,
      lines: [],
      linesTotal: 0,
    });
    const run = runs[0]!;
    try {
      const id = await backend.invoke<number | null>('desktop_run_requested_tests', { requestId: input.requestId });
      if (id === null) {
        noteStop(run, now());
        run.status = 'stopped';
        run.endedAt = now();
      } else {
        run.shellId = id;
        const mine = waiting.filter((event) => event.id === id);
        waiting = waiting.filter((event) => event.id !== id);
        for (const event of mine) applyRunEvent(run, event, now());
      }
    } catch (error) {
      pushRunnerLine(run, error instanceof Error ? error.message : String(error), true);
      run.status = 'error';
      run.endedAt = now();
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
    noteStop(run, now());
    try {
      await backend.invoke('desktop_stop_local_tests', { runId: run.shellId });
    } catch {
      // The process already exited between the check and the stop.
    }
  }

  /** Removes the runs that ended from the list; the running ones stay. */
  function clearFinished(): void {
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i]!.status !== 'running') runs.splice(i, 1);
    }
  }

  return { runs, handle, start, stop, clearFinished };
}
