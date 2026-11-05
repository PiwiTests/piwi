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
  kind: FinishedJob['kind'] | 'tests';
  projectId: string;
  /** The reference its runs record as their origin's (`PIWI_ORIGIN_REF`). */
  originRef: string | null;
  /** The names its steps gave its runs (`PIWI_RUN_REF`), each without the mark of a run nobody attends. */
  hubRefs: readonly string[];
  /** The project's newest run id when it was spawned; null when the lookup failed. */
  piwiRunBaseline: number | null;
}

/**
 * The tracked runs a local process produced, once it is gone: the runs of its project numbered above its baseline
 * that record its origin and reference, under one of the names its steps gave them when the reporter recorded one, as
 * the run it links to is found (`correlatePiwiRuns`). An editor's, CI's or a terminal's run is never one of them, nor
 * another local run's that its reporter named. None for a process whose runs record no origin of its own (a Flake Lab
 * session's).
 */
export function runsOfLocalRun(active: ReadonlyMap<number, LiveRun>, owner: LocalRunOwner): number[] {
  const origin = localRunOriginKind(owner.kind);
  if (!origin || owner.originRef == null || owner.piwiRunBaseline == null) return [];
  const names = new Set(owner.hubRefs.flatMap((ref) => [ref, `${ref}${UNATTENDED_RUN_SUFFIX}`]));
  const ids: number[] = [];
  for (const [id, run] of active) {
    if (id <= owner.piwiRunBaseline || run.projectId == null || String(run.projectId) !== owner.projectId) continue;
    if (run.origin !== origin || run.originRef !== owner.originRef) continue;
    if (run.name !== null && !names.has(run.name)) continue;
    ids.push(id);
  }
  return ids;
}
