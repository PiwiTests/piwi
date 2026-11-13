import { computed, type ComputedRef } from 'vue';
import type { TestCaseResult, TestStepEvent, SetupStepEvent, PerformanceStep } from '~~/types/api';
import { isWastedWait, DEFAULT_WASTED_WAIT_PATTERNS } from '#shared/utils/wasted-waits';
import { buildStepSpans } from '~/utils/step-spans';
import { stepPhases } from '#shared/step-tree';
import { pauseSpans, pausedOverlap } from '#shared/step-analysis';
import { formatTimelineTime, lockColorHex } from '~/utils/timeline';
import type { TestStepEventHook } from '#shared/types';
import { isStuckAttempt, testAttemptKey } from '~/utils/test-attempts';
import { isFlakyExecution } from '#shared/utils/test-counts';
import { isEndedAtStop } from '#shared/utils/skip-kind';
import { workerLane } from '#shared/worker-lane';
import { runningUsualDurationTest, usualDurationKey } from '#shared/stuck-tests';

/**
 * What a timeline bar represents; drives rendering, filtering and header counts.
 * `idle` and `restart` are the empty stretches of a worker's lane: time no test
 * ran, and the start-up of a new worker process. `pause` is a stop at Piwi's
 * pause bar, which its test's bar draws as a Paused band.
 */
export type TimelineItemKind = 'test' | 'setup' | 'hook' | 'fixture' | 'wait' | 'step' | 'idle' | 'restart' | 'pause';

/** Whether a bar is hook time: a test's hook or fixture section, or a suite-level setup step. */
export function isHookKind(kind: TimelineItemKind): boolean {
  return kind === 'hook' || kind === 'fixture' || kind === 'setup';
}

/** Whether an item is an empty stretch of a lane rather than something that ran. */
export function isGapKind(kind: TimelineItemKind): boolean {
  return kind === 'idle' || kind === 'restart';
}

/** Whether an item is a test's hook section or one of its stops, which the test's own bar draws. */
export function isTestSection(item: Pick<TimelineItem, 'kind' | 'testCaseId'>): boolean {
  return (item.kind === 'hook' || item.kind === 'fixture' || item.kind === 'pause') && item.testCaseId != null;
}

/**
 * Whether an item is drawn: a hook section with the hooks shown, or when it failed, whatever the toggle says; a wasted
 * wait with the waits shown; anything else always.
 */
export function isShownItem(
  item: Pick<TimelineItem, 'kind' | 'status'>,
  shown: { hooks: boolean; waits: boolean },
): boolean {
  if (isHookKind(item.kind)) return shown.hooks || item.status === 'failed';
  if (item.kind === 'wait') return shown.waits;
  return true;
}

/** A test next to a gap, as the gap's tooltip names it. */
export interface GapNeighbor {
  title: string;
  status: string;
  /** The worker process that ran it. */
  workerIndex: number;
}

/** A single drawable element on the timeline: a test bar, hook/fixture segment, suite setup step, wasted wait, or an expanded step span. */
export interface TimelineItem {
  /** Unique, stable identity — the v-for key and the hover-dimming comparand. */
  key: string;
  kind: TimelineItemKind;
  /** DB id of the owning test case (click-through target); null for suite-level setup steps. */
  testCaseId: number | null;
  title: string;
  status: string;
  /** Playwright's `workerIndex`: the worker process, which is new after every restart. */
  workerIndex: number;
  /** The lane's worker number (Playwright's `parallelIndex`, from 0), shown from 1 as `Worker N`, as Watch names it. */
  slot?: number;
  start: number;
  duration: number;
  rowIndex: number;
  /** Title of the test the segment belongs to (hooks/fixtures/waits/steps only). */
  parentTitle?: string | null;
  /** Lock names this execution held — test bars only (best effort). */
  locks?: string[] | null;
  /** Retries the execution needed — test bars only. */
  retries?: number | null;
  /** Passed after an earlier attempt failed or timed out (`isFlakyExecution`) — test bars only. */
  flaky?: boolean;
  /** Ended at a stop (End the test, `isEndedAtStop`): skipped, its tooltip says so — test bars only. */
  endedAtStop?: boolean;
  /**
   * The bars of every attempt of this test in the run, first attempt first —
   * test bars of a test that ran more than once only, one array shared by them.
   */
  attemptKeys?: string[] | null;
  /** Whether a later attempt of this test ran: Playwright retried it after this one — test bars only. */
  retried?: boolean;
  /**
   * The test's usual duration, the longest of its last passing executions (`usualDurationMs`), drawn as a ghost behind
   * the bar — running test bars only, null when its passes are too few to tell.
   */
  usualMs?: number | null;
  /** The server said this running attempt is stuck (`isStuckAttempt`): its bar is amber — running test bars only. */
  stuck?: boolean;
  /**
   * The duration Playwright reported, when the bar is noticeably longer — test
   * bars only. Playwright leaves `beforeAll` / `afterAll` hooks and worker
   * fixtures out of a test's duration, and the time it stood paused at a
   * breakpoint, so the bar spans them instead.
   */
  reportedDuration?: number | null;
  /** How long the test stood paused at Piwi's pause bar, in ms — test bars of a test that paused only. */
  pausedMs?: number | null;
  /** Reporter step category (`action`, `assertion`, `hook`, …) — step items only. */
  category?: string;
  /** Nesting depth within the expanded test (1 = top level) — step items only. */
  depth?: number;
  /** The step's target (rendered locator or URL) — step items only. */
  subtitle?: string | null;
  /** Curated per-step params — step items only. */
  params?: Record<string, string | number | boolean> | null;
  /** Error message when it failed — step items, and hook items from a recent reporter. */
  error?: string | null;
  /** Which side of the test body a hook section ran on (`Before Hooks` → setup) — hook items only. */
  section?: 'setup' | 'teardown' | null;
  /** The hooks and fixtures a hook section ran, in order — hook items from a recent reporter only. */
  hooks?: TestStepEventHook[] | null;
  /** Whether this test row is currently expanded — test items only. */
  expanded?: boolean;
  /** The tests on either side of the gap; null at the lane's start or end — idle and restart items only. */
  gap?: { after: GapNeighbor | null; before: GapNeighbor | null } | null;
}

