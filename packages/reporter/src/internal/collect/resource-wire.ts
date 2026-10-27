import type {
  ArtifactKind,
  SeriesPoint,
  WireExecutionResources,
  WireResourceReport,
  WireResourceTimeline,
} from '@piwitests/core/wire';
import type { ResourceCensus } from '../capture/resource-ledger.js';
import type { RunProfile, RunSamples } from './process-sampler.js';
import type { ResourceReport } from './resource-verdicts.js';
import { workerHealthOf, type ArtifactBytes } from './machine-panel.js';

/**
 * The resource data the dashboard receives: per execution, what the test cost
 * its worker and browsers; per run, the findings, what the run cost its
 * machine, the pages open in each worker test after test, and the machine's
 * CPU, the run's memory and each worker's open pages over time. Bounded, so a
 * large or leaky suite sends a report of a few tens of kilobytes at most.
 */

/** The most findings a report carries; the summary already orders them most severe first. */
export const REPORT_FINDINGS_CAP = 100;
/** The most points of the machine's CPU series, and of each worker's open pages. */
export const REPORT_SERIES_CAP = 240;
export const REPORT_WORKER_POINTS_CAP = 200;
/** The most points of the timeline's CPU and memory series, and of each worker's open pages over time. */
export const TIMELINE_SERIES_CAP = 600;
export const TIMELINE_WORKER_POINTS_CAP = 300;
/**
 * The most points of the workers' CPU and memory series together; each
 * worker's share is between 60 and `TIMELINE_WORKER_POINTS_CAP` per series, so
 * a run with many workers keeps a coarser series rather than a larger report.
 */
const TIMELINE_WORKERS_BUDGET = 6000;

/** A series shortened to at most `cap` points, each the mean of its slice. */
export function downsample(series: number[], cap: number): number[] {
  if (series.length <= cap) return series;
  const out: number[] = [];
  for (let i = 0; i < cap; i++) {
    const slice = series.slice(Math.floor((i * series.length) / cap), Math.floor(((i + 1) * series.length) / cap));
    out.push(Math.round((slice.reduce((sum, v) => sum + v, 0) / Math.max(1, slice.length)) * 10) / 10);
  }
  return out;
}

/**
 * A timed series shortened to at most `cap` points: consecutive points fold
 * into one at the first one's time, their values merged by `merge` (the mean
 * for a rate, the largest for a level, so a peak survives).
 */
export function downsamplePoints(points: SeriesPoint[], cap: number, merge: 'mean' | 'max'): SeriesPoint[] {
  if (points.length <= cap) return points;
  const out: SeriesPoint[] = [];
  for (let i = 0; i < cap; i++) {
    const slice = points.slice(Math.floor((i * points.length) / cap), Math.floor(((i + 1) * points.length) / cap));
    if (slice.length === 0) continue;
    const values = slice.map((point) => point[1]);
    const value =
      merge === 'max'
        ? Math.max(...values)
        : Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
    out.push([slice[0]![0], value]);
  }
  return out;
}

/** The non-zero kinds of a byte tally, or null when every kind is zero. */
function nonZero(bytes: Partial<Record<ArtifactKind, number>>): Partial<Record<ArtifactKind, number>> | null {
  const out = Object.fromEntries(Object.entries(bytes).filter(([, n]) => (n ?? 0) > 0));
  return Object.keys(out).length > 0 ? out : null;
}

/** What one execution cost, from its census; null when the census carried no metrics. */
export function executionResources(
  census: ResourceCensus,
  artifacts: Partial<Record<ArtifactKind, number>>,
): WireExecutionResources | null {
  const metrics = census.metrics;
  if (!metrics) return null;
  return {
    workerCpuMs: metrics.worker.cpuMs,
    roles: metrics.roles ?? null,
    loopUtilization: metrics.worker.loopUtilization,
    loopDelayP99Ms: metrics.worker.loopDelayP99Ms,
    involuntarySwitches: metrics.worker.involuntarySwitches,
    heapUsedMb: metrics.worker.heapUsedMb,
    openAtStart: census.openAtStart ?? null,
    leftOpen: census.leftOpen ?? null,
    artifactBytes: nonZero(artifacts),
  };
}

