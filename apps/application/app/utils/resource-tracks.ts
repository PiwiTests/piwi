/**
 * The resource tracks of the run's workers timeline: the machine's CPU, the
 * run's memory and the pages open in its workers, drawn above the worker rows
 * on the timeline's clock. One band of tracks per reporter that sent them,
 * above the rows of its shard, since each shard ran on its own machine.
 * Pure, so the layout and the readings are unit-tested.
 */
import type { RunExecutionCost, RunResourceTimelinePart } from '#shared/handlers/run-resources';
import type { SeriesPoint } from '#shared/types';
import { formatSize } from '#shared/resource-copy';
import type { TimelineItem, WorkerRow } from '~/composables/useTimelineModel';

export type ResourceTrackKind = 'cpu' | 'memory' | 'pages';

/** The tracks in the order they are drawn, with the name each one goes by. */
export const RESOURCE_TRACK_KINDS: ReadonlyArray<{ kind: ResourceTrackKind; label: string; menuLabel: string }> = [
  { kind: 'cpu', label: 'CPU', menuLabel: 'CPU' },
  { kind: 'memory', label: 'Memory', menuLabel: 'Memory' },
  { kind: 'pages', label: 'Pages', menuLabel: 'Open pages' },
];

/** Which tracks are shown: all of them until the viewer turns one off. */
export type ResourceTrackVisibility = Record<ResourceTrackKind, boolean>;
export const ALL_RESOURCE_TRACKS: ResourceTrackVisibility = { cpu: true, memory: true, pages: true };

/** One track: a series on the timeline's clock (ms after the run's first test) and its scale. */
export interface ResourceTrack {
  kind: ResourceTrackKind;
  points: SeriesPoint[];
  /** The value the top of the track stands for. */
  yMax: number;
  /** A level held until the next point (open pages), rather than a reading at each point. */
  step: boolean;
  /** Memory: the top is the machine's memory or its container's limit, close enough to matter. */
  atCapacity: boolean;
  /** What the label column says under the track's name: the value of its top. */
  scaleLabel: string;
}

/** The tracks of one reporter, placed above the rows of its shard. */
export interface ResourceBand {
  key: string;
  shardIndex: number | null;
  /** The track names' prefix when the run has several shards: `S1`. */
  prefix: string | null;
  /** The first lane of the band's shard: the band sits above it. */
  firstLane: number;
  tracks: Record<ResourceTrackKind, ResourceTrack | null>;
  /** Each lane's open pages, named as its row is, with the row's first lane when the lane has a row. */
  workers: Array<{ name: string; lane: number | null; points: SeriesPoint[] }>;
  /** Each lane's worker processes with the browsers they started, as the run sampler read them. */
  sampled: Array<{ lane: number; cpuCores: SeriesPoint[]; memoryBytes: SeriesPoint[] }>;
  memoryKind: 'pss' | 'rss' | null;
}

/** The memory at which the track is drawn against the machine's capacity rather than the run's peak. */
const CAPACITY_SCALE_RATIO = 1.5;

/** The sum of step series: at each change of any of them, the total of their current values. */
export function sumSteps(series: SeriesPoint[][]): SeriesPoint[] {
  const events = series.flatMap((points, index) => points.map(([at, value]) => ({ at, index, value })));
  events.sort((a, b) => a.at - b.at);
  const current = series.map(() => 0);
  const out: SeriesPoint[] = [];
  let total = 0;
  for (const { at, index, value } of events) {
    total += value - current[index]!;
    current[index] = value;
    const last = out[out.length - 1];
    if (last && last[0] === at) last[1] = total;
    else out.push([at, total]);
  }
  return out;
}

function peak(points: SeriesPoint[]): number {
  return points.reduce((max, [, value]) => Math.max(max, value), 0);
}

function rowName(row: WorkerRow, sharded: boolean): string {
  return row.shardIndex != null && sharded ? `S${row.shardIndex} W${row.slot + 1}` : `Worker ${row.slot + 1}`;
}

/**
 * Each reporter's part with the worker rows of its shard. A part whose shard
 * has no rows is left out; a run with a single reporter and a single shard of
 * rows pairs them whatever their shard numbers say.
 */