/** One worker lane: its identity, plus the flat lane band it occupies (base lane + span, in row units). */
export interface WorkerRow {
  shardIndex: number | null;
  /** The lane's worker number within the shard, from 0 (Playwright's `parallelIndex`), shown from 1 as `Worker N`. */
  slot: number;
  /** The worker processes (`workerIndex`) that ran on the lane, one after another. */
  processes: number[];
  /** Flat index of this worker's test lane. */
  baseLane: number;
  /** Number of lanes this worker occupies: 1 (the test lane) plus one per expanded step depth. */
  laneSpan: number;
}

/** Per-lock summary for the Locks table under the timeline. */
export interface LockSummary {
  lock: string;
  /** Distinct executions in the run that held this lock. */
  testCount: number;
  /** Total wall time the lock was held (union of holder intervals). */
  heldMs: number;
  /** Held time as a fraction of the run's wall time (0..1). */
  share: number;
  /**
   * Estimated time that ran serialized behind another holder: the duration of
   * each holder that started within 500 ms of the previous holder's end. A
   * heuristic — holders on separate shards do not actually coordinate.
   */
  serializationMs: number;
  /** True when the lock was held for most of the final quarter of the run. */
  dominatesTail: boolean;
}

/** Back-to-back gap under which a holder is treated as having waited for the lock. */
const LOCK_SERIALIZATION_GAP_MS = 500;

/** Merge sorted [start, end] intervals, joining overlapping or touching ones. */
function mergeIntervals(intervals: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else merged.push({ ...cur });
  }
  return merged;
}

/**
 * Summarize how each lock shaped the run, from the drawn test bars. Pure so it
 * can be unit-tested: takes the timeline items and the run span, returns one row
 * per lock ordered by held time descending.
 */
export function computeLockSummary(items: TimelineItem[], maxTime: number): LockSummary[] {
  const holdersByLock = new Map<string, Array<{ start: number; end: number }>>();
  for (const item of items) {
    if (item.kind !== 'test' || !item.locks?.length) continue;
    const interval = { start: item.start, end: item.start + item.duration };
    for (const lock of item.locks) {
      const list = holdersByLock.get(lock);
      if (list) list.push(interval);
      else holdersByLock.set(lock, [interval]);
    }
  }

  const tailStart = maxTime * 0.75;
  const tailLength = maxTime - tailStart;

  const rows: LockSummary[] = [];
  for (const [lock, holders] of holdersByLock) {
    const merged = mergeIntervals(holders);
    const heldMs = merged.reduce((sum, iv) => sum + (iv.end - iv.start), 0);

    const ordered = [...holders].sort((a, b) => a.start - b.start);
    let serializationMs = 0;
    for (let i = 1; i < ordered.length; i++) {
      const gap = ordered[i]!.start - ordered[i - 1]!.end;
      if (gap >= 0 && gap <= LOCK_SERIALIZATION_GAP_MS) {
        serializationMs += ordered[i]!.end - ordered[i]!.start;
      }
    }

    const heldInTail = merged.reduce(
      (sum, iv) => sum + Math.max(0, Math.min(iv.end, maxTime) - Math.max(iv.start, tailStart)),
      0,
    );
    const dominatesTail = tailLength > 0 && heldInTail / tailLength > 0.5;

    rows.push({
      lock,
      testCount: holders.length,
      heldMs,
      share: maxTime > 0 ? heldMs / maxTime : 0,
      serializationMs,
      dominatesTail,
    });
  }

  return rows.sort((a, b) => b.heldMs - a.heldMs || a.lock.localeCompare(b.lock));
}

/** Shard group for rendering separators and labels. */
export interface ShardGroup {
  shardIndex: number | null;
  /** Row indices (0-based) within this shard's worker rows. */
  rowRange: [number, number];
}

