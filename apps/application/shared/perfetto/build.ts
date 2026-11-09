/**
 * Turns a run (or one execution) into a Trace Event Format document that opens
 * in ui.perfetto.dev and Chrome's `chrome://tracing`.
 *
 * Pure and node-free, so the demo reuses it. One process per shard, one thread
 * per worker, named by its lane from 1 as the run page names it; each
 * execution is a complete slice whose hooks, fixtures and steps nest under it
 * by start time, and the moment a failing execution failed is an instant event
 * on the same thread. Timestamps are microseconds relative to the earliest
 * event, matching Playwright's own `perfetto` reporter.
 */
import type {
  PerfettoBuildOptions,
  PerfettoExecution,
  PerfettoRunInput,
  PerfettoStep,
  PerfettoTrace,
  TraceEvent,
} from './types';
import { shownWorkerNumber, workerNumber } from '../worker-lane';

/** Chrome trace color names keyed by execution/step status. */
const STATUS_COLORS: Record<string, string> = {
  passed: 'good',
  failed: 'bad',
  timedout: 'terrible',
  interrupted: 'grey',
  skipped: 'grey',
  didnotrun: 'grey',
};

/** Statuses that mark an execution as having failed; an interrupted one is in no outcome. */
const FAILED_STATUSES = new Set(['failed', 'timedout']);

