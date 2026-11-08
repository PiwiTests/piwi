/**
 * Desktop shell: what an editor's job (reproduce or bisect a failure from the
 * instance the editor reads, or run a flaky test's Flake Lab experiment) ended
 * with, and the origin reference each local run is stamped with so the window
 * finds the run the reporter recorded.
 */
import type { DesktopJobVerdict, FlakeLabJobReport } from '@piwitests/core/desktop-job';
import type { RunOriginKind } from '@piwitests/core/wire';

/** The fields of a local run a job's verdict reads. */
export interface JobRunOutcome {
  kind: 'tests' | 'reproduce' | 'bisect' | 'repro' | 'flake' | 'request';
  status: 'running' | 'passed' | 'failed' | 'stopped' | 'error';
  /** The phase the run was in when it ended: `test` once the failing tests ran. */
  phase: string | null;
  bisect: { firstBad: { sha: string; subject: string; author: string | null; date: string | null } | null } | null;
  /** What a Flake Lab job's `piwi flake --json` printed, read by {@link flakeLabJobReport}. */
  labReport?: FlakeLabJobReport | null;
  lines: Array<{ text: string; error: boolean }>;
}

function lastError(run: JobRunOutcome, fallback: string): string {
  return (run.lines.findLast((l) => l.error)?.text ?? fallback).slice(0, 500);
}

const LAB_VERDICTS: ReadonlyArray<FlakeLabJobReport['verdict']> = ['reproduced', 'amplified', 'not-reproduced'];

function whole(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * The report `piwi flake --json` prints, as a Flake Lab job returns it: the
 * verdict, the reproducing arm, the commit and each arm that ran (an arm the
 * budget skipped measured nothing). Null when it is not a reproduce report.
 */
export function flakeLabJobReport(json: unknown): FlakeLabJobReport | null {
  if (!json || typeof json !== 'object') return null;
  const report = json as Record<string, unknown>;
  const verdict = LAB_VERDICTS.find((v) => v === report.verdict);
  if (report.kind !== 'reproduce' || !verdict || !Array.isArray(report.arms)) return null;
  const arms = report.arms.flatMap((value) => {
    const arm = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    if (typeof arm.id !== 'string' || arm.skipped) return [];
    return [
      {
        id: arm.id,
        runs: whole(arm.runs),
        matchingFailures: whole(arm.matchingFailures),
        otherFailures: whole(arm.otherFailures),
        discardedRounds: whole(arm.discardedRounds),
        stoppedEarly: arm.stoppedEarly === true,
      },
    ];
  });
  if (!arms.some((a) => a.id === 'control')) return null;
  return {
    verdict,
    reproducingArm: typeof report.reproducingArm === 'string' ? report.reproducingArm : null,
    commit: typeof report.commit === 'string' && /^[0-9a-f]{7,40}$/.test(report.commit) ? report.commit : null,
    arms,
  };
}

/**
 * A finished job run's verdict: a bisect names its first bad commit or says
 * why it could not; a reproduction reproduced when the failing tests failed
 * again, did not when they passed, and is an error when it ended before they
 * ran; a Flake Lab run returns what the lab measured, an error when it printed
 * no report.
 */
export function desktopJobVerdict(run: JobRunOutcome): DesktopJobVerdict {
  if (run.status === 'stopped') return { kind: 'stopped' };
  if (run.kind === 'flake') {
    return run.labReport
      ? { kind: 'lab', report: run.labReport }
      : { kind: 'error', reason: lastError(run, 'Flake Lab printed no results.') };
  }
  if (run.kind === 'bisect') {
    const found = run.bisect?.firstBad;
    return found
      ? { kind: 'first-bad', commit: { ...found } }
      : { kind: 'error', reason: lastError(run, 'The bisect did not name a commit.') };
  }
  if (run.status === 'error' || run.phase !== 'test') {
    return { kind: 'error', reason: lastError(run, 'The run ended before the tests ran.') };
  }
  return run.status === 'passed' ? { kind: 'not-reproduced' } : { kind: 'reproduced' };
}

/** The origin the reporter records for a local run of this kind; null for a Flake Lab session's lab runs. */
export function localRunOriginKind(kind: JobRunOutcome['kind']): RunOriginKind | null {
  if (kind === 'tests') return 'desktop';
  if (kind === 'reproduce' || kind === 'repro') return 'reproduce';
  if (kind === 'bisect') return 'bisect';
  return null;
}

/** A reference for a local run nothing else names: unique, in the characters a reference allows. */
export function newLocalRunRef(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
