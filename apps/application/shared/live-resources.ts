/**
 * A live run's resources: what each reporter posts while someone has the run
 * open (`POST /api/test-runs/:id/live-resources`), merged into the series the
 * run's workers timeline draws. The server keeps the merged parts in memory
 * until the run ends, and the run page applies the same posts as they arrive
 * on its live stream, so both read them with these functions. Pure, so the
 * server, the demo and the page share them.
 */
import type { RunResourceTimelinePart } from '#shared/handlers/run-resources';
import { sanitizeResourceTimeline } from '#shared/resource-report';
import type { SeriesPoint, WireLiveResources, WireResourceTimeline } from '#shared/types';

/** The most points kept of the machine's CPU and of the run's memory; past it, neighbors merge two by two. */
export const LIVE_SERIES_CAP = 1200;
/** The most points kept of each worker's CPU and memory. */
export const LIVE_WORKER_POINTS_CAP = 600;

/** A live post rebuilt from an untrusted body; null when it carries no series. */
export function sanitizeLiveResources(value: unknown): WireLiveResources | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const timeline = sanitizeResourceTimeline(raw.timeline);
  if (!timeline) return null;
  const shardIndex = typeof raw.shardIndex === 'number' && Number.isInteger(raw.shardIndex) ? raw.shardIndex : null;
  const capacity = raw.memoryCapacityBytes;
  return {
    shardIndex: shardIndex !== null && shardIndex >= 0 ? shardIndex : null,
    reset: raw.reset === true,
    timeline,
    memoryCapacityBytes: typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0 ? capacity : null,
    memoryKind: raw.memoryKind === 'pss' || raw.memoryKind === 'rss' ? raw.memoryKind : null,
  };
}

/** A series with at most `cap` points: neighbors merge two by two, at the first one's time, as often as needed. */
function capped(points: SeriesPoint[], cap: number, merge: (a: number, b: number) => number): SeriesPoint[] {
  let out = points;
  while (out.length > cap) {
    const merged: SeriesPoint[] = [];
    for (let i = 0; i < out.length; i += 2) {
      const next = out[i + 1];
      merged.push(next ? [out[i]![0], merge(out[i]![1], next[1])] : out[i]!);
    }
    out = merged;
  }
  return out;
}

const mean = (a: number, b: number): number => Math.round(((a + b) / 2) * 100) / 100;

/** `points` followed by those of `more` read after its last one, shifted by `shift` ms, within `cap`. */
function appended(
  points: SeriesPoint[],
  more: SeriesPoint[],
  shift: number,
  cap: number,
  merge: (a: number, b: number) => number,
): SeriesPoint[] {
  const last = points.length > 0 ? points[points.length - 1]![0] : -Infinity;
  const added = more.map(([at, value]): SeriesPoint => [at + shift, value]).filter(([at]) => at > last);
  return added.length === 0 ? points : capped([...points, ...added], cap, merge);
}

/** A reporter's series as a post that holds them all states them. */
function fromPost(post: WireLiveResources): RunResourceTimelinePart {
  const timeline = post.timeline;
  return {
    shardIndex: post.shardIndex,
    timeline: {
      startedAt: timeline.startedAt,
      cpuPct: capped(timeline.cpuPct, LIVE_SERIES_CAP, mean),
      memoryBytes: capped(timeline.memoryBytes, LIVE_SERIES_CAP, Math.max),
      pages: timeline.pages,
      workers: (timeline.workers ?? []).map((tree) => ({
        worker: tree.worker,
        cpuCores: capped(tree.cpuCores, LIVE_WORKER_POINTS_CAP, mean),
        memoryBytes: capped(tree.memoryBytes, LIVE_WORKER_POINTS_CAP, Math.max),
      })),
    },
    memoryCapacityBytes: post.memoryCapacityBytes,
    memoryKind: post.memoryKind,
  };
}

/**
 * A reporter's series with one more post applied: a post that holds them all
 * (`reset`) replaces them; any other adds the points read after the last ones
 * held, replaces the open pages of each worker it names, and keeps the rest.
 */
export function applyLiveResources(
  part: RunResourceTimelinePart | null,
  post: WireLiveResources,
): RunResourceTimelinePart {
  if (!part || post.reset) return fromPost(post);
  const held = part.timeline;
  const shift = post.timeline.startedAt - held.startedAt;
  const pages = new Map(held.pages.map((entry) => [entry.worker, entry]));
  for (const entry of post.timeline.pages) {
    pages.set(entry.worker, {
      worker: entry.worker,
      points: entry.points.map(([at, n]): SeriesPoint => [at + shift, n]),
    });
  }
  const workers = new Map((held.workers ?? []).map((tree) => [tree.worker, tree]));
  for (const tree of post.timeline.workers ?? []) {
    const before = workers.get(tree.worker) ?? { worker: tree.worker, cpuCores: [], memoryBytes: [] };
    workers.set(tree.worker, {
      worker: tree.worker,
      cpuCores: appended(before.cpuCores, tree.cpuCores, shift, LIVE_WORKER_POINTS_CAP, mean),
      memoryBytes: appended(before.memoryBytes, tree.memoryBytes, shift, LIVE_WORKER_POINTS_CAP, Math.max),
    });
  }
  const timeline: WireResourceTimeline = {
    startedAt: held.startedAt,
    cpuPct: appended(held.cpuPct, post.timeline.cpuPct, shift, LIVE_SERIES_CAP, mean),
    memoryBytes: appended(held.memoryBytes, post.timeline.memoryBytes, shift, LIVE_SERIES_CAP, Math.max),
    pages: [...pages.values()].sort((a, b) => a.worker - b.worker),
    workers: [...workers.values()].sort((a, b) => a.worker - b.worker),
  };
  return {
    shardIndex: part.shardIndex,
    timeline,
    memoryCapacityBytes: post.memoryCapacityBytes ?? part.memoryCapacityBytes,
    memoryKind: post.memoryKind ?? part.memoryKind,
  };
}

/** A run's parts, one per reporter in shard order, with a post applied to the part of the reporter that sent it. */
export function applyLiveResourcesToParts(
  parts: RunResourceTimelinePart[],
  post: WireLiveResources,
): RunResourceTimelinePart[] {
  const index = parts.findIndex((part) => part.shardIndex === post.shardIndex);
  const next = applyLiveResources(index >= 0 ? parts[index]! : null, post);
  const out = index >= 0 ? parts.map((part, i) => (i === index ? next : part)) : [...parts, next];
  return out.sort((a, b) => (a.shardIndex ?? -1) - (b.shardIndex ?? -1));
}

/** A held part as a post that replaces a client's copy: the catch-up a page gets when it opens mid-run. */
export function liveResourcesSnapshot(part: RunResourceTimelinePart): WireLiveResources {
  return {
    shardIndex: part.shardIndex,
    reset: true,
    timeline: part.timeline,
    memoryCapacityBytes: part.memoryCapacityBytes,
    memoryKind: part.memoryKind,
  };
}
