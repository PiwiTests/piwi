/**
 * Aggregate the in-flight test runs into a single progress descriptor for the
 * OS shell — the taskbar/Dock progress bar, the window title and the tray
 * tooltip/icon. A window has one taskbar button, so many concurrent runs
 * collapse to one bar: the summed fraction across runs whose total is known, or
 * an indeterminate bar while any active run has no total yet. Once any of them
 * has a failed test the bar turns red and so does the status dot.
 *
 * Runs here are the app's *live* runs — every run reported into the app (from
 * CI, a terminal, or the desktop's own "Run locally"), not just ones launched
 * from the app. The desktop plugin (`desktop-run-progress.client.ts`) streams
 * them from `/api/desktop/events` and feeds the result to the shell's
 * `desktop_set_run_progress` command. Pure and framework-free so it is unit-tested.
 */
import type { RunOriginKind } from '@piwitests/core/wire';
import { UNATTENDED_RUN_SUFFIX, isUnattendedDesktopRun } from '#shared/desktop-runs';
import type { LocalRun } from '~/composables/useDesktopLocalRuns';
import { localRunOriginKind } from '~/utils/desktop-job';

/** Mirrors the shell's `desktop_set_run_progress` `state` argument. */
export type RunProgressState = 'none' | 'indeterminate' | 'normal' | 'error' | 'paused';

export interface AggregatedRunProgress {
  state: RunProgressState;
  /** 0–1 when determinate; `null` for an indeterminate or cleared bar. */
  fraction: number | null;
  /** Detail line for the window title and tray tooltip; `null` when cleared. */
  label: string | null;
  /** A test has failed in an active run — the shell shows a red status dot. */
  failing: boolean;
}

/** The completion tally + planned total of one run, as the counts aggregate needs them. */
export interface RunCounts {
  status: string;
  /** Tests finished so far (passed + failed + skipped + did-not-run). */
  done: number;
  /** Planned suite size; `0`/unknown makes the run (and the bar) indeterminate. */
  total: number;
  /** Failed attempts so far — a flaky test's failed first try counts. */
  failed: number;
}

/** What launched a run, as the desktop event stream sends it with each run's lifecycle; null where it named none. */
export interface LiveRunOrigin {
  /** What launched the run (`desktop`, `bisect`, `ci`…). */
  origin: string | null;
  /** What the run was launched for (`PIWI_ORIGIN_REF`). */
  originRef: string | null;
  /** The launcher's name for the run (`PIWI_RUN_REF`): `desktop-<id>` for a run the shell started. */
  runName: string | null;
}

/** An in-flight run as the desktop plugin tracks it: its counts, its project and what launched it. */
export interface LiveRun extends RunCounts, LiveRunOrigin {
  projectId: number | null;
}

/** The origins of runs nobody attends: a bisect's steps, and a Flake Lab's and a probe's runs. */
const UNATTENDED_RUN_ORIGINS: ReadonlySet<string> = new Set<RunOriginKind>(['bisect', 'flake-lab', 'probe']);

/**
 * Whether nobody attends a run: a bisect's step or a lab run, or one the shell names so (`isUnattendedDesktopRun`, a
 * run that repeats its tests or runs in UI mode). Its end flashes nothing on the shell, so a bisect's bad steps neither
 * show "Run failed" nor ask for the user's attention.
 */
export function isUnattendedLiveRun(run: Pick<LiveRunOrigin, 'origin' | 'runName'>): boolean {
  if (run.origin != null && UNATTENDED_RUN_ORIGINS.has(run.origin)) return true;
  return run.runName != null && isUnattendedDesktopRun(run.runName);
}

/** The cleared state — no active runs, nothing on the shell. */
export const NO_RUN_PROGRESS: AggregatedRunProgress = { state: 'none', fraction: null, label: null, failing: false };

/** Run statuses that count as in-flight (mirrors the server's ACTIVE_STATUSES). */
export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(['running', 'initializing', 'finalizing']);

/**
 * Fold the in-flight runs into one progress descriptor. Only active runs count;
 * with none active it returns the cleared state (the plugin decides whether to
 * flash a finished run's outcome first).
 */