function statusColor(status: string): string | undefined {
  return STATUS_COLORS[status.toLowerCase()];
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatAnnotation(a: { type: string; description?: string | null }): string {
  return a.description ? `${a.type}: ${a.description}` : a.type;
}

/** The process id for a shard: its 1-based index, or 0 for an unsharded run. */
function pidOf(ex: { shardIndex?: number | null }): number {
  return ex.shardIndex != null && Number.isFinite(ex.shardIndex) ? ex.shardIndex : 0;
}

/**
 * The thread id for a worker within its process: the number the run page names it by (`Worker 2`), its lane from 1,
 * else the worker process of a result without a lane; a test that never ran keeps the worker index Playwright gives
 * it (-1), on a thread of its own, and one with none is on 0.
 */
function tidOf(ex: { parallelIndex?: number | null; workerIndex?: number | null }): number {
  const shown = shownWorkerNumber(ex);
  if (shown !== null) return shown;
  return ex.workerIndex != null && Number.isFinite(ex.workerIndex) ? ex.workerIndex : 0;
}

/** Map the `stepEvents` fallback into the richer step shape used for slices. */
function stepFromEvent(event: {
  title: string;
  subtitle?: string | null;
  category: string;
  startedAt: number;
  duration: number;
  status?: string | null;
}): PerfettoStep {
  const failed = event.status ? FAILED_STATUSES.has(event.status.toLowerCase()) : false;
  return {
    title: event.title,
    subtitle: event.subtitle ?? null,
    category: event.category,
    duration: event.duration,
    startTime: event.startedAt,
    failed,
  };
}

export function buildPerfettoTrace(input: PerfettoRunInput, options: PerfettoBuildOptions): PerfettoTrace {
  const baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, '') : null;
  const events: TraceEvent[] = [];
  /** Distinct (pid, tid) tracks that carry at least one slice. */
  const tracks = new Set<string>();
  /** Process id → its shard index (null when unsharded). */
  const shardByPid = new Map<number, number | null>();
  /** Worker process (`workerIndex`) → its track in the first shard that ran it (for setup steps). */
  const trackByWorkerIndex = new Map<number, { pid: number; tid: number }>();

  const registerTrack = (pid: number, tid: number) => {
    tracks.add(`${pid}:${tid}`);
  };

  const stepArgs = (step: PerfettoStep): Record<string, unknown> | undefined => {
    const args: Record<string, unknown> = {};
    if (step.params && Object.keys(step.params).length) args.params = step.params;
    if (step.subtitle) args.subtitle = step.subtitle;
    if (step.category) args.category = step.category;
    if (step.location) args.location = step.location;
    if (step.error?.message) args.error = step.error.message;
    return Object.keys(args).length ? args : undefined;
  };

  /** Emit a step's slice, clamped inside its execution's span. */
  const emitStep = (
    step: PerfettoStep,
    pid: number,
    tid: number,
    boundStart: number,
    boundEnd: number,
    cursor: number,
  ) => {
    const dur = Math.max(0, num(step.duration, 0));
    const rawStart = step.startTime != null && Number.isFinite(step.startTime) ? step.startTime : cursor;
    const start = clamp(rawStart, boundStart, boundEnd);
    const end = clamp(start + dur, start, boundEnd);
    events.push({
      name: step.subtitle ? `${step.title} ${step.subtitle}` : step.title,
      cat: step.category || 'step',
      ph: 'X',
      ts: start,
      dur: end - start,
      pid,
      tid,
      cname: step.failed || step.error?.message ? 'bad' : undefined,
      args: stepArgs(step),
    });
    return Math.max(cursor, end);
  };

  const testArgs = (ex: PerfettoExecution): Record<string, unknown> => {
    const args: Record<string, unknown> = { status: ex.status };
    if (ex.location) args.location = ex.location;
    else if (ex.filePath) args.location = ex.filePath;
    if (ex.testCaseId != null) args.testId = ex.testCaseId;
    args.executionId = ex.executionId;
    const worker = workerNumber(ex.parallelIndex);
    if (worker != null) args.worker = worker;
    if (ex.workerIndex != null) args.workerIndex = ex.workerIndex;
    if (ex.shardIndex != null) args.shardIndex = ex.shardIndex;
    if (ex.retries) args.retry = ex.retries;
    if (ex.tags?.length) args.tags = ex.tags.join(' ');
    if (ex.locks?.length) args.locks = ex.locks;
    if (ex.annotations?.length) args.annotations = ex.annotations.map(formatAnnotation);
    if (ex.error) args.error = ex.error;
    if (baseUrl) args.url = `${baseUrl}/test-run-cases/${ex.executionId}`;
    if (ex.attachments?.length) {
      args.attachments = ex.attachments.map((a) => (baseUrl && a.path ? `${baseUrl}/api/files/${a.path}` : a.name));
    }
    return args;
  };

  for (const ex of input.executions) {
    const pid = pidOf(ex);
    const tid = tidOf(ex);
    shardByPid.set(pid, ex.shardIndex ?? null);
    if (ex.workerIndex != null) {
      const existing = trackByWorkerIndex.get(ex.workerIndex);
      if (existing == null || pid < existing.pid) trackByWorkerIndex.set(ex.workerIndex, { pid, tid });
    }
    registerTrack(pid, tid);

    const startMs = num(ex.startedAt, num(input.run.startTime, 0));
    const steps = ex.steps?.length ? ex.steps : (ex.stepEvents ?? []).map(stepFromEvent);

    // The slice must span its steps even when the recorded duration is shorter.
    let endMs = startMs + Math.max(0, num(ex.duration, 0));
    for (const step of steps) {
      if (step.startTime != null && Number.isFinite(step.startTime)) {
        endMs = Math.max(endMs, step.startTime + Math.max(0, num(step.duration, 0)));
      }
    }

    events.push({
      name: ex.title,
      cat: 'test',
      ph: 'X',
      ts: startMs,
      dur: endMs - startMs,
      pid,
      tid,
      cname: statusColor(ex.status),
      args: testArgs(ex),
    });

    let cursor = startMs;
    let failStart: number | null = null;
    for (const step of steps) {
      const before = cursor;
      cursor = emitStep(step, pid, tid, startMs, endMs, cursor);
      if (failStart == null && (step.failed || step.error?.message)) {
        failStart = clamp(step.startTime != null ? step.startTime : before, startMs, endMs);
      }
    }

    if (FAILED_STATUSES.has(ex.status.toLowerCase())) {
      events.push({
        name: 'failed',
        cat: 'error',
        ph: 'i',
        s: 't',
        ts: failStart ?? endMs,
        pid,
        tid,
        cname: 'bad',
        args: ex.error ? { error: ex.error } : undefined,
      });
    }
  }

  // Suite-level setup steps carry a worker process but no shard or lane: place
  // each on the thread that process ran on, in the first shard that ran it,
  // matching the workers timeline.
  for (const step of input.setupSteps ?? []) {
    if (step.workerIndex == null || !Number.isFinite(step.workerIndex)) continue;
    const { pid, tid } = trackByWorkerIndex.get(step.workerIndex) ?? { pid: 0, tid: step.workerIndex };
    shardByPid.set(pid, shardByPid.get(pid) ?? null);
    registerTrack(pid, tid);
    const start = num(step.startedAt, num(input.run.startTime, 0));
    const dur = Math.max(0, num(step.duration, 0));
    const failed = step.status ? FAILED_STATUSES.has(step.status.toLowerCase()) : false;
    events.push({
      name: step.subtitle ? `[setup] ${step.title} ${step.subtitle}` : `[setup] ${step.title}`,
      cat: step.category || 'setup',
      ph: 'X',
      ts: start,
      dur,
      pid,
      tid,
      cname: failed ? 'bad' : undefined,
      args: step.location ? { location: step.location } : undefined,
    });
  }

  // Normalize to microseconds relative to the earliest event.
  let timeOrigin = Infinity;
  for (const event of events) timeOrigin = Math.min(timeOrigin, event.ts);
  if (!Number.isFinite(timeOrigin)) timeOrigin = 0;
  events.sort((a, b) => a.ts - b.ts);
  for (const event of events) {
    event.ts = Math.round((event.ts - timeOrigin) * 1000);
    if (event.dur !== undefined) event.dur = Math.round(event.dur * 1000);
  }

  const metadataEvents = buildMetadata(shardByPid, tracks, options.scope);

  const metadata: Record<string, unknown> = {
    source: 'piwi',
    scope: options.scope,
    'run-id': input.run.id,
    'run-status': input.run.status ?? null,
    'playwright-version': input.run.playwrightVersion ?? null,
    'generated-at': options.generatedAt ?? new Date().toISOString(),
  };
  if (options.piwiVersion) metadata['piwi-version'] = options.piwiVersion;
  if (input.run.label) metadata['run-label'] = input.run.label;
  if (input.run.project) metadata.project = input.run.project.label || input.run.project.name;
  if (input.run.startTime != null) metadata['start-time'] = new Date(input.run.startTime).toISOString();
  if (input.run.duration != null) metadata.duration = input.run.duration;

  return { traceEvents: [...metadataEvents, ...events], displayTimeUnit: 'ms', metadata };
}

