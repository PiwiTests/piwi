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
 * `desktop_set_run_progress` command. A step of a job (a reproduction, a bisect,
 * a Flake Lab session) shows as progress alone: its failures are its job's to
 * judge, so the job's verdict flashes once (`finishedJobFlash`), never the
 * step's end. Pure and framework-free so it is unit-tested.
 */
import type { SpecRunVerdict } from '@piwitests/core/bug-report';
import { UNATTENDED_RUN_SUFFIX } from '#shared/desktop-runs';
import { localRunOriginKind } from '~/utils/desktop-job';
import { reproVerdictText } from '~/utils/repro-verdict';

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
  /** A step of a job: its failed attempts never make the bar failing. */
  job?: boolean;
}

/**
 * What launched an in-flight run, as the desktop event stream names it once the run has begun
 * (`server/utils/desktop-run-facts.ts`); all null, and no job, until then.
 */
export interface LiveRunFacts {
  origin: string | null;
  originRef: string | null;
  /** The name its launcher gave it (`PIWI_RUN_REF`), when the reporter recorded one. */
  name: string | null;
  /** A step of a job: a reproduction, a bisect step, a Flake Lab or probe run. */
  job: boolean;
}

/** An in-flight run as the desktop plugin tracks it: its counts, its project and what launched it. */
export interface LiveRun extends RunCounts, LiveRunFacts {
  projectId: number | null;
  job: boolean;
}

/** The facts of a run the stream named none for yet. */
export const NO_LIVE_RUN_FACTS: LiveRunFacts = { origin: null, originRef: null, name: null, job: false };

/** The facts a message of the desktop event stream names, or null for one that names none. */
export function liveRunFacts(message: {
  origin?: unknown;
  originRef?: unknown;
  name?: unknown;
  job?: unknown;
}): LiveRunFacts | null {
  if (typeof message.origin !== 'string') return null;
  return {
    origin: message.origin,
    originRef: typeof message.originRef === 'string' ? message.originRef : null,
    name: typeof message.name === 'string' ? message.name : null,
    job: message.job === true,
  };
}

/** The cleared state — no active runs, nothing on the shell. */
export const NO_RUN_PROGRESS: AggregatedRunProgress = { state: 'none', fraction: null, label: null, failing: false };

/** Run statuses that count as in-flight (mirrors the server's ACTIVE_STATUSES). */
export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(['running', 'initializing', 'finalizing']);

/**
 * Fold the in-flight runs into one progress descriptor. Only active runs count;
 * with none active it returns the cleared state (the plugin decides whether to
 * flash a finished run's outcome first). While tests wait at a stop for the
 * person (`waiting`, from the hub's runs: `runsAttention`), the shell shows that
 * first, amber (`paused`), whatever runs or failed: `1 test waits for you`.
 */
export function aggregateRunProgress(runs: readonly RunCounts[], waiting = 0): AggregatedRunProgress {
  const active = runs.filter((r) => ACTIVE_RUN_STATUSES.has(r.status));
  const running = aggregateRunning(active);
  if (waiting <= 0) return running;
  const waits = waiting === 1 ? '1 test waits for you' : `${waiting} tests wait for you`;
  return {
    state: 'paused',
    // A paused bar keeps the value it was given last: a full one while the progress is not known.
    fraction: running.fraction ?? 1,
    label: running.label ? `${waits} · ${running.label.replace(/…$/, '')}` : waits,
    failing: running.failing,
  };
}