/** Inputs the model derives its rows from (a subset of the component props). */
export interface TimelineModelInput {
  testCases: TestCaseResult[];
  setupSteps?: SetupStepEvent[] | null;
  /** Allowlist of glob patterns classifying which waits count as wasted time. */
  wastedPatterns?: string[] | null;
  /** Execution ids whose step waterfall is expanded (drawn as nested sub-lanes). */
  expandedExecutions?: Set<number> | null;
  /** Execution id → its loaded step list, for the expanded rows. */
  stepsByExecution?: Map<number, PerformanceStep[]> | null;
  /** A run still in progress: its lanes' empty stretches are not marked yet. */
  live?: boolean;
  /** Epoch ms of now on the run's clock, while it is live: each running attempt's bar reaches it. */
  now?: number | null;
  /** Each test's usual duration by `usualDurationKey`, for the ghost behind its running attempt. */
  usualDurations?: ReadonlyMap<string, number> | null;
  /** Whether the hook sections are shown (the default): hidden, a test's bar draws its failed ones and its stops. */
  showHooks?: boolean;
}

/** The usual duration of a running attempt's test: what its Stuck? mark says, else what the run's project knows. */
function usualOf(tc: TestCaseResult, usual: ReadonlyMap<string, number> | null | undefined): number | null {
  if (tc.stuck) return tc.stuck.usualMs;
  if (!usual) return null;
  return usual.get(usualDurationKey(runningUsualDurationTest(tc))) ?? null;
}

/**
 * What a running attempt's tooltip says about its time: how long its test usually takes, and, when the Stuck? rule
 * marks it, that it has run far longer.
 */
export function runningTimeNotes(item: Pick<TimelineItem, 'usualMs' | 'stuck'>): string[] {
  if (item.usualMs == null) return [];
  const usual = formatTimelineTime(item.usualMs);
  return item.stuck
    ? [`Stuck?: it has run far longer than its last passing runs, which took ${usual} at most.`]
    : [`Its last passing runs took ${usual} at most: the pale bar behind it.`];
}

/** One Playwright worker process: the cases run under one `workerIndex` in one shard. */
interface WorkerProcess {
  shardIndex: number | null;
  workerIndex: number;
  /** The lane the process ran on (Playwright's `parallelIndex`), when its cases say it. */
  lane: number | null;
  cases: TestCaseResult[];
  /** Wall-clock span of its timed cases in epoch ms, or null when none carries a start. */
  span: { start: number; end: number } | null;
}

/** One timeline lane: a worker slot and the processes that ran on it, one after another. */
interface WorkerLane {
  shardIndex: number | null;
  slot: number;
  processes: WorkerProcess[];
}

/**
 * A case's wall-clock span in epoch ms: its reported duration, stretched over
 * any hook section or stop at the pause bar that ran past it (Playwright leaves
 * `beforeAll` / `afterAll`, worker fixtures and the time paused out of the
 * duration). A case that stood paused ends with its last section: its duration
 * is no measure of its clock. Null when the case has no start.
 */
function caseSpan(tc: TestCaseResult): { start: number; end: number } | null {
  const start = toMs(tc.startedAt);
  if (start == null) return null;
  const events = (tc.stepEvents ?? []) as TestStepEvent[];
  let end = events.some((event) => event.category === 'pause') ? start : start + (tc.duration ?? 1000);
  for (const event of events) {
    const eventStart = toMs(event.startedAt);
    if (eventStart != null) end = Math.max(end, eventStart + (event.duration || 0));
  }
  return { start, end: end > start ? end : start + (tc.duration ?? 1000) };
}

/**
 * Group test cases by worker process, keyed by (shardIndex, workerIndex) — two
 * shards may have overlapping worker indices — with the lane its cases name.
 * Cases without a usable worker index are skipped.
 */
function groupByProcess(testCases: TestCaseResult[]): WorkerProcess[] {
  const byKey = new Map<string, WorkerProcess>();
  for (const tc of testCases) {
    const workerIndex = tc.workerIndex;
    if (workerIndex == null || workerIndex < 0) continue;
    const shardIndex = tc.shardIndex ?? null;
    const key = `${shardIndex ?? 'null'}|${workerIndex}`;
    let process = byKey.get(key);
    if (!process) {
      process = { shardIndex, workerIndex, lane: null, cases: [], span: null };
      byKey.set(key, process);
    }
    process.cases.push(tc);
    process.lane ??= workerLane(tc.parallelIndex);
    const span = caseSpan(tc);
    if (span) {
      process.span = process.span
        ? { start: Math.min(process.span.start, span.start), end: Math.max(process.span.end, span.end) }
        : span;
    }
  }
  return [...byKey.values()];
}

/**
 * Lay worker processes onto lanes, one lane per worker slot. Playwright
 * replaces a worker process after a failed test (and starts one for another
 * project or different worker options) with a new `workerIndex`, in the slot
 * the old one left — so a lane holds processes that ran one after another.
 * Lanes are ordered by shard (shardless last). A shard whose processes all
 * name their lane (`parallelIndex`, from a reporter that sends it) puts each on
 * it, in lane order; otherwise its lanes are worked out from the timing
 * (`packLanes`).
 */
function layOutLanes(processes: WorkerProcess[], timed: boolean): WorkerLane[] {
  const byShard = new Map<number | null, WorkerProcess[]>();
  for (const process of processes) {
    const list = byShard.get(process.shardIndex);
    if (list) list.push(process);
    else byShard.set(process.shardIndex, [process]);
  }
  const shards = [...byShard.keys()].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));

  const lanes: WorkerLane[] = [];
  for (const shardIndex of shards) {
    const shardProcesses = byShard.get(shardIndex)!;
    lanes.push(
      ...(shardProcesses.every((process) => process.lane !== null)
        ? namedLanes(shardIndex, shardProcesses)
        : packLanes(shardIndex, shardProcesses, timed)),
    );
  }
  return lanes;
}

