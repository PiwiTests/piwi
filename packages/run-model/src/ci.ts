/**
 * The CI runs of a project in progress, as a surface lists them beside the runs it follows: read-only, since they run
 * on CI and nothing a surface holds steers them. Their number on the instance names them (`CI run #78`), their branch
 * and project say where they run, their tally how far they are, and their page is where to watch a running test.
 */
import { RUN_ORIGIN_METADATA_KEY, parseRunOrigin } from '@piwitests/core/wire';
import type { RunMessage, RunSpeaker } from './words';

/** A CI run in progress, as the instance lists it. */
export interface CiRun {
  /** Its number on the instance. */
  id: number;
  projectId: number;
  /** Its project's name; empty when the instance names none. */
  project: string;
  branch: string | null;
  /** `running`, `initializing` or `finalizing`. */
  status: string;
  /** ISO 8601. */
  startTime: string;
  /** How many tests it holds, how many ended, and of them how many failed and how many were flaky. */
  total: number;
  done: number;
  failed: number;
  flaky: number;
  /** Its page on the instance. */
  url: string;
}

/** The most CI runs a surface lists, the newest. */
export const MAX_CI_RUNS_LISTED = 5;

const ACTIVE = new Set(['running', 'initializing', 'finalizing']);

/** A count the instance sends, or 0. */
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * A run's tally as a surface shows it, from the instance's counts: the tests that ended (passed, failed, skipped and
 * not run), never past those it holds, which count at least those that ended.
 */
export function ciTally(run: {
  totalTests?: unknown;
  passedTests?: unknown;
  failedTests?: unknown;
  skippedTests?: unknown;
  didNotRunTests?: unknown;
  flakyTests?: unknown;
}): Pick<CiRun, 'total' | 'done' | 'failed' | 'flaky'> {
  const done = count(run.passedTests) + count(run.failedTests) + count(run.skippedTests) + count(run.didNotRunTests);
  return {
    total: Math.max(count(run.totalTests), done),
    done,
    failed: count(run.failedTests),
    flaky: count(run.flakyTests),
  };
}

/**
 * Whether a run's metadata (`GET /api/test-runs/:id`) makes it a CI run's: its origin says so, else, for a run that
 * names none, the CI it names.
 */
export function isCiMetadata(metadata: unknown): boolean {
  const fields = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const origin = parseRunOrigin(fields[RUN_ORIGIN_METADATA_KEY]);
  if (origin) return origin.kind === 'ci' || origin.kind === 'ci-rerun';
  return !!fields.ci && typeof fields.ci === 'object';
}

/** The CI runs to list: those still in progress, the newest first, `MAX_CI_RUNS_LISTED` at most. */
export function ciRunsListed(runs: readonly CiRun[]): CiRun[] {
  return runs
    .filter((r) => ACTIVE.has(r.status))
    .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime) || b.id - a.id)
    .slice(0, MAX_CI_RUNS_LISTED);
}

/** A CI run's name: `CI run #78`. */
export function ciRunName(run: Pick<CiRun, 'id'>, speaker: RunSpeaker): string {
  return speaker.say('runs_ciRun', { id: String(run.id) });
}

/**
 * Where a CI run runs, under its name: its branch, and its project when the surface lists the runs of several
 * projects; null for a run that names no branch in a list of one project.
 */
export function ciRunWhere(run: Pick<CiRun, 'branch' | 'project'>, severalProjects: boolean): RunMessage | null {
  const project = severalProjects && run.project ? run.project : null;
  if (run.branch && project) return { key: 'runs_ciWhereProject', args: { branch: run.branch, project } };
  if (run.branch) return { key: 'runs_ciWhere', args: { branch: run.branch } };
  return project ? { key: 'runs_ciProject', args: { project } } : null;
}

/** What a surface says of every CI run it lists: they run on CI, read-only, and are watched from their page. */
export const CI_READ_ONLY: RunMessage = { key: 'runs_ciReadOnly' };