/** Open pages in each worker at the end of each of its tests, from the censuses in order. */
function openPagesByWorker(censuses: ResourceCensus[]): WireResourceReport['workers'] {
  const byWorker = new Map<number, ResourceCensus[]>();
  for (const census of censuses) {
    const list = byWorker.get(census.worker) ?? [];
    list.push(census);
    byWorker.set(census.worker, list);
  }
  const out: WireResourceReport['workers'] = [];
  for (const [worker, list] of [...byWorker.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.at - b.at);
    const kinds = new Map<number, string>();
    const points: number[] = [];
    for (const census of list) {
      for (const birth of census.born) kinds.set(birth.id, birth.kind);
      if (census.test) points.push(census.open.filter((open) => kinds.get(open.id) === 'page').length);
    }
    if (points.length > 0) out.push({ worker, openPages: downsample(points, REPORT_WORKER_POINTS_CAP) });
  }
  return out;
}

/**
 * Pages open in each worker over time, from the censuses' births and closes:
 * a point at each change, and, once the run ended (`live` false), a last one
 * at zero when the worker's last census was taken, since its pages went with
 * it. While the run goes on, a worker's last census is not its end.
 */
export function pagesOverTime(
  censuses: readonly ResourceCensus[],
  live = false,
): Array<{ worker: number; events: SeriesPoint[] }> {
  const byWorker = new Map<number, ResourceCensus[]>();
  for (const census of censuses) {
    const list = byWorker.get(census.worker) ?? [];
    list.push(census);
    byWorker.set(census.worker, list);
  }
  const out: Array<{ worker: number; events: SeriesPoint[] }> = [];
  for (const [worker, list] of [...byWorker.entries()].sort((a, b) => a[0] - b[0])) {
    const pages = new Set<number>();
    const changes: SeriesPoint[] = [];
    let lastAt = -Infinity;
    for (const census of list) {
      lastAt = Math.max(lastAt, census.at);
      for (const birth of census.born) {
        if (birth.kind !== 'page') continue;
        pages.add(birth.id);
        changes.push([birth.at, 1]);
      }
    }
    for (const census of list) {
      for (const close of census.closed) if (pages.has(close.id)) changes.push([close.at, -1]);
    }
    if (changes.length === 0) continue;
    // Opens before closes at the same millisecond, so the count never dips below zero.
    changes.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const events: SeriesPoint[] = [];
    let open = 0;
    for (const [at, delta] of changes) {
      open = Math.max(0, open + delta);
      const last = events[events.length - 1];
      if (last && last[0] === at) last[1] = open;
      else events.push([at, open]);
    }
    if (!live && open > 0 && lastAt >= events[events.length - 1]![0]) events.push([lastAt, 0]);
    out.push({ worker, events });
  }
  return out;
}

/**
 * The Playwright worker each sampled worker process was: the worker index its
 * censuses name for that process id, the one whose censuses fall nearest the
 * process's readings when a process id came back for a later worker. A
 * process no census names is left out.
 */
