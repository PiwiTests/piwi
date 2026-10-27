/**
 * The resources rows of an execution's failure timeline: the CPU and memory of
 * the worker that ran the test, with the browsers it started, and the pages
 * open in that worker, each a row under the lanes on the timeline's clock; and
 * what they read at a moment, for the readout under the axis. Pure, so the card
 * and the unit tests share one set of rules.
 */
import type { SeriesPoint } from '#shared/types';
import type { TimelineResources } from '#shared/timeline-resources';
import { formatCpuTime, formatSize } from '#shared/resource-copy';

export type TimelineResourceKind = 'cpu' | 'memory' | 'pages';

export interface TimelineResourceRow {
  kind: TimelineResourceKind;
  /** The row's name in the label column. */
  label: string;
  /** On the timeline's clock: ms after its `origin`. */
  points: SeriesPoint[];
  /** The value the top of the row stands for. */
  yMax: number;
  /** A level held until the next point (open pages), rather than a reading at each point. */
  step: boolean;
  /** What the top of the row stands for, in words. */
  scaleLabel: string;
}

function peak(points: SeriesPoint[]): number {
  return points.reduce((max, [, value]) => Math.max(max, value), 0);
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The rows the timeline draws, in order, each only when it has readings. */
export function timelineResourceRows(resources: TimelineResources | null | undefined): TimelineResourceRow[] {
  if (!resources) return [];
  const rows: TimelineResourceRow[] = [];
  if (resources.cpuCores.length > 0) {
    const top = Math.max(1, peak(resources.cpuCores));
    const cores = resources.cores ? ` of ${resources.cores}` : '';
    rows.push({
      kind: 'cpu',
      label: 'CPU',
      points: resources.cpuCores,
      yMax: top,
      step: false,
      scaleLabel: `The worker and its browsers, in cores: the top is ${round1(top)}${cores}`,
    });
  }
  if (resources.memoryBytes.length > 0) {
    const top = peak(resources.memoryBytes);
    const kind = resources.memoryKind ? ` (${resources.memoryKind.toUpperCase()})` : '';
    rows.push({
      kind: 'memory',
      label: 'Memory',
      points: resources.memoryBytes,
      yMax: top,
      step: false,
      scaleLabel: `The worker and its browsers${kind}: the top is ${formatSize(top)}`,
    });
  }
  if (resources.openPages.length > 0) {
    const top = Math.max(1, peak(resources.openPages));
    rows.push({
      kind: 'pages',
      label: 'Pages',
      points: resources.openPages,
      yMax: top,
      step: true,
      scaleLabel: `Pages open in the worker: the top is ${top}`,
    });
  }
  return rows;
}

/**
 * A row's reading at `at`: a level held from its last change for open pages;
 * otherwise the reading of the interval `at` falls in, the first point at or
 * after it (each point covers the interval ending at it). Null outside the
 * series.
 */
export function readingAt(row: TimelineResourceRow, at: number): number | null {
  const points = row.points;
  if (points.length === 0) return null;
  if (row.step) {
    let value: number | null = null;
    for (const [t, v] of points) {
      if (t > at) break;
      value = v;
    }
    return value;
  }
  for (const [t, v] of points) if (t >= at) return v;
  return null;
}

/** The rows' readings at `at`, as one line: `1.8 cores · 412 MB · 9 open pages`. */
export function resourceReadout(rows: TimelineResourceRow[], at: number): string {
  const parts: string[] = [];
  for (const row of rows) {
    const value = readingAt(row, at);
    if (value === null) continue;
    if (row.kind === 'cpu') parts.push(`${round1(value)} core${value === 1 ? '' : 's'}`);
    else if (row.kind === 'memory') parts.push(formatSize(value));
    else parts.push(`${value} open page${value === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

/** What the execution measured itself, as short facts: the pages it found open, the wait for a CPU. */
export function resourceFacts(resources: TimelineResources | null | undefined): string[] {
  if (!resources) return [];
  const facts: string[] = [];
  if (resources.openAtStart) {
    const n = resources.openAtStart;
    facts.push(`${n} page${n === 1 ? '' : 's'} earlier tests left open in its worker when it started`);
  }
  if (resources.runWaitMs && resources.runWaitMs >= 100) {
    facts.push(`its browsers waited ${formatCpuTime(resources.runWaitMs)} for a CPU`);
  }
  return facts;
}
