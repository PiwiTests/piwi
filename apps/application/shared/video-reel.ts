/**
 * The run page's Video tab: where a test sits in its recorded video, and the reels the tab plays.
 *
 * A Playwright video starts when the page is created, not when the test does, so the test's clock is mapped onto the
 * video's. A reel is the final attempts of a run in the order the tab plays them. Pure, so the server, the demo and the
 * page share them.
 */
import { compareWorkers, shownWorkerNumber, workerKey } from './worker-lane';

/** How long before the end of the `Create page` step the recording starts. */
export const VIDEO_ANCHOR_OFFSET_MS = 55;
/** How far a mapped time may sit from the frame that shows it: the spread between the runs that measured the anchor. */
export const VIDEO_TIMING_TOLERANCE_MS = 60;

/** The title of the step Playwright runs to create the page a video records. */
const CREATE_PAGE_STEP = 'Create page';

/** A stored step, as far as the timing map reads it. */
export interface TimingStep {
  title: string;
  startTime?: number | null;
  duration?: number | null;
}

/** When the first `Create page` step of an execution ended (epoch ms), or null when the steps hold none. */
export function createPageEndMs(steps: readonly TimingStep[] | null | undefined): number | null {
  let end: number | null = null;
  let start = Infinity;
  for (const step of steps ?? []) {
    if (step.title !== CREATE_PAGE_STEP) continue;
    if (typeof step.startTime !== 'number' || typeof step.duration !== 'number') continue;
    if (step.startTime < start) {
      start = step.startTime;
      end = step.startTime + step.duration;
    }
  }
  return end;
}

/** What the timing map reads of an execution. */
export interface VideoTimingInput {
  /** When the test started, epoch ms; null when the reporter sent none. */
  startedAtMs: number | null;
  /** The test's duration in ms; null when none was recorded. */
  durationMs: number | null;
  /** The end of its `Create page` step, epoch ms, from `createPageEndMs`; null when there is none. */
  createPageEndMs: number | null;
}

export interface VideoTimingMap {
  /** `create-page`: anchored on the end of the `Create page` step. `start`: on the test's start, which can be a browser launch early. */
  source: 'create-page' | 'start';
  /** The epoch ms the video's first frame shows. */
  videoStartMs: number;
  /** When the test started and ended, epoch ms. */
  testStartMs: number;
  testEndMs: number;
  /** The video time of an epoch ms, held to `[0, the video's length]`. */
  toVideoMs: (epochMs: number) => number;
}

/** Maps a test's clock onto its video's; `videoDurationMs` is the length of the video once it is known. */
export function videoTimingMap(input: VideoTimingInput, videoDurationMs?: number | null): VideoTimingMap | null {
  const testStartMs = input.startedAtMs;
  if (testStartMs == null) return null;
  const anchored = input.createPageEndMs != null;
  const videoStartMs = anchored ? input.createPageEndMs! - VIDEO_ANCHOR_OFFSET_MS : testStartMs;
  const limit = videoDurationMs != null && videoDurationMs >= 0 ? videoDurationMs : Infinity;
  return {
    source: anchored ? 'create-page' : 'start',
    videoStartMs,
    testStartMs,
    testEndMs: testStartMs + Math.max(0, input.durationMs ?? 0),
    toVideoMs: (epochMs) => Math.min(limit, Math.max(0, epochMs - videoStartMs)),
  };
}

/** Where a test starts and ends in its video, in ms; the test's end is not the file's, which holds a frozen tail. */
export function testSpanInVideo(map: VideoTimingMap): { startMs: number; endMs: number } {
  return { startMs: map.toVideoMs(map.testStartMs), endMs: map.toVideoMs(map.testEndMs) };
}

/** The video an execution attached. */
export interface ReelVideo {
  id: number;
  path: string;
  contentType: string;
  size: number | null;
}

/** An execution of a run, as `GET /api/test-runs/:id/videos` lists it. */
export interface ReelExecution {
  executionId: number;
  testCaseId: number;
  title: string;
  filePath: string;
  line: number | null;
  column: number | null;
  status: string;
  /** The retry this attempt was, 0 for the first. */
  retries: number;
  repeatEachIndex: number;
  browserName: string | null;
  passedAfterFailure: boolean;
  shardIndex: number | null;
  parallelIndex: number | null;
  workerIndex: number | null;
  startedAt: number | null;
  durationMs: number | null;
  createPageEndMs: number | null;
  video: ReelVideo | null;
}

export type ReelGroup = 'worker' | 'file';

export interface ReelEntry {
  execution: ReelExecution;
  /** The worker it ran on (`Worker 2`), null when the result names none. */
  laneLabel: string | null;
  /** The video plays up to here, in ms: where the test ends in it. 0 for a test with no video. */
  lengthMs: number;
  /** Where the entry starts on the reel, in ms of playing time. */
  reelStartMs: number;
}