export function rowsForParts(
  parts: RunResourceTimelinePart[],
  rows: WorkerRow[],
): Array<{ part: RunResourceTimelinePart; first: WorkerRow; rows: WorkerRow[] }> {
  const firstRowByShard = new Map<number | null, WorkerRow>();
  for (const row of rows) if (!firstRowByShard.has(row.shardIndex)) firstRowByShard.set(row.shardIndex, row);
  const out: Array<{ part: RunResourceTimelinePart; first: WorkerRow; rows: WorkerRow[] }> = [];
  for (const part of parts) {
    let first = firstRowByShard.get(part.shardIndex);
    if (!first && parts.length === 1 && firstRowByShard.size === 1) first = [...firstRowByShard.values()][0];
    if (!first) continue;
    out.push({ part, first, rows: rows.filter((row) => row.shardIndex === first.shardIndex) });
  }
  return out;
}

/**
 * The bands of the run's resource tracks. `origin` is the epoch ms of the
 * timeline's zero (its first test's start); parts pair with rows as
 * `rowsForParts` says.
 */
export function buildResourceBands(
  parts: RunResourceTimelinePart[],
  rows: WorkerRow[],
  origin: number,
  sharded: boolean,
): ResourceBand[] {
  const bands: ResourceBand[] = [];
  for (const { part, first, rows: shardRows } of rowsForParts(parts, rows)) {
    const shift = part.timeline.startedAt - origin;
    const onClock = (points: SeriesPoint[]): SeriesPoint[] => points.map(([at, value]) => [at + shift, value]);

    const cpu = onClock(part.timeline.cpuPct);
    const memory = onClock(part.timeline.memoryBytes);
    const memoryPeak = peak(memory);
    const capacity = part.memoryCapacityBytes;
    const atCapacity = capacity !== null && capacity > 0 && capacity <= memoryPeak * CAPACITY_SCALE_RATIO;

    // A lane's processes run one after another, so its pages are their sum.
    const byLane = new Map<string, { name: string; lane: number | null; series: SeriesPoint[][] }>();
    for (const { worker, points } of part.timeline.pages) {
      const row = shardRows.find((r) => r.processes.includes(worker));
      const name = row ? rowName(row, sharded) : `Process ${worker}`;
      const entry = byLane.get(name) ?? { name, lane: row?.baseLane ?? null, series: [] };
      entry.series.push(onClock(points));
      byLane.set(name, entry);
    }
    const workers = [...byLane.values()].map(({ name, lane, series }) => ({ name, lane, points: sumSteps(series) }));

    // A lane's processes ran one after another: their readings join in time order.
    const sampledByLane = new Map<number, { lane: number; cpuCores: SeriesPoint[]; memoryBytes: SeriesPoint[] }>();
    for (const tree of part.timeline.workers ?? []) {
      const row = shardRows.find((r) => r.processes.includes(tree.worker));
      if (!row) continue;
      const entry = sampledByLane.get(row.baseLane) ?? { lane: row.baseLane, cpuCores: [], memoryBytes: [] };
      entry.cpuCores = [...entry.cpuCores, ...onClock(tree.cpuCores)].sort((a, b) => a[0] - b[0]);
      entry.memoryBytes = [...entry.memoryBytes, ...onClock(tree.memoryBytes)].sort((a, b) => a[0] - b[0]);
      sampledByLane.set(row.baseLane, entry);
    }
    const pages = sumSteps(workers.map((w) => w.points));
    const pagesPeak = peak(pages);

    bands.push({
      key: `resources-${part.shardIndex ?? 'all'}`,
      shardIndex: part.shardIndex,
      prefix: sharded && part.shardIndex != null ? `S${part.shardIndex}` : null,
      firstLane: first.baseLane,
      tracks: {
        cpu:
          cpu.length > 0
            ? { kind: 'cpu', points: cpu, yMax: 100, step: false, atCapacity: false, scaleLabel: '100%' }
            : null,
        memory:
          memory.length > 0 && memoryPeak > 0
            ? {
                kind: 'memory',
                points: memory,
                yMax: atCapacity ? capacity : memoryPeak,
                step: false,
                atCapacity,
                scaleLabel: atCapacity ? `limit ${formatSize(capacity)}` : `peak ${formatSize(memoryPeak)}`,
              }
            : null,
        pages:
          pages.length > 0
            ? {
                kind: 'pages',
                points: pages,
                yMax: Math.max(1, pagesPeak),
                step: true,
                atCapacity: false,
                scaleLabel: `peak ${pagesPeak}`,
              }
            : null,
      },
      workers,
      sampled: [...sampledByLane.values()],
      memoryKind: part.memoryKind,
    });
  }
  return bands.sort((a, b) => a.firstLane - b.firstLane);
}

/** The tracks of a band that are drawn: present in its data and shown. */
export function shownTracks(band: ResourceBand, visibility: ResourceTrackVisibility): ResourceTrack[] {
  return RESOURCE_TRACK_KINDS.map(({ kind }) => (visibility[kind] ? band.tracks[kind] : null)).filter(
    (track): track is ResourceTrack => track !== null,
  );
}