/** The earliest start of the processes' cases, in epoch ms: the timeline's zero. Infinity when no case carries one. */
function earliestStart(processes: WorkerProcess[]): number {
  let min = Infinity;
  for (const process of processes) {
    for (const tc of process.cases) {
      const sa = toMs(tc.startedAt);
      if (sa != null && sa > 0) min = Math.min(min, sa);
    }
  }
  return min;
}

/**
 * How many lanes the workers timeline lays these test cases out on: the workers its header counts, and the count the
 * run page's Timeline tab shows. A run whose results name no lane has fewer lanes than worker processes. When every
 * process names its lane, as `layOutLanes` then places them, the count is the shards' distinct lanes, without the
 * layout.
 */
export function timelineLaneCount(testCases: TestCaseResult[]): number {
  const laneOfProcess = new Map<string, string | null>();
  for (const tc of testCases) {
    if (tc.workerIndex == null || tc.workerIndex < 0) continue;
    const shard = tc.shardIndex ?? 'null';
    const key = `${shard}|${tc.workerIndex}`;
    if (laneOfProcess.get(key) != null) continue;
    const lane = workerLane(tc.parallelIndex);
    laneOfProcess.set(key, lane === null ? null : `${shard}|${lane}`);
  }
  const lanes = [...laneOfProcess.values()];
  if (lanes.every((lane) => lane !== null)) return new Set(lanes).size;
  const processes = groupByProcess(testCases);
  return layOutLanes(processes, Number.isFinite(earliestStart(processes))).length;
}

/** The order processes ran in: by their first start, then by `workerIndex` (Playwright numbers them as it starts them). */
function byStart(a: WorkerProcess, b: WorkerProcess): number {
  return (a.span?.start ?? Infinity) - (b.span?.start ?? Infinity) || a.workerIndex - b.workerIndex;
}