/** The active runs' progress alone, as the shell shows it while no test waits. */
function aggregateRunning(active: readonly RunCounts[]): AggregatedRunProgress {
  if (active.length === 0) return NO_RUN_PROGRESS;

  const done = active.reduce((sum, r) => sum + Math.max(0, r.done), 0);
  const total = active.reduce((sum, r) => sum + Math.max(0, r.total), 0);
  // Indeterminate while any active run hasn't reported a total yet — a partial
  // sum would make the bar jump backwards when that run's total lands.
  const countless = active.some((r) => r.total <= 0);
  const fraction = countless || total <= 0 ? null : Math.min(done / total, 1);
  const failed = active.reduce((sum, r) => sum + (r.job ? 0 : Math.max(0, r.failed)), 0);
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

/** A finished job of the Local runs tray (`LocalRun`), as far as its flash goes. */
export interface FinishedJob {
  kind: 'reproduce' | 'repro' | 'bisect' | 'flake';
  status: 'running' | 'passed' | 'failed' | 'stopped' | 'error';
  exitCode: number | null;
  /** The phase it ended in: `test` once a reproduction's tests ran. */
  phase: string | null;
  bisect: { firstBad: { sha: string } | null } | null;
  repro: { verdict: SpecRunVerdict | null } | null;
}

const JOB_NAMES: Record<FinishedJob['kind'], string> = {
  reproduce: 'Reproduction',
  repro: 'Bug report steps',
  bisect: 'Bisect',
  flake: 'Flake Lab',
};

/** A job's verdict in the words of the tray and its toasts, and whether it flashes as a pass or as a failure. */
function jobVerdict(job: FinishedJob): { passed: boolean; label: string } {
  if (job.status === 'error') return { passed: false, label: `${JOB_NAMES[job.kind]} could not run` };
  const passed = job.status === 'passed';
  switch (job.kind) {
    case 'bisect': {
      const found = job.bisect?.firstBad;
      return found
        ? { passed: true, label: `Bisect found ${found.sha.slice(0, 7)}` }
        : { passed: false, label: 'Bisect did not finish' };
    }
    case 'flake':
      if (!passed) return { passed, label: 'Flake Lab could not run' };
      return { passed, label: job.exitCode === 0 ? 'Flake reproduced' : 'Flake not reproduced' };
    case 'repro': {
      const verdict = job.repro?.verdict;
      if (verdict && verdict.kind !== 'stopped') return { passed, label: reproVerdictText(verdict).label };
      return { passed, label: passed ? 'Not reproduced' : 'Bug reproduced' };
    }
    default:
      if (passed) return { passed, label: 'Not reproduced' };
      return { passed, label: job.phase === 'test' ? 'Reproduced' : 'Reproduction could not run' };
  }
}

/**
 * What the shell shows once a job's process ends, the one flash of all its steps, or `null` to clear the bar: green
 * for a job that passed (a bisect that named its first bad commit, a Flake Lab that reached a verdict, a reproduction
 * whose tests passed), red for one that failed or could not run, which asks for attention, nothing for one stopped.
 */
export function finishedJobFlash(job: FinishedJob): FinishedRunFlash | null {
  if (job.status === 'running' || job.status === 'stopped') return null;
  const { passed, label } = jobVerdict(job);
  const flash = finishedRunFlash(passed ? 'passed' : 'failed')!;
  return { ...flash, progress: { ...flash.progress, label } };
}

/** A run of the Local runs tray (`LocalRun`), as far as finding the runs its process reported goes. */
export interface LocalRunOwner {
  key: number;
  kind: FinishedJob['kind'] | 'tests' | 'request';
  projectId: string;
  /** The reference its runs record as their origin's (`PIWI_ORIGIN_REF`). */
  originRef: string | null;
  /** The names its steps gave its runs (`PIWI_RUN_REF`), each without the mark of a run nobody attends. */
  hubRefs: readonly string[];
  /** The project's newest run id when it was spawned; null when the lookup failed. */
  piwiRunBaseline: number | null;
  /** A bisect that runs this test's Flake Lab arm at each step: its steps' runs are lab runs. */
  flakeTestCaseId: number | null;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * The origin its process's runs record, with their reference: a Flake Lab session's, and a bisect's that runs a Flake
 * Lab arm at each step, are lab runs, whose reference names the lab's experiment (null: any).
 */
function recordedOrigin(owner: LocalRunOwner): { origin: string; ref: string | null } | null {
  if (owner.kind === 'flake' || (owner.kind === 'bisect' && owner.flakeTestCaseId != null)) {
    return { origin: 'flake-lab', ref: null };
  }
  const origin = localRunOriginKind(owner.kind);
  return origin && owner.originRef != null ? { origin, ref: owner.originRef } : null;
}

/** Whether two runs of the tray go on at once in one project under the same origin and reference. */
function sharesOrigin(a: LocalRunOwner, b: LocalRunOwner): boolean {
  const [ours, theirs] = [recordedOrigin(a), recordedOrigin(b)];
  return (
    a.key !== b.key &&
    a.projectId === b.projectId &&
    !!ours &&
    !!theirs &&
    ours.origin === theirs.origin &&
    ours.ref === theirs.ref &&
    a.startedAt <= (b.finishedAt ?? Infinity) &&
    b.startedAt <= (a.finishedAt ?? Infinity)
  );
}

/**
 * The tracked runs of a local run's project numbered above its baseline that have not begun (a run's global setup
 * goes before its reporter names what launched it), once its process is gone: its own, as one whose global setup
 * failed or that was stopped there. A run above the baseline of another run of the tray still going on in the project
 * (`runs`) could be that one's, and stays. A terminal's or an editor's run in its global setup goes too.
 */
export function unbegunRunsOf(
  active: ReadonlyMap<number, LiveRun>,
  owner: LocalRunOwner,
  runs: readonly LocalRunOwner[],
): number[] {
  const baseline = owner.piwiRunBaseline;
  if (baseline == null) return [];
  const others = runs.filter(
    (other) =>
      other.key !== owner.key &&
      other.projectId === owner.projectId &&
      other.finishedAt == null &&
      other.piwiRunBaseline != null,
  );
  const ids: number[] = [];
  for (const [id, run] of active) {
    if (run.origin !== null || id <= baseline || run.projectId == null) continue;
    if (String(run.projectId) !== owner.projectId) continue;
    if (others.some((other) => other.piwiRunBaseline! < id)) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * The tracked runs a local process produced, once it is gone, among the runs of its project numbered above its
 * baseline: those that record its origin and reference, under one of the names its steps gave them, as the run it
 * links to is found (`correlatePiwiRuns`), and those that have not begun (`unbegunRunsOf`). A run whose reporter
 * recorded no name is its own only while no other run of the tray (`runs`) goes on under the same origin and
 * reference. A lab run, of a Flake Lab session or of a bisect that runs a Flake Lab arm at each step, is found by its
 * origin alone (`flake-lab`), its reference naming the lab's experiment: a `piwi flake` going on at once in the
 * project from a terminal or an editor, which records no name either, is taken with it. Any other run of an editor,
 * CI or a terminal that has begun is never one of them.
 */
export function runsOfLocalRun(
  active: ReadonlyMap<number, LiveRun>,
  owner: LocalRunOwner,
  runs: readonly LocalRunOwner[],
): number[] {
  const baseline = owner.piwiRunBaseline;
  if (baseline == null) return [];
  const recorded = recordedOrigin(owner);
  const names = new Set(owner.hubRefs.flatMap((ref) => [ref, `${ref}${UNATTENDED_RUN_SUFFIX}`]));
  const shared = runs.some((other) => sharesOrigin(owner, other));
  const ids = unbegunRunsOf(active, owner, runs);
  for (const [id, run] of active) {
    if (run.origin === null || id <= baseline || run.projectId == null) continue;
    if (String(run.projectId) !== owner.projectId) continue;
    if (!recorded || run.origin !== recorded.origin) continue;
    if (recorded.ref !== null && run.originRef !== recorded.ref) continue;
    if (run.name === null ? shared : !names.has(run.name)) continue;
    ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

/**
 * Whether the run `id`, which named what launched it (`liveRunFacts`), is a run of one of this window's local runs
 * (`runsOfLocalRun`), one whose baseline was never read counting from the project's first run. Only such a run's end
 * flashes on the shell and asks for attention: a run of an editor, of a terminal, of CI, of another window or of one
 * from before a reload never does.
 */
export function trayListsRun(id: number, run: LiveRun, owners: readonly LocalRunOwner[]): boolean {
  const one = new Map([[id, run]]);
  return owners.some((owner) =>
    runsOfLocalRun(one, { ...owner, piwiRunBaseline: owner.piwiRunBaseline ?? 0 }, owners).includes(id),
  );
}

/**
 * The run of this window the taskbar thumbnail's Stop stops: the one started last of those still running that no Stop
 * was asked of yet, so a second click stops the next one rather than killing it; none when no such run runs.
 */
export function thumbnailStopRun<
  T extends Pick<LocalRunOwner, 'startedAt'> & { status: string; stopRequested?: boolean },
>(runs: readonly T[]): T | null {
  return runs
    .filter((run) => run.status === 'running' && !run.stopRequested)
    .reduce<T | null>((latest, run) => (latest && latest.startedAt >= run.startedAt ? latest : run), null);
}
