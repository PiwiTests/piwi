/**
 * Desktop shell: render live run progress on the OS.
 *
 * While any test run the app knows about is in flight — one reported from CI or
 * a terminal, or one launched from the app — the shell shows its progress on the
 * taskbar/Dock progress bar, the window title and the tray tooltip/icon, so a run
 * can be watched with the window minimised or closed to the tray. A failed test
 * turns the status dot (and a determinate bar) red while the run goes on.
 *
 * Runs arrive on the desktop event stream (`subscribeDesktopEvents`): a
 * `snapshot` of the runs already in flight when the shell connects, then live
 * lifecycle + progress deltas. The active runs are aggregated
 * (`aggregateRunProgress`) and fed to the shell's `desktop_set_run_progress`
 * command; when the last run finishes the outcome flashes (green pass / amber
 * interrupted / red fail) briefly before clearing, and a red one asks for the
 * user's attention. A step of a job of the Local runs tray (a reproduction, a
 * bisect, a Flake Lab session, as the stream names it: `job`) shows as progress
 * alone: its end flashes nothing, and the job's verdict flashes once its process
 * ends (`finishedJobFlash`); so does a run whose stream names nothing of what
 * launched it. A local run stopped from the app, and a job (a Flake Lab session
 * included) once it ends, leave the bar with their own runs alone
 * (`runsOfLocalRun`); any other local run, with the runs of its project that
 * never began (`unbegunRunsOf`), as one whose global setup failed. The plugin
 * hears each end from the store (`onRunEnded`), before the tray can drop it, and
 * keeps the runs an end took off for a minute (`SWEPT_MS`): a late message of
 * theirs brings none back.
 *
 * Activates only inside the shell (the IPC bridge is present); the shared web
 * build has no bridge and this no-ops.
 */
import {
  ACTIVE_RUN_STATUSES,
  NO_LIVE_RUN_FACTS,
  aggregateRunProgress,
  finishedJobFlash,
  finishedRunFlash,
  liveRunFacts,
  runsOfLocalRun,
  unbegunRunsOf,
  type FinishedRunFlash,
  type LiveRun,
  type RunProgressState,
} from '~/utils/desktop-run-progress';

/** What a run's message names of what launched it, once the run has begun (`server/utils/desktop-run-facts.ts`). */
interface RunFactsFields {
  origin?: string;
  originRef?: string | null;
  name?: string | null;
  job?: boolean;
}

interface LiveRunMessage extends RunFactsFields {
  type:
    | 'snapshot'
    | 'run-progress'
    | 'run-started'
    | 'run-initializing'
    | 'run-finalizing'
    | 'run-finished'
    | 'run-cancelled'
    | 'run-submitted';
  runId?: number;
  projectId?: number;
  status?: string;
  totalTests?: number;
  passedTests?: number;
  failedTests?: number;
  skippedTests?: number;
  didNotRunTests?: number;
  runs?: Array<
    RunFactsFields & {
      id: number;
      projectId?: number;
      status: string;
      totalTests?: number;
      passedTests?: number;
      failedTests?: number;
      skippedTests?: number;
      didNotRunTests?: number;
    }
  >;
}

/** How long the runs a local run's end took off the bar stay off whatever their messages say. */
const SWEPT_MS = 60_000;

type Counts = Pick<LiveRunMessage, 'totalTests' | 'passedTests' | 'failedTests' | 'skippedTests' | 'didNotRunTests'>;

/** Tests finished so far — passed + failed + skipped + did-not-run. */
function doneOf(c: Counts): number {
  return (c.passedTests ?? 0) + (c.failedTests ?? 0) + (c.skippedTests ?? 0) + (c.didNotRunTests ?? 0);
}

