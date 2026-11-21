/**
 * The CI runs of a project in progress, as a surface lists them beside the runs it follows: read-only, since they run
 * on CI and nothing a surface holds steers them, but for **Let it go** on a test held at its failure for its project's
 * controllers (`CiHold`), which the instance takes from a controller's watch of its lane. Their number on the instance
 * names them (`CI run #78`), their branch and project say where they run, their tally how far they are, and their page
 * is where to watch a running test.
 */
import { isEpochMs, readLiveCall, readLiveWorkerId, type LiveCall, type LiveWorkerId } from '@piwitests/core/live-view';
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
  if (origin) return isCiOrigin(origin.kind);
  return !!fields.ci && typeof fields.ci === 'object';
}

/** Whether what launched a run (its origin, as `GET /api/test-runs/recent` lists it) makes it a CI run's. */
export function isCiOrigin(origin: string): boolean {
  return origin === 'ci' || origin === 'ci-rerun';
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

/**
 * A CI worker's test held at its failure for its project's controllers, as the run's stream says it (`live-worker`):
 * the worker (its lane in `slot`, from a reporter that says it), the failing call (its title the error, its file and
 * line its place), when the hold ends (null when the worker names no end), and the names of the controllers it is held
 * for (none when the instance knows no names).
 */
export interface CiHold {
  worker: LiveWorkerId;
  call: LiveCall;
  until: number | null;
  heldFor: string[];
}

/** The most names a hold is said to be held for, and the longest name. */
const MAX_HELD_FOR = 20;
const MAX_NAME = 100;

/**
 * The held failure a run's `live-worker` event says, checked field by field: a connected worker that can hold
 * (`holds`) standing at a stop of reason `held`; null for anything else.
 */
export function readCiHold(data: unknown): CiHold | null {
  const fields = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  if (!fields || fields.connected !== true || fields.holds !== true) return null;
  const worker = readLiveWorkerId(fields.shard, fields.worker, fields.slot);
  const paused = fields.paused && typeof fields.paused === 'object' ? (fields.paused as Record<string, unknown>) : null;
  if (!worker || paused?.reason !== 'held') return null;
  const call = readLiveCall(paused.call);
  if (!call) return null;
  const names = Array.isArray(fields.heldFor) ? fields.heldFor : [];
  return {
    worker,
    call,
    until: isEpochMs(paused.until) ? Math.round(paused.until) : null,
    heldFor: names
      .filter((name): name is string => typeof name === 'string' && !!name.trim())
      .slice(0, MAX_HELD_FOR)
      .map((name) => name.slice(0, MAX_NAME)),
  };
}

/**
 * The hold of a CI lane (`slot`, Playwright's `parallelIndex`, in its shard) among a run's holds: the one of the lane's
 * worker (`worker`) that names the lane, or, from a reporter that names none, the one of that worker. A hold of
 * another worker of the lane, one that left it, is none of its test's; with the worker unknown (null), the lane's.
 */
export function ciHoldOf(
  holds: Iterable<CiHold>,
  lane: { shard: number | null; slot: number },
  worker: number | null,
): CiHold | null {
  for (const hold of holds) {
    if (hold.worker.shard !== lane.shard) continue;
    if (worker !== null && hold.worker.worker !== worker) continue;
    if (hold.worker.slot !== undefined ? hold.worker.slot === lane.slot : worker !== null) return hold;
  }
  return null;
}

/** A time of day as the surface's clock reads it: hours and minutes, in its locale. */
export function clockTime(time: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(time);
}

/**
 * For whom a failed CI test is held, and until when (`Held for Ana · until 12:05`), the names as the instance gives
 * them (`Held · until 12:05` for none); null for a hold that says no end.
 */
export function heldForWords(
  until: number | null | undefined,
  heldFor: readonly string[],
  speaker: RunSpeaker,
  clock: (time: number) => string = clockTime,
): string | null {
  if (until === null || until === undefined) return null;
  const time = clock(until);
  return heldFor.length
    ? speaker.say('runs_heldFor', { names: speaker.list(heldFor), time })
    : speaker.say('runs_heldUntil', { time });
}

/**
 * What a surface says of a CI test held at its failure, beside its error (the call's title): where it stands
 * (`Failed, held at its line`), for whom and until when, its place (`tests/pay.spec.ts:12`, null when the worker names
 * none), and that the CI job's own timeout still runs.
 */
export function ciHoldWords(
  hold: Pick<CiHold, 'call' | 'until' | 'heldFor'>,
  speaker: RunSpeaker,
  clock: (time: number) => string = clockTime,
): { state: string; heldFor: string | null; place: string | null; note: string } {
  const { file, line } = hold.call;
  return {
    state: speaker.say('runs_stateFailed'),
    heldFor: heldForWords(hold.until, hold.heldFor, speaker, clock),
    place: file ? (line !== null ? `${file}:${line}` : file) : null,
    note: speaker.say('runs_heldJobTimeout'),
  };
}

/**
 * Whether a surface offers **Let it go** on a CI lane: its test is held, the surface's own watch shows the lane (the
 * instance takes the command on that watch alone), and the instance said that watch counts as a controller's (its
 * `hello`'s `controller`). A surface that cannot tell offers nothing.
 */
export function offersLetGo(hold: CiHold | null, watch: { shows: boolean; controller: boolean }): boolean {
  return !!hold && watch.shows && watch.controller;
}