/** How far from a reading the readout still shows it. */
const READING_REACH_MS = 6000;

/**
 * A track's value at `t` (ms on the timeline's clock): a step series' level
 * then (zero before its first point), a sampled series' nearest reading, or
 * null when no reading is near.
 */
export function valueAt(points: SeriesPoint[], t: number, step: boolean): number | null {
  if (points.length === 0) return null;
  // The last point at or before t.
  let lo = 0;
  let hi = points.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] <= t) {
      at = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (step) return at < 0 ? 0 : points[at]![1];
  const before = at >= 0 ? points[at]! : null;
  const after = points[at + 1] ?? null;
  const nearest = before && after ? (t - before[0] <= after[0] - t ? before : after) : (before ?? after)!;
  return Math.abs(nearest[0] - t) <= READING_REACH_MS ? nearest[1] : null;
}

/**
 * A track's line and the area under it, with x in ms on the timeline's clock
 * and y in px from the track's top: the timeline scales x to its zoom, so a
 * zoom never rebuilds them.
 */
export function trackPaths(track: ResourceTrack, height: number): { line: string; area: string } {
  return seriesPaths(track.points, track.yMax, track.step, height);
}

/** A series' line and the area under it, as `trackPaths` draws them. */
export function seriesPaths(
  points: SeriesPoint[],
  yMax: number,
  step: boolean,
  height: number,
): { line: string; area: string } {
  if (points.length === 0 || yMax <= 0) return { line: '', area: '' };
  const y = (value: number) => Math.round((height - (Math.min(value, yMax) / yMax) * height) * 10) / 10;
  const line: string[] = [];
  points.forEach(([at, value], i) => {
    if (i === 0) line.push(`M${at},${y(value)}`);
    else if (step) line.push(`H${at}`, `V${y(value)}`);
    else line.push(`L${at},${y(value)}`);
  });
  const first = points[0]![0];
  const last = points[points.length - 1]![0];
  return { line: line.join(''), area: `M${first},${height}${line.join('').replace(/^M/, 'L')}L${last},${height}Z` };
}

/** A track's value as the readout prints it. */
export function formatTrackValue(kind: ResourceTrackKind, value: number): string {
  if (kind === 'cpu') return `${Math.round(value)}%`;
  if (kind === 'memory') return formatSize(value);
  return `${value} open`;
}

// ── Under each worker ─────────────────────────────────────────────────────────

export type WorkerMetricKind = 'pages' | 'cpu' | 'wait' | 'memory';

/** What the strip under each worker row can draw, one at a time. */
export const WORKER_METRICS: ReadonlyArray<{ kind: WorkerMetricKind; menuLabel: string }> = [
  { kind: 'pages', menuLabel: 'Open pages' },
  { kind: 'cpu', menuLabel: 'CPU' },
  { kind: 'wait', menuLabel: 'Waiting for a CPU' },
  { kind: 'memory', menuLabel: 'Memory' },
];

/** One test's value, drawn across its bar. */
export interface StripSpan {
  start: number;
  end: number;
  value: number;
  title: string;
}

/**
 * The strip under one worker row: a level held until it changes (open
 * pages), readings of the worker's processes over time (sampled CPU and
 * memory), or one value per test, from what each test cost.
 */
export interface WorkerStrip {
  /** The row's first lane. */
  lane: number;
  name: string;
  mode: 'step' | 'line' | 'spans';
  points: SeriesPoint[];
  spans: StripSpan[];
  /** Open pages: how many of them earlier tests left open, a step series under `points`. */
  leftOpen: SeriesPoint[];
  /** Sampled memory: PSS, or RSS where PSS could not be read. */
  memoryKind: 'pss' | 'rss' | null;
}

/** The strips of every worker row for one metric, on one scale so the rows compare. */
export interface WorkerStripSet {
  kind: WorkerMetricKind;
  yMax: number;
  /** The value of the strips' top, with its unit. */
  scaleLabel: string;
  strips: WorkerStrip[];
}

const MB = 1024 * 1024;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A test's own duration: the one Playwright reported, which the worker's measurement spans. */
function testDuration(item: TimelineItem): number {
  return item.reportedDuration ?? item.duration;
}