export function workerTreesByIndex(
  samples: RunSamples,
  censuses: readonly ResourceCensus[],
): Array<{ worker: number; cpuCores: SeriesPoint[]; memoryBytes: SeriesPoint[] }> {
  const byPid = new Map<number, Array<{ worker: number; at: number }>>();
  for (const census of censuses) {
    const list = byPid.get(census.pid) ?? [];
    list.push({ worker: census.worker, at: census.at });
    byPid.set(census.pid, list);
  }
  const out = new Map<number, { worker: number; cpuCores: SeriesPoint[]; memoryBytes: SeriesPoint[] }>();
  for (const tree of samples.workers) {
    const candidates = byPid.get(tree.pid);
    const times = [...tree.cpuCores, ...tree.memoryBytes].map(([at]) => samples.startedAt + at);
    if (!candidates || times.length === 0) continue;
    const from = Math.min(...times);
    const to = Math.max(...times);
    const distance = (at: number) => (at < from ? from - at : at > to ? at - to : 0);
    const nearest = candidates.reduce((best, c) => (distance(c.at) < distance(best.at) ? c : best));
    if (!out.has(nearest.worker)) out.set(nearest.worker, { worker: nearest.worker, ...tree });
  }
  return [...out.values()].sort((a, b) => a.worker - b.worker);
}

/**
 * The run's resources over time, on one clock: from the sampler's start, or
 * the first page a worker opened when the sampler did not run. Null when
 * neither measured anything.
 */
export function resourceTimeline(samples: RunSamples | null, censuses: ResourceCensus[]): WireResourceTimeline | null {
  const workers = pagesOverTime(censuses);
  const hasSamples = samples !== null && (samples.cpuPct.length > 0 || samples.memoryBytes.length > 0);
  if (!hasSamples && workers.length === 0) return null;
  let startedAt = hasSamples ? samples.startedAt : Infinity;
  for (const { events } of workers) startedAt = Math.min(startedAt, events[0]![0]);
  const shift = hasSamples ? samples.startedAt - startedAt : 0;
  const relative = (points: SeriesPoint[], by: number): SeriesPoint[] =>
    points.map(([at, value]) => [Math.round(at + by), value]);
  const trees = hasSamples ? workerTreesByIndex(samples, censuses) : [];
  const perWorker = Math.max(
    60,
    Math.min(TIMELINE_WORKER_POINTS_CAP, Math.floor(TIMELINE_WORKERS_BUDGET / Math.max(1, 2 * trees.length))),
  );
  return {
    startedAt,
    cpuPct: hasSamples ? downsamplePoints(relative(samples.cpuPct, shift), TIMELINE_SERIES_CAP, 'mean') : [],
    memoryBytes: hasSamples ? downsamplePoints(relative(samples.memoryBytes, shift), TIMELINE_SERIES_CAP, 'max') : [],
    pages: workers.map(({ worker, events }) => {
      // The last point is where the worker's count settles; it stays exact.
      const points = relative(events, -startedAt);
      const last = points.pop()!;
      return { worker, points: [...downsamplePoints(points, TIMELINE_WORKER_POINTS_CAP - 1, 'max'), last] };
    }),
    workers: trees.map((tree) => ({
      worker: tree.worker,
      cpuCores: downsamplePoints(relative(tree.cpuCores, shift), perWorker, 'mean'),
      memoryBytes: downsamplePoints(relative(tree.memoryBytes, shift), perWorker, 'max'),
    })),
  };
}

/** The run's report as the dashboard stores it. */
export function resourceReportWire(input: {
  report: ResourceReport | null;
  profile: RunProfile | null;
  samples?: RunSamples | null;
  censuses: ResourceCensus[];
  artifacts: ArtifactBytes;
  shardIndex: number | null;
}): WireResourceReport {
  const { report, profile } = input;
  return {
    v: 1,
    shardIndex: input.shardIndex,
    findings: (report?.findings ?? []).slice(0, REPORT_FINDINGS_CAP),
    counts: report?.counts ?? { leaked: 0, idle: 0, piling: 0, handle: 0, probable: 0 },
    profile: profile
      ? { ...profile, cpu: { ...profile.cpu, series: downsample(profile.cpu.series, REPORT_SERIES_CAP) } }
      : null,
    workers: openPagesByWorker(input.censuses),
    artifactBytes: nonZero(input.artifacts) ?? {},
    workerHealth: workerHealthOf(input.censuses),
    timeline: resourceTimeline(input.samples ?? null, input.censuses),
  };
}