export interface Reel {
  key: string;
  label: string;
  entries: ReelEntry[];
  /** Entries with a video. */
  videoCount: number;
  /** The playing time of the reel, in ms. */
  totalMs: number;
  hasFailure: boolean;
}

/** An execution a reel lists: one that ran. */
function ran(execution: ReelExecution): boolean {
  return execution.status !== 'skipped' && execution.status !== 'didnotrun';
}

/** The final attempt of each test result: the highest retry of a test case, browser project and repetition. */
function finalAttempts(executions: readonly ReelExecution[]): ReelExecution[] {
  const finals = new Map<string, ReelExecution>();
  for (const execution of executions) {
    const key = `${execution.testCaseId}\x00${execution.browserName ?? ''}\x00${execution.repeatEachIndex}`;
    const earlier = finals.get(key);
    if (!earlier || execution.retries >= earlier.retries) finals.set(key, execution);
  }
  return [...finals.values()];
}

function entryFor(execution: ReelExecution): Omit<ReelEntry, 'reelStartMs'> {
  const worker = shownWorkerNumber(execution);
  const laneLabel =
    worker == null ? null : `Worker ${worker}${execution.shardIndex != null ? ` (shard ${execution.shardIndex})` : ''}`;
  const map = execution.video
    ? videoTimingMap({
        startedAtMs: execution.startedAt,
        durationMs: execution.durationMs,
        createPageEndMs: execution.createPageEndMs,
      })
    : null;
  return { execution, laneLabel, lengthMs: map ? testSpanInVideo(map).endMs : 0 };
}

/** Puts the entries on one reel, each starting where the one before ends. */
function toReel(key: string, label: string, executions: ReelExecution[]): Reel {
  let at = 0;
  const entries = executions.map((execution) => {
    const entry = { ...entryFor(execution), reelStartMs: at };
    at += entry.lengthMs;
    return entry;
  });
  return {
    key,
    label,
    entries,
    videoCount: entries.filter((e) => e.execution.video).length,
    totalMs: at,
    hasFailure: entries.some((e) => statusIsFailure(e.execution.status)),
  };
}

function statusIsFailure(status: string): boolean {
  return status === 'failed' || status === 'timedout' || status === 'timedOut';
}

/** Order by when the tests started, then by id for the ones that did not say. */
function byStart(a: ReelExecution, b: ReelExecution): number {
  return (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.executionId - b.executionId;
}

/** Order the way the spec files declare the tests: file, then line, then column. */
function byDeclaration(a: ReelExecution, b: ReelExecution): number {
  return (
    a.filePath.localeCompare(b.filePath) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    a.title.localeCompare(b.title) ||
    a.executionId - b.executionId
  );
}

/**
 * The reels of a run: its final attempts that ran, an earlier attempt of a retried test never among them.
 * `worker`: one reel per worker lane, each test after the one before it on that worker, in the order they ran. `file`:
 * one reel, every test in the order its file declares, each tagged with its worker. A test with no video stays on the
 * reel as an entry that takes no playing time.
 */
export function buildReel(executions: readonly ReelExecution[], group: ReelGroup): Reel[] {
  const finals = finalAttempts(executions).filter(ran);
  if (finals.length === 0) return [];
  if (group === 'file') return [toReel('file', 'All files', finals.sort(byDeclaration))];

  const lanes = new Map<string, ReelExecution[]>();
  for (const execution of finals) {
    const key = workerKey(execution) ?? 'none';
    const lane = lanes.get(key);
    if (lane) lane.push(execution);
    else lanes.set(key, [execution]);
  }
  return [...lanes.entries()]
    .sort(([, a], [, b]) => compareWorkers(a[0]!, b[0]!))
    .map(([key, lane]) => {
      lane.sort(byStart);
      return toReel(key, entryFor(lane[0]!).laneLabel ?? 'No worker', lane);
    });
}

/** Where playback stands: the entry a video plays, and how far into it, in ms of video. */
export interface ReelCursor {
  index: number;
  videoMs: number;
  /** Where the playing test ends in its video once the video's length is known; else the entry's `lengthMs`. */
  endMs?: number;
}

/**
 * Whether each entry is ticked at the cursor: every entry before the playing one, and the playing one once its video
 * passes the end of the test. An entry with no video takes no playing time, so it ticks with the entry before it.
 * Null before playback has begun: nothing is ticked.
 */
export function tickedEntries(reel: Reel, cursor: ReelCursor | null): boolean[] {
  const ticked: boolean[] = [];
  reel.entries.forEach((entry, i) => {
    if (cursor == null) ticked.push(false);
    else if (i < cursor.index) ticked.push(true);
    else if (entry.execution.video == null) ticked.push(i === 0 || ticked[i - 1]!);
    else ticked.push(i === cursor.index && cursor.videoMs >= (cursor.endMs ?? entry.lengthMs));
  });
  return ticked;
}