/** One test's value of a per-test metric from what it cost; null when it was not measured. */
function perTestValue(kind: Exclude<WorkerMetricKind, 'pages'>, cost: RunExecutionCost, durationMs: number) {
  if (durationMs <= 0) return null;
  if (kind === 'cpu') return round2(cost.cpuMs / durationMs);
  if (kind === 'wait') return cost.runWaitMs === null ? null : Math.round((cost.runWaitMs / durationMs) * 1000) / 10;
  return cost.peakRssMb === null ? null : cost.peakRssMb * MB;
}

function scaleLabel(kind: WorkerMetricKind, yMax: number): string {
  if (kind === 'pages') return `${yMax} page${yMax === 1 ? '' : 's'}`;
  if (kind === 'cpu') return `${round2(yMax)} core${yMax === 1 ? '' : 's'}`;
  if (kind === 'wait') return `${Math.round(yMax)}% wait`;
  return formatSize(yMax);
}

function sampledSeries(band: ResourceBand, lane: number, kind: 'cpu' | 'memory'): SeriesPoint[] {
  const tree = band.sampled.find((entry) => entry.lane === lane);
  return (kind === 'cpu' ? tree?.cpuCores : tree?.memoryBytes) ?? [];
}

/** The metrics the run has data for, in the menu's order. */
export function availableWorkerMetrics(bands: ResourceBand[], costs: RunExecutionCost[]): WorkerMetricKind[] {
  const sampled = bands.flatMap((band) => band.sampled);
  const has: Record<WorkerMetricKind, boolean> = {
    pages: bands.some((band) => band.workers.some((worker) => worker.lane !== null)),
    cpu: costs.length > 0 || sampled.some((tree) => tree.cpuCores.length > 0),
    wait: costs.some((cost) => cost.runWaitMs !== null),
    memory: costs.some((cost) => cost.peakRssMb !== null) || sampled.some((tree) => tree.memoryBytes.length > 0),
  };
  return WORKER_METRICS.map((metric) => metric.kind).filter((kind) => has[kind]);
}

/**
 * The strips of one metric under every worker row: the pages open in the
 * worker over time; the CPU and memory of the worker and the browsers it
 * started, as the run sampler read them; and where the sampler did not read a
 * worker, from what each of its tests cost, the cores its worker and browsers
 * used, the share of the test their browsers spent waiting for a CPU, or its
 * largest browser process. Null when no row has data for the metric.
 */
export function buildWorkerStrips(
  kind: WorkerMetricKind,
  input: {
    rows: WorkerRow[];
    bands: ResourceBand[];
    tests: TimelineItem[];
    costs: RunExecutionCost[];
    sharded: boolean;
    /** Open pages: the pages left open in each row, by its first lane. */
    leftOpen?: Map<number, SeriesPoint[]>;
  },
): WorkerStripSet | null {
  const strips = new Map<number, WorkerStrip>(
    input.rows.map((row) => [
      row.baseLane,
      {
        lane: row.baseLane,
        name: rowName(row, input.sharded),
        mode: kind === 'pages' ? 'step' : 'spans',
        points: [],
        spans: [],
        leftOpen: kind === 'pages' ? (input.leftOpen?.get(row.baseLane) ?? []) : [],
        memoryKind: null,
      },
    ]),
  );
  let yMax = 0;
  for (const band of input.bands) {
    for (const worker of kind === 'pages' ? band.workers : []) {
      const strip = worker.lane === null ? undefined : strips.get(worker.lane);
      if (!strip) continue;
      strip.points = worker.points;
      yMax = Math.max(yMax, peak(worker.points));
    }
    if (kind !== 'cpu' && kind !== 'memory') continue;
    for (const tree of band.sampled) {
      const strip = strips.get(tree.lane);
      const series = sampledSeries(band, tree.lane, kind);
      if (!strip || series.length === 0) continue;
      Object.assign(strip, { mode: 'line', points: series, memoryKind: band.memoryKind });
      yMax = Math.max(yMax, peak(series));
    }
  }
  if (kind !== 'pages') {
    const costs = new Map(input.costs.map((cost) => [cost.executionId, cost]));
    for (const item of input.tests) {
      const cost = item.kind === 'test' && item.testCaseId != null ? costs.get(item.testCaseId) : undefined;
      const strip = strips.get(item.rowIndex);
      // A row the sampler read draws its readings, not its tests' averages.
      if (!cost || !strip || strip.mode !== 'spans') continue;
      const value = perTestValue(kind, cost, testDuration(item));
      if (value === null) continue;
      strip.spans.push({ start: item.start, end: item.start + item.duration, value, title: item.title });
      yMax = Math.max(yMax, value);
    }
  }
  const drawn = [...strips.values()];
  if (!drawn.some((strip) => strip.points.length > 0 || strip.spans.length > 0)) return null;
  // Every value zero (no page left open, no wait): a scale of one, with nothing drawn above the baseline.
  const top = yMax > 0 ? yMax : 1;
  return { kind, yMax: top, scaleLabel: scaleLabel(kind, top), strips: drawn };
}