export default defineNuxtPlugin(() => {
  const core = tauriCore();
  if (!core) return; // not running inside the desktop shell

  // runId → its current counts; only in-flight runs are kept.
  const active = new Map<number, LiveRun>();
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSent = '';
  /** What shows once nothing is in flight: the outcome of the run or the job that ended last. */
  let lastFinished: FinishedRunFlash | null = null;
  /** The runs a local run's end took off the bar, and when. */
  const swept = new Map<number, number>();

  /** Whether a local run's end took the run off the bar less than `SWEPT_MS` ago. */
  function wasSwept(runId: number): boolean {
    const at = swept.get(runId);
    if (at === undefined) return false;
    if (Date.now() - at < SWEPT_MS) return true;
    swept.delete(runId);
    return false;
  }

  function send(state: RunProgressState, fraction: number | null, label: string | null, failing = false) {
    // Collapse identical updates — progress events are frequent but the shell
    // only needs the changes.
    const key = `${state}|${fraction ?? ''}|${label ?? ''}|${failing}`;
    if (key === lastSent) return;
    lastSent = key;
    core!.invoke('desktop_set_run_progress', { state, fraction, label, failing }).catch(() => {});
  }

  function pushUpdate() {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    const agg = aggregateRunProgress([...active.values()]);
    if (agg.state !== 'none') {
      lastFinished = null;
      send(agg.state, agg.fraction, agg.label, agg.failing);
      return;
    }
    // Nothing in flight — flash the last outcome, then clear.
    const flash = lastFinished;
    lastFinished = null;
    if (flash) {
      send(flash.progress.state, flash.progress.fraction, flash.progress.label, flash.progress.failing);
      clearTimer = setTimeout(() => send('none', null, null), flash.durationMs);
    } else {
      send('none', null, null);
    }
  }

  /** Tracks a run in flight with these counts, keeping what launched it once a message of it said so. */
  function track(
    runId: number,
    counts: Pick<LiveRun, 'status' | 'done' | 'total' | 'failed'>,
    msg: RunFactsFields & { projectId?: number },
  ) {
    const known = active.get(runId);
    const facts = liveRunFacts(msg) ?? (known ? liveRunFacts(known) : null) ?? NO_LIVE_RUN_FACTS;
    active.set(runId, { ...counts, ...facts, projectId: msg.projectId ?? known?.projectId ?? null });
  }

  function handle(msg: LiveRunMessage) {
    switch (msg.type) {
      case 'snapshot': {
        active.clear();
        for (const r of msg.runs ?? []) {
          if (ACTIVE_RUN_STATUSES.has(r.status) && !wasSwept(r.id)) {
            track(r.id, { status: r.status, done: doneOf(r), total: r.totalTests ?? 0, failed: r.failedTests ?? 0 }, r);
          }
        }
        pushUpdate();
        break;
      }
      case 'run-progress': {
        if (msg.runId == null || wasSwept(msg.runId)) break;
        const counts = {
          status: 'running',
          done: doneOf(msg),
          total: msg.totalTests ?? 0,
          failed: msg.failedTests ?? 0,
        };
        track(msg.runId, counts, msg);
        pushUpdate();
        break;
      }
      case 'run-started':
      case 'run-initializing': {
        if (msg.runId == null || wasSwept(msg.runId)) break;
        const known = active.get(msg.runId);
        // Known to be in flight but no counts yet → indeterminate until progress.
        if (!known) track(msg.runId, { status: 'running', done: 0, total: 0, failed: 0 }, msg);
        // A run that began says what launched it.
        else if (liveRunFacts(msg)) track(msg.runId, known, msg);
        else break;
        pushUpdate();
        break;
      }
      case 'run-finished':
      case 'run-cancelled':
      case 'run-submitted': {
        // Only a run still on the bar has an outcome to show — one already
        // dropped (a stopped local run the server reaps later) changes nothing.
        const run = msg.runId == null ? undefined : active.get(msg.runId);
        if (!run) break;
        active.delete(msg.runId!);
        // A job's step has no outcome of its own: its job's verdict flashes once the job ends. Neither has a run
        // nothing names, one that never began.
        const facts = liveRunFacts(msg) ?? liveRunFacts(run);
        if (facts && !facts.job) {
          lastFinished = finishedRunFlash(msg.type === 'run-finished' ? (msg.status ?? 'passed') : 'cancelled');
        }
        pushUpdate();
        break;
      }
      // 'run-finalizing' keeps the run active with its current counts — nothing to do.
    }
  }

  // The server resends a fresh snapshot on each (re)connection, which re-seeds
  // `active` without extra work here.
  subscribeDesktopEvents((message) => handle(message as unknown as LiveRunMessage));

  // Local ("Run locally") runs are driven from the app, so they are the only
  // ones it can stop — best-effort, and never allowed to break the progress
  // stream above.
  try {
    const { runs, stopRun, onRunEnded } = useDesktopLocalRuns();

    // The Windows taskbar thumbnail toolbar's "Stop" button reaches the
    // dashboard as this event.
    tauriEvent()
      ?.listen('piwi:taskbar-stop', () => {
        for (const run of runs.value) {
          if (run.status === 'running') void stopRun(run);
        }
      })
      .catch(() => {});

    // The tray's Stop item of one run reaches the dashboard with the shell id of the run's current step, so the run
    // stops as with its own Stop. A process no window run owns (left by a reload) is stopped by the shell directly.
    tauriEvent()
      ?.listen<number>('piwi:tray-stop', ({ payload }) => {
        const run = runs.value.find((r) => r.shellId === payload);
        if (run) void stopRun(run);
        else
          void tauriCore()
            ?.invoke('desktop_stop_local_tests', { runId: payload })
            .catch(() => {});
      })
      .catch(() => {});

    // A stopped local process the shell had to kill never reports its end, and
    // the server marks its runs interrupted only after the stale timeout, so its
    // own runs leave the bar once the process is gone; so do a job's, whose
    // verdict then flashes. A run that ended on its own reported the end of each
    // run that began: only those that never began leave. Every other run stays:
    // an editor's, CI's, another local run's.
    onRunEnded((run) => {
      const gone =
        run.status === 'stopped' || run.kind !== 'tests'
          ? runsOfLocalRun(active, run, runs.value)
          : unbegunRunsOf(active, run, runs.value);
      const now = Date.now();
      for (const [id, at] of swept) if (now - at >= SWEPT_MS) swept.delete(id);
      let changed = false;
      for (const id of gone) {
        swept.set(id, now);
        changed = active.delete(id) || changed;
      }
      const flash = run.kind === 'tests' ? null : finishedJobFlash({ ...run, kind: run.kind });
      if (flash) {
        lastFinished = flash;
        changed = true;
      }
      if (changed) pushUpdate();
    });
  } catch {
    // Local-run store unavailable at init — progress still works.
  }
});