/** Process and thread naming metadata, ordered for stable lanes in the viewer. */
function buildMetadata(
  shardByPid: Map<number, number | null>,
  tracks: Set<string>,
  scope: 'run' | 'execution',
): TraceEvent[] {
  const out: TraceEvent[] = [];
  const tidsByPid = new Map<number, Set<number>>();
  for (const key of tracks) {
    const [pidStr, tidStr] = key.split(':');
    const pid = Number(pidStr);
    const tid = Number(tidStr);
    let tids = tidsByPid.get(pid);
    if (!tids) {
      tids = new Set();
      tidsByPid.set(pid, tids);
    }
    tids.add(tid);
  }

  const pids = [...tidsByPid.keys()].sort((a, b) => a - b);
  for (const pid of pids) {
    const shard = shardByPid.get(pid) ?? null;
    const name = shard != null ? `Shard ${shard}` : scope === 'execution' ? 'Execution' : 'Tests';
    out.push({ name: 'process_name', cat: '__metadata', ph: 'M', ts: 0, pid, tid: 0, args: { name } });
    out.push({ name: 'process_sort_index', cat: '__metadata', ph: 'M', ts: 0, pid, tid: 0, args: { sort_index: pid } });
    for (const tid of [...tidsByPid.get(pid)!].sort((a, b) => a - b)) {
      out.push({ name: 'thread_name', cat: '__metadata', ph: 'M', ts: 0, pid, tid, args: { name: `Worker ${tid}` } });
      out.push({ name: 'thread_sort_index', cat: '__metadata', ph: 'M', ts: 0, pid, tid, args: { sort_index: tid } });
    }
  }
  return out;
}