/** The bars of a strip's tests, x in ms on the timeline's clock and y in px from the strip's top. */
export function spansPath(spans: StripSpan[], yMax: number, height: number): string {
  if (yMax <= 0) return '';
  return spans
    .map((span) => {
      const y = Math.round((height - (Math.min(span.value, yMax) / yMax) * height) * 10) / 10;
      return `M${span.start},${height}V${y}H${span.end}V${height}Z`;
    })
    .join('');
}

/** What a strip says at `t`: its level or reading then, or the value of the test running then; null when none. */
export function stripReading(set: WorkerStripSet, strip: WorkerStrip, t: number): string | null {
  if (strip.mode === 'step') {
    if (strip.points.length === 0) return null;
    const open = valueAt(strip.points, t, true) ?? 0;
    const left = strip.leftOpen.length > 0 ? Math.min(open, valueAt(strip.leftOpen, t, true) ?? 0) : 0;
    return left > 0 ? `${open} open, ${left} left open by earlier tests` : `${open} open`;
  }
  if (strip.mode === 'line') {
    const value = valueAt(strip.points, t, false);
    if (value === null) return null;
    if (set.kind === 'cpu') return `${round2(value)} cores, the worker and its browsers`;
    const kind = strip.memoryKind ? ` (${strip.memoryKind.toUpperCase()})` : '';
    return `${formatSize(value)}, the worker and its browsers${kind}`;
  }
  const span = strip.spans.find((s) => s.start <= t && t <= s.end);
  if (!span) return null;
  const during = `“${span.title}”`;
  if (set.kind === 'cpu') return `${span.value} cores for ${during}`;
  if (set.kind === 'wait') return `${span.value}% of ${during} waiting for a CPU`;
  return `${formatSize(span.value)}, the largest browser process of ${during}`;
}

// ── Vertical layout ──────────────────────────────────────────────────────────

/** Where each lane, worker row, band and strip sits, from the top of the timeline. */
export interface TimelineRowsLayout {
  /** Y of each lane's top. */
  laneTop: number[];
  /**
   * Per worker row, in order: its top and bottom (tails and strip included), the top of the band above it, if any,
   * and the tops of its tails and strip.
   */
  rows: Array<{ top: number; bottom: number; sectionTop: number; tailTop: number | null; stripTop: number | null }>;
  /** Y of each band's top, by the first lane it sits above. */
  bandTop: Map<number, number>;
  /** Height of the whole content, axis included. */
  height: number;
}

/**
 * Stack the timeline vertically: under the axis, each band of tracks right
 * above the first row of its shard, each worker row's lanes, the tails of the
 * objects its worker kept open for nothing (`tailHeights`, by the row's first
 * lane) right under its last bar, and with `strips`, a strip under each row
 * before the gap to the next row.
 */
export function layOutTimelineRows(
  rows: WorkerRow[],
  options: {
    bandHeights: Map<number, number>;
    tailHeights?: Map<number, number>;
    strips: boolean;
    stripHeight: number;
    rowHeight: number;
    rowGap: number;
    axisHeight: number;
  },
): TimelineRowsLayout {
  const { bandHeights, tailHeights, strips, stripHeight, rowHeight, rowGap, axisHeight } = options;
  const laneTop: number[] = [];
  const out: TimelineRowsLayout['rows'] = [];
  const bandTop = new Map<number, number>();
  let y = axisHeight;
  for (const row of rows) {
    const sectionTop = y;
    const band = bandHeights.get(row.baseLane);
    if (band) {
      bandTop.set(row.baseLane, y);
      y += band;
    }
    const top = y;
    for (let i = 0; i < row.laneSpan; i++) laneTop[row.baseLane + i] = top + i * rowHeight;
    y += row.laneSpan * rowHeight;
    let tailTop: number | null = null;
    const tails = tailHeights?.get(row.baseLane) ?? 0;
    if (tails > 0) {
      tailTop = y - rowGap + 2;
      y += tails;
    }
    let stripTop: number | null = null;
    if (strips) {
      stripTop = y - rowGap + 2;
      y += stripHeight;
    }
    out.push({ top, bottom: y, sectionTop, tailTop, stripTop });
  }
  return { laneTop, rows: out, bandTop, height: y };
}