export function aggregateRunProgress(runs: readonly RunCounts[]): AggregatedRunProgress {
  const active = runs.filter((r) => ACTIVE_RUN_STATUSES.has(r.status));
  if (active.length === 0) return NO_RUN_PROGRESS;

  const done = active.reduce((sum, r) => sum + Math.max(0, r.done), 0);
  const total = active.reduce((sum, r) => sum + Math.max(0, r.total), 0);
  // Indeterminate while any active run hasn't reported a total yet — a partial
  // sum would make the bar jump backwards when that run's total lands.
  const countless = active.some((r) => r.total <= 0);
  const fraction = countless || total <= 0 ? null : Math.min(done / total, 1);
  const failed = active.reduce((sum, r) => sum + Math.max(0, r.failed), 0);
  const failing = failed > 0;

  const head =
    fraction != null ? `Running ${done}/${total}` : active.length > 1 ? `Running ${active.length} runs` : 'Running';
  const details: string[] = [];
  if (fraction != null && active.length > 1) details.push(`${active.length} runs`);
  if (failing) details.push(`${failed} failed`);
  const label = details.length > 0 ? [head, ...details].join(' · ') : `${head}…`;

  // An indeterminate bar has no colour, so a failing one stays indeterminate
  // and only the status dot shows the failure.
  const state = fraction == null ? 'indeterminate' : failing ? 'error' : 'normal';
  return { state, fraction, label, failing };
}

/** How long a finished run's outcome stays on the shell before the bar clears. */
export const PASS_FLASH_MS = 3000;
export const FAIL_FLASH_MS = 5000;

export interface FinishedRunFlash {
  progress: AggregatedRunProgress;
  durationMs: number;
}

/**
 * What the shell shows once the last active run ends with `status`, and for how
 * long, or `null` to clear the bar at once. A pass flashes green, an
 * interrupted run (stopped, or its reporter lost) amber, any other failure red;
 * a cancelled run clears without a flash.
 */
export function finishedRunFlash(status: string): FinishedRunFlash | null {
  switch (status) {
    case 'passed':
      return {
        progress: { state: 'normal', fraction: 1, label: 'Run passed', failing: false },
        durationMs: PASS_FLASH_MS,
      };
    case 'interrupted':
      return {
        progress: { state: 'paused', fraction: 1, label: 'Run interrupted', failing: false },
        durationMs: FAIL_FLASH_MS,
      };
    case 'cancelled':
      return null;
    default:
      return {
        progress: { state: 'error', fraction: 1, label: 'Run failed', failing: false },
        durationMs: FAIL_FLASH_MS,
      };
  }
}

/** A stopped local run, as far as finding the runs it produced goes. */
export type StoppedLocalRun = Pick<
  LocalRun,
  'kind' | 'projectId' | 'originRef' | 'hubRefs' | 'piwiRunId' | 'piwiRunBaseline'
>;

/**
 * The tracked runs a stopped local run produced, which a process the shell had to kill never reported the end of: the
 * Piwi run it is linked to, and each run of its project its steps named (`hubRefs`, names only the shell's own runs
 * carry), newer than its baseline when it has one (a Flake Lab session has none). A run the reporter recorded no name
 * for is its own when it is newer than its baseline and stamped with its origin and reference, as the lookup linking it
 * reads them (`correlatePiwiRuns`), while no other local run shares that reference (`sharedReference`). Every other
 * run, another local run's, an editor's or a CI run, stays.
 */
export function runsOfStoppedLocalRun(
  active: ReadonlyMap<number, LiveRun>,
  run: StoppedLocalRun,
  sharedReference: boolean,
): number[] {
  const origin = localRunOriginKind(run.kind);
  const names = new Set(run.hubRefs.flatMap((ref) => [ref, `${ref}${UNATTENDED_RUN_SUFFIX}`]));
  const owns = (id: number, live: LiveRun): boolean => {
    if (id === run.piwiRunId) return true;
    if (run.piwiRunBaseline != null && id <= run.piwiRunBaseline) return false;
    if (live.projectId == null || String(live.projectId) !== run.projectId) return false;
    if (live.runName != null) return names.has(live.runName);
    return (
      run.piwiRunBaseline != null &&
      !sharedReference &&
      origin != null &&
      live.origin === origin &&
      run.originRef != null &&
      live.originRef === run.originRef
    );
  };
  return [...active].filter(([id, live]) => owns(id, live)).map(([id]) => id);
}
