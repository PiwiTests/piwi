/**
 * The resources of an execution's failure timeline: what the worker that ran
 * the test used while it ran, with the browsers it started (its CPU in cores
 * and its memory, as the run sampler read them), and the pages open in that
 * worker, on the failure timeline's clock. Read from the run's stored resource
 * report and the execution's own cost; pure, so the server route and the demo
 * mirror build the same object.
 */
import type { SeriesPoint, WireExecutionResources, WireResourceReport } from '#shared/types';

export interface TimelineResources {
  /** The worker and the browsers it started: cores used over the interval ending at each point. */
  cpuCores: SeriesPoint[];
  /** The same processes' memory, measured as `memoryKind` says. */
  memoryBytes: SeriesPoint[];
  /** Pages open in the worker, a level held until the next point. */
  openPages: SeriesPoint[];
  memoryKind: 'pss' | 'rss' | null;
  /** The cores of the machine the worker ran on. */
  cores: number | null;
  /** From the execution's own cost: pages earlier tests left open in its worker when it started. */
  openAtStart: number | null;
  /** From the execution's own cost: how long its browsers waited for a CPU during it (Linux). */
  runWaitMs: number | null;
}

export interface TimelineResourcesInput {
  /** The run's resource report, one part per reporter. */
  parts: WireResourceReport[];
  shardIndex: number | null;
  workerIndex: number | null;
  /** The failure timeline's axis, in epoch ms. */
  origin: number;
  end: number;
  /** The execution's own cost, as its worker measured it. */
  cost: WireExecutionResources | null;
}

/**
 * The points of a series (on `startedAt`'s clock) that fall in the axis, on
 * the axis' clock, with the last reading before it and the first after it, so
 * the line runs across the edges.
 */
function slice(points: SeriesPoint[] | undefined, startedAt: number, origin: number, end: number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  let before: SeriesPoint | null = null;
  for (const [at, value] of points ?? []) {
    const epoch = startedAt + at;
    if (epoch < origin) {
      before = [epoch - origin, value];
      continue;
    }
    if (before) {
      out.push(before);
      before = null;
    }
    out.push([epoch - origin, value]);
    if (epoch > end) break;
  }
  // A level held from before the axis to its end, with no change inside it.
  if (before && out.length === 0) out.push(before, [end - origin, before[1]]);
  return out;
}

/** The part of the report the execution's shard sent: the only one of an unsharded run. */
function partOf(parts: WireResourceReport[], shardIndex: number | null): WireResourceReport | null {
  if (parts.length === 1) return parts[0]!;
  return parts.find((part) => (part.shardIndex ?? null) === shardIndex) ?? null;
}

/** The time the browsers waited for a CPU, summed over their roles; null where it was not measured. */
function runWaitOf(cost: WireExecutionResources | null): number | null {
  const waits = Object.values(cost?.roles ?? {})
    .map((role) => role?.runWaitMs)
    .filter((ms): ms is number => typeof ms === 'number');
  return waits.length > 0 ? Math.round(waits.reduce((sum, ms) => sum + ms, 0)) : null;
}

/** The execution's resources on its failure timeline's clock; null when nothing was measured. */
export function timelineResources(input: TimelineResourcesInput): TimelineResources | null {
  const { origin, end, cost } = input;
  const part = partOf(input.parts, input.shardIndex);
  const timeline = part?.timeline ?? null;
  const worker = input.workerIndex;
  const sampled = timeline && worker !== null ? timeline.workers?.find((w) => w.worker === worker) : undefined;
  const pages = timeline && worker !== null ? timeline.pages.find((p) => p.worker === worker) : undefined;
  const startedAt = timeline?.startedAt ?? 0;
  const resources: TimelineResources = {
    cpuCores: slice(sampled?.cpuCores, startedAt, origin, end),
    memoryBytes: slice(sampled?.memoryBytes, startedAt, origin, end),
    openPages: slice(pages?.points, startedAt, origin, end),
    memoryKind: part?.profile?.memory.kind ?? null,
    cores: part?.profile?.machine.cores || null,
    openAtStart: cost?.openAtStart?.pages ?? null,
    runWaitMs: runWaitOf(cost),
  };
  const measured =
    resources.cpuCores.length > 0 ||
    resources.memoryBytes.length > 0 ||
    resources.openPages.length > 0 ||
    resources.openAtStart !== null ||
    resources.runWaitMs !== null;
  return measured ? resources : null;
}