/** A shard's lanes from the lane each process names, in lane order, each lane's processes in the order they ran. */
function namedLanes(shardIndex: number | null, processes: WorkerProcess[]): WorkerLane[] {
  const bySlot = new Map<number, WorkerLane>();
  for (const process of [...processes].sort(byStart)) {
    const slot = process.lane!;
    const lane = bySlot.get(slot);
    if (lane) lane.processes.push(process);
    else bySlot.set(slot, { shardIndex, slot, processes: [process] });
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
}

/**
 * A shard's lanes worked out from the timing, for processes that do not name
 * their lane: each process joins the lane that freed up last before it
 * started, or opens a new lane when every lane is still busy, and lanes are
 * ordered by when they started. Without timestamps each process keeps its own
 * lane, numbered by its index.
 */
function packLanes(shardIndex: number | null, processes: WorkerProcess[], timed: boolean): WorkerLane[] {
  if (!timed) {
    return [...processes]
      .sort((a, b) => a.workerIndex - b.workerIndex)
      .map((process) => ({ shardIndex, slot: process.workerIndex, processes: [process] }));
  }
  const open: Array<{ lane: WorkerLane; end: number }> = [];
  for (const process of [...processes].sort(byStart)) {
    let best: { lane: WorkerLane; end: number } | null = null;
    if (process.span) {
      for (const candidate of open) {
        if (candidate.end <= process.span.start && (!best || candidate.end > best.end)) best = candidate;
      }
    }
    if (best) {
      best.lane.processes.push(process);
      best.end = process.span!.end;
    } else {
      const lane: WorkerLane = { shardIndex, slot: open.length, processes: [process] };
      open.push({ lane, end: process.span?.end ?? Infinity });
    }
  }
  return open.map(({ lane }) => lane);
}

/** Empty stretch of a lane from which it is marked as idle time. */
const IDLE_GAP_MIN_MS = 250;

/**
 * Coerce a `startedAt` value to epoch milliseconds. Timestamps are numeric ms
 * end-to-end now (live SSE, REST, and both DB backends), so this is just a
 * finite-number guard. The Date/string fallbacks remain only to degrade
 * gracefully on any stray legacy value rather than yielding NaN — which would
 * collapse bars to the left edge and trigger the squished sequential fallback.
 */
function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.getTime();
  const t = new Date(v as string).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Map a step event to the timeline kind it renders as, or null when it should
 * not be drawn: non-wasted waits are framework noise already covered by the
 * test bar, and other categories (test.step/expect) are never rendered as
 * segments.
 */
function stepKind(step: TestStepEvent, patterns: readonly string[]): 'hook' | 'fixture' | 'wait' | 'pause' | null {
  if (step.category === 'wait') return isWastedWait(step, patterns) ? 'wait' : null;
  if (step.category === 'hook' || step.category === 'fixture' || step.category === 'pause') return step.category;
  return null;
}

/** Hook time past a test's reported duration from which its bar notes the duration Playwright reported. */
const UNCOUNTED_HOOK_TIME_MS = 100;

const UNCOUNTED_HOOKS = 'hooks it does not count (beforeAll, afterAll, worker fixtures)';

/**
 * What a test bar's tooltip says about its time: the duration Playwright reported when the bar is longer, and what
 * the rest was (the hooks Playwright does not count, the time the test stood paused at Piwi's pause bar, or both), by
 * how much longer the bar is than the reported duration; and the time paused, when that sentence does not say it. A
 * reported duration that counts a stop (a test that ended under the pause bar where the reporter could not correct the
 * runner's count) leaves the hooks as the rest.
 */
export function testTimeNotes(item: Pick<TimelineItem, 'duration' | 'reportedDuration' | 'pausedMs'>): string[] {
  const paused = item.pausedMs ?? 0;
  const pausedNote = `Paused ${formatTimelineTime(paused)} at Piwi's pause bar.`;
  if (item.reportedDuration == null) return paused > 0 ? [pausedNote] : [];
  const reported = `Playwright reports ${formatTimelineTime(item.reportedDuration)}`;
  const hooks = item.duration - item.reportedDuration - paused;
  if (paused >= UNCOUNTED_HOOK_TIME_MS && hooks >= UNCOUNTED_HOOK_TIME_MS) {
    return [`${reported}; the rest is the ${formatTimelineTime(paused)} it stood paused and ${UNCOUNTED_HOOKS}.`];
  }
  if (paused >= UNCOUNTED_HOOK_TIME_MS && hooks > -UNCOUNTED_HOOK_TIME_MS) {
    return [`${reported}; the rest is the ${formatTimelineTime(paused)} it stood paused at Piwi's pause bar.`];
  }
  const rest = `${reported}; the rest ran in ${UNCOUNTED_HOOKS}.`;
  return paused > 0 ? [rest, pausedNote] : [rest];
}

/** The side of the test body a top-level hook step ran on: `Before Hooks` is setup, `After Hooks` teardown. */
function hookSection(step: TestStepEvent): 'setup' | 'teardown' | null {
  const phase = stepPhases([step])[0];
  return phase === 'setup' || phase === 'teardown' ? phase : null;
}

/** A test bar as the gap next to it names it. */
function gapNeighbor(test: TimelineItem): GapNeighbor {
  return { title: test.title, status: test.status, workerIndex: test.workerIndex };
}

/**
 * The empty stretches of each lane, so none reads as missing data: a new worker
 * process (the lane's process changed between two tests — the stretch is its
 * start-up, however short), and idle time of at least `IDLE_GAP_MIN_MS` before
 * a lane's first test, between two tests of one process, and after its last
 * test until the run's last bar ends.
 */
function laneGaps(
  lanes: Array<{ baseLane: number; slot: number; tests: TimelineItem[] }>,
  drawn: TimelineItem[],
): TimelineItem[] {
  let runEnd = 0;
  for (const item of drawn) runEnd = Math.max(runEnd, item.start + item.duration);

  const gaps: TimelineItem[] = [];
  for (const { baseLane, slot, tests } of lanes) {
    const push = (
      kind: 'idle' | 'restart',
      start: number,
      end: number,
      after: TimelineItem | null,
      before: TimelineItem | null,
    ) => {
      gaps.push({
        key: `${kind}${baseLane}:${gaps.length}`,
        kind,
        testCaseId: null,
        title: kind === 'restart' ? 'New worker process' : 'Idle',
        status: kind,
        workerIndex: (before ?? after)!.workerIndex,
        slot,
        start,
        duration: Math.max(0, end - start),
        rowIndex: baseLane,
        gap: { after: after ? gapNeighbor(after) : null, before: before ? gapNeighbor(before) : null },
      });
    };

    let laneEnd = 0;
    let previous: TimelineItem | null = null;
    for (const test of tests) {
      if (previous && previous.workerIndex !== test.workerIndex) push('restart', laneEnd, test.start, previous, test);
      else if (test.start - laneEnd >= IDLE_GAP_MIN_MS) push('idle', laneEnd, test.start, previous, test);
      laneEnd = Math.max(laneEnd, test.start + test.duration);
      previous = test;
    }
    if (previous && runEnd - laneEnd >= IDLE_GAP_MIN_MS) push('idle', laneEnd, runEnd, previous, null);
  }
  return gaps;
}

/**
 * Link the bars of each test that ran more than once in the run: each learns
 * its attempts in order, and every attempt but the last that it was retried.
 */
function linkAttempts(groups: Iterable<TimelineItem[]>): void {
  for (const bars of groups) {
    if (bars.length < 2) continue;
    bars.sort((a, b) => (a.retries ?? 0) - (b.retries ?? 0) || a.start - b.start);
    const keys = bars.map((bar) => bar.key);
    bars.forEach((bar, i) => {
      bar.attemptKeys = keys;
      bar.retried = i < bars.length - 1;
    });
  }
}

/**
 * Derive the timeline's row model from the run's test cases. Returns the
 * drawable items, the ordered worker rows, the shard groupings, and the total
 * time span. Pure and free of DOM/viewport concerns so it can be unit-tested.
 */
export function useTimelineModel(props: TimelineModelInput): {
  timelineData: ComputedRef<TimelineItem[]>;
  /**
   * Every item as the results tell it, each running attempt's bar at its start: the same array as the clock ticks, for
   * what reads the items but not how far a running bar reaches (the header's counts, the strips under the workers).
   */
  settledData: ComputedRef<TimelineItem[]>;
  /** Each test's hook sections and stops its bar draws (`showHooks`), by `testCaseId`: the same arrays as the clock ticks. */
  hooksByTest: ComputedRef<Map<number, TimelineItem[]>>;
  workerRows: ComputedRef<WorkerRow[]>;
  laneCount: ComputedRef<number>;
  shardGroups: ComputedRef<ShardGroup[]>;
  maxTime: ComputedRef<number>;
  /** Epoch ms of the timeline's zero, its first test's start; null when no test carries a start. */
  origin: ComputedRef<number | null>;
  /**
   * Epoch ms of the latest moment the results tell on the run's clock: the last end of a finished attempt, or the last
   * start of a running one, or how far a stuck one had run when the server said so; null when no test carries a start.
   */
  knownUntil: ComputedRef<number | null>;
  runLocks: ComputedRef<string[]>;
  /** Each lock's color, by its place in the run's sorted lock order, so a lock keeps its color everywhere. */
  lockColorMap: ComputedRef<Map<string, string>>;
  /**
   * The colors of the locks each locked test bar's execution held, by the bar's key, in the run's lock order: the same
   * arrays as the clock ticks.
   */
  barLockColors: ComputedRef<Map<string, string[]>>;
  /** Where the usual duration of the running attempt that would end last ends, in ms from the timeline's zero; 0 with none. */
  usualUntil: ComputedRef<number>;
  lockSummary: ComputedRef<LockSummary[]>;
} {
  /** Effective wasted-wait patterns (falls back to the built-in default). */
  const wastedPatterns = computed<readonly string[]>(() =>
    props.wastedPatterns && props.wastedPatterns.length > 0 ? props.wastedPatterns : DEFAULT_WASTED_WAIT_PATTERNS,
  );

  const processes = computed(() => groupByProcess(props.testCases));

  // The earliest startedAt in the run anchors absolute positioning; when no case
  // carries a usable timestamp we fall back to packing cases sequentially.
  const minStartedAt = computed(() => earliestStart(processes.value));
  const hasStartedAt = computed(() => Number.isFinite(minStartedAt.value));

  const lanes = computed(() => layOutLanes(processes.value, hasStartedAt.value));

  // Nested step spans per expanded execution, positioned on the run's absolute
  // clock. Empty until a row is expanded and its steps have been fetched. Needs
  // the case's startedAt to place steps, so it is skipped in the timestamp-less
  // fallback mode (where a shared clock does not exist).
  const expandedSpans = computed(() => {
    const out = new Map<number, ReturnType<typeof buildStepSpans>>();
    const expanded = props.expandedExecutions;
    const stepsMap = props.stepsByExecution;
    if (!expanded || !stepsMap || expanded.size === 0 || !hasStartedAt.value) return out;
    for (const process of processes.value) {
      for (const tc of process.cases) {
        if (!expanded.has(tc.executionId)) continue;
        const steps = stepsMap.get(tc.executionId);
        const startMs = toMs(tc.startedAt);
        if (!steps || startMs == null) continue;
        out.set(tc.executionId, buildStepSpans(steps, startMs));
      }
    }
    return out;
  });

  // Lay lanes out as flat rows: each lane takes its test row plus one row per
  // level of the deepest expanded step tree on it, so a lane's band grows only
  // while one of its tests is expanded.
  const workerLayout = computed<{ rows: WorkerRow[]; laneCount: number }>(() => {
    const spans = expandedSpans.value;
    const rows: WorkerRow[] = [];
    let row = 0;
    for (const lane of lanes.value) {
      let maxDepth = 0;
      for (const process of lane.processes) {
        for (const tc of process.cases) {
          const r = spans.get(tc.executionId);
          if (r) maxDepth = Math.max(maxDepth, r.maxDepth);
        }
      }
      const laneSpan = 1 + maxDepth;
      rows.push({
        shardIndex: lane.shardIndex,
        slot: lane.slot,
        processes: lane.processes.map((p) => p.workerIndex),
        baseLane: row,
        laneSpan,
      });
      row += laneSpan;
    }
    return { rows, laneCount: row };
  });

  // Every item but the running attempts' reach: built again when the results change, never as the clock ticks.
  const baseData = computed<TimelineItem[]>(() => {
    const rows = workerLayout.value.rows;
    const patterns = wastedPatterns.value;
    const absolute = hasStartedAt.value;
    const origin = minStartedAt.value;
    const spans = expandedSpans.value;
    const expanded = props.expandedExecutions;
    const absoluteStart = (startedAt: unknown) => Math.max(0, (toMs(startedAt) ?? origin) - origin);

    const result: TimelineItem[] = [];
    // Per-process lane and end cursor; positions items in fallback mode and
    // marks where setup steps get appended.
    const laneByWorker = new Map<number, { baseLane: number; slot: number; end: number }>();
    // Each lane's test bars in time order, for marking its empty stretches.
    const laneTests: Array<{ baseLane: number; slot: number; tests: TimelineItem[] }> = [];
    // Each test's attempts, which can run on different lanes, for linking them.
    const attemptBars = new Map<string, TimelineItem[]>();

    lanes.value.forEach((lane, i) => {
      const baseLane = rows[i]!.baseLane;
      const slot = lane.slot;
      const rowItems: TimelineItem[] = [];
      // Fallback mode packs a lane's cases one after another, its processes in the order they ran.
      let cursor = 0;

      for (const process of lane.processes) {
        const workerIndex = process.workerIndex;
        // Fallback mode packs cases in start order; absolute mode keeps the
        // incoming order and sorts the finished row by start instead.
        const cases = absolute
          ? process.cases
          : [...process.cases].sort((a, b) => (toMs(a.startedAt) ?? 0) - (toMs(b.startedAt) ?? 0));

        for (const tc of cases) {
          const stepEvents = (tc.stepEvents ?? []) as TestStepEvent[];
          const reported = tc.duration ?? 1000;
          const span = absolute ? caseSpan(tc) : null;
          const start = absolute ? absoluteStart(tc.startedAt) : cursor;
          const duration = span ? span.end - span.start : reported;
          const pauses = pauseSpans(stepEvents);
          const pausedMs = pauses.length
            ? span
              ? pausedOverlap(span.start, span.end - span.start, pauses)
              : pauses.reduce((sum, pause) => sum + pause.duration, 0)
            : 0;
          const testItem: TimelineItem = {
            key: `t${tc.executionId}`,
            kind: 'test',
            testCaseId: tc.executionId,
            title: tc.title,
            status: tc.status,
            workerIndex,
            slot,
            start,
            duration,
            rowIndex: baseLane,
            locks: tc.locks ?? null,
            retries: tc.retries ?? null,
            flaky: isFlakyExecution(tc),
            ...(isEndedAtStop(tc) ? { endedAtStop: true } : {}),
            ...(tc.status === 'running'
              ? { usualMs: usualOf(tc, props.usualDurations), stuck: isStuckAttempt(tc) }
              : {}),
            reportedDuration: duration - reported >= UNCOUNTED_HOOK_TIME_MS ? reported : null,
            ...(pausedMs > 0 ? { pausedMs } : {}),
            expanded: expanded?.has(tc.executionId) ?? false,
          };
          rowItems.push(testItem);
          const attemptKey = testAttemptKey(tc);
          const attempts = attemptBars.get(attemptKey);
          if (attempts) attempts.push(testItem);
          else attemptBars.set(attemptKey, [testItem]);
          cursor = start + duration;

          stepEvents.forEach((step, stepIndex) => {
            const kind = stepKind(step, patterns);
            if (!kind) return;
            const stepDuration = step.duration || 0;
            const stepStart = absolute ? absoluteStart(step.startedAt) : cursor;
            const item: TimelineItem = {
              key: `s${tc.executionId}:${stepIndex}`,
              kind,
              testCaseId: tc.executionId,
              title: step.title,
              // A stop's status is its reason: one stored without it was at a breakpoint, as the failure timeline reads it.
              status: step.status || (kind === 'pause' ? 'breakpoint' : 'passed'),
              workerIndex,
              slot,
              start: stepStart,
              duration: stepDuration,
              rowIndex: baseLane,
              parentTitle: tc.title,
            };
            if (kind === 'pause') {
              // The stop's call site, without its column.
              item.subtitle = step.location ? step.location.replace(/:\d+$/, '') : null;
            } else if (kind !== 'wait') {
              item.section = hookSection(step);
              item.hooks = step.hooks?.length ? step.hooks : null;
              item.error = step.error ?? null;
            }
            rowItems.push(item);
            cursor = stepStart + stepDuration;
          });

          // Expanded step waterfall: one nested sub-lane per depth, drawn only
          // across this test's own span.
          const stepResult = spans.get(tc.executionId);
          if (stepResult) {
            stepResult.spans.forEach((stepSpan, spanIndex) => {
              rowItems.push({
                key: `st${tc.executionId}:${spanIndex}`,
                kind: 'step',
                testCaseId: tc.executionId,
                title: stepSpan.title,
                status: stepSpan.status,
                workerIndex,
                slot,
                start: absoluteStart(stepSpan.startTime),
                duration: stepSpan.duration,
                rowIndex: baseLane + stepSpan.depth,
                parentTitle: tc.title,
                category: stepSpan.category,
                depth: stepSpan.depth,
                subtitle: stepSpan.subtitle ?? null,
                params: stepSpan.params ?? null,
                error: stepSpan.error ?? null,
              });
            });
          }
        }
        // First shard wins, matching the setup-step row placement below.
        if (!laneByWorker.has(workerIndex)) laneByWorker.set(workerIndex, { baseLane, slot, end: cursor });
      }

      rowItems.sort((a, b) => a.start - b.start);
      result.push(...rowItems);
      laneTests.push({ baseLane, slot, tests: rowItems.filter((item) => item.kind === 'test') });
    });

    // Suite-level setup steps (beforeAll/afterAll) carry only a workerIndex
    // (no shard), so place each on the first lane that process ran on. In
    // absolute mode they sit at their own startedAt; in fallback mode they're
    // appended after the process's cases, since without timestamps we can't
    // interleave them accurately.
    if (props.setupSteps && props.setupSteps.length > 0) {
      props.setupSteps.forEach((step, setupIndex) => {
        const workerIndex = step.workerIndex;
        if (workerIndex == null || workerIndex < 0) return;
        const lane = laneByWorker.get(workerIndex);
        if (!lane) return;

        const duration = step.duration || 0;
        let start: number;
        if (absolute) {
          start = absoluteStart(step.startedAt);
        } else {
          start = lane.end;
          lane.end = start + duration;
        }

        result.push({
          key: `setup${workerIndex}:${setupIndex}`,
          kind: 'setup',
          testCaseId: null,
          title: `[Setup] ${step.title}`,
          status: step.status || 'passed',
          workerIndex,
          slot: lane.slot,
          start,
          duration,
          rowIndex: lane.baseLane,
          parentTitle: null,
        });
      });
    }

    linkAttempts(attemptBars.values());
    if (absolute && !props.live) result.push(...laneGaps(laneTests, result));
    return result;
  });

  // While the run is live, each running attempt's bar reaches now on the run's clock: a copy of it alone, so the
  // other bars stay the same objects as the clock ticks.
  const timelineData = computed<TimelineItem[]>(() => {
    const base = baseData.value;
    const now = props.now;
    if (now == null || !hasStartedAt.value) return base;
    const origin = minStartedAt.value;
    let running = false;
    const items = base.map((item) => {
      if (item.kind !== 'test' || item.status !== 'running') return item;
      running = true;
      return { ...item, duration: Math.max(0, now - origin - item.start) };
    });
    return running ? items : base;
  });

  /** Ordered worker lanes with their flat-lane bands; items render on the lane at `rowIndex`. */
  const workerRows = computed<WorkerRow[]>(() => workerLayout.value.rows);

  /** Total flat lanes, including expanded step sub-lanes — the timeline's row count. */
  const laneCount = computed(() => workerLayout.value.laneCount);

  /** Shard group boundaries derived from workerRows */
  const shardGroups = computed<ShardGroup[]>(() => {
    const groups: ShardGroup[] = [];
    for (let ri = 0; ri < workerRows.value.length; ri++) {
      const row = workerRows.value[ri]!;
      const prev = groups[groups.length - 1];
      if (!prev || prev.shardIndex !== row.shardIndex) {
        groups.push({ shardIndex: row.shardIndex, rowRange: [ri, ri] });
      } else {
        prev.rowRange[1] = ri;
      }
    }
    return groups;
  });

  // From the results alone: a running attempt's reach moves the plot's end only through the timeline's own clock.
  const maxTime = computed(() => {
    let max = 0;
    for (const item of baseData.value) {
      max = Math.max(max, item.start + item.duration);
    }
    return max || 60000;
  });

  const knownUntil = computed(() => {
    if (!hasStartedAt.value) return null;
    let max = -Infinity;
    for (const process of processes.value) {
      for (const tc of process.cases) {
        const start = toMs(tc.startedAt);
        if (start == null) continue;
        // A running attempt the server said is stuck had run its `elapsedMs` (its stops left out) when it said so.
        const end = tc.status === 'running' ? start + (tc.stuck?.elapsedMs ?? 0) : (caseSpan(tc)?.end ?? start);
        max = Math.max(max, end);
      }
    }
    return Number.isFinite(max) ? max : null;
  });

  /** Distinct lock names declared anywhere in the run, sorted for stable colors. */
  const runLocks = computed(() => {
    const locks = new Set<string>();
    for (const tc of props.testCases) for (const lock of tc.locks ?? []) locks.add(lock);
    return [...locks].sort((a, b) => a.localeCompare(b));
  });

  const lockColorMap = computed(() => new Map(runLocks.value.map((lock, i) => [lock, lockColorHex(i)])));

  // From the settled items, by the bar's key, which a running bar's copy keeps: one array per bar as the clock ticks.
  const barLockColors = computed(() => {
    const map = new Map<string, string[]>();
    for (const item of baseData.value) {
      if (item.kind !== 'test' || !item.locks?.length) continue;
      const held = item.locks;
      map.set(
        item.key,
        runLocks.value.filter((lock) => held.includes(lock)).map((lock) => lockColorMap.value.get(lock)!),
      );
    }
    return map;
  });

  // From the settled items: one array per bar as the clock ticks.
  const hooksByTest = computed(() => {
    const shown = { hooks: props.showHooks ?? true, waits: false };
    const map = new Map<number, TimelineItem[]>();
    for (const item of baseData.value) {
      if (!isTestSection(item) || !isShownItem(item, shown)) continue;
      const list = map.get(item.testCaseId!);
      if (list) list.push(item);
      else map.set(item.testCaseId!, [item]);
    }
    return map;
  });

  const usualUntil = computed(() => {
    let end = 0;
    for (const item of baseData.value) {
      if (item.kind === 'test' && item.status === 'running' && item.usualMs != null) {
        end = Math.max(end, item.start + item.usualMs);
      }
    }
    return end;
  });

  const lockSummary = computed(() => computeLockSummary(baseData.value, maxTime.value));

  const origin = computed(() => (hasStartedAt.value ? minStartedAt.value : null));

  return {
    timelineData,
    settledData: baseData,
    hooksByTest,
    workerRows,
    laneCount,
    shardGroups,
    maxTime,
    origin,
    knownUntil,
    runLocks,
    lockColorMap,
    barLockColors,
    usualUntil,
    lockSummary,
  };
}
