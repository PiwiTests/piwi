/**
 * The objects a run kept open for nothing, as the workers timeline draws them:
 * a leak from the end of the test (or describe block) that opened it to its
 * close or its worker's end, and a lingering object from its last use to its
 * close. Each becomes a thin tail under the row of the worker that held it,
 * on the timeline's clock; tails that overlap stack on sub-lines. The leaks'
 * pages also give the share of the open pages that were left open, which the
 * open-pages track and strip draw. Pure, so the layout and the readings are
 * unit-tested.
 */
import type { RunResourceTimelinePart } from '#shared/handlers/run-resources';
import type { SeriesPoint, WireResourceSpan } from '#shared/types';
import type { WorkerRow } from '~/composables/useTimelineModel';
import { rowsForParts, sumSteps } from '~/utils/resource-tracks';

/** One object's tail under its worker's row. */
export interface SpanTail {
  key: string;
  /** The first lane of its worker's row. */
  lane: number;
  /** Its sub-line under the row, from 0. */
  level: number;
  verdict: WireResourceSpan['verdict'];
  kind: WireResourceSpan['kind'];
  where: string;
  site: string | null;
  lastUse: string | null;
  /** Ms on the timeline's clock. */
  start: number;
  end: number;
  untilWorkerEnd: boolean;
  /** A leak: the scope it outlived. */
  scope: 'test' | 'describe' | null;
  pages: number;
  test: { title: string; file: string } | null;
  /** The row's name, `Worker 2` or `S1 W2`. */
  rowName: string;
}

/** The tails under one worker's row. */
export interface RowTails {
  lane: number;
  /** How many sub-lines its tails take. */
  levels: number;
  tails: SpanTail[];
}

/** The most sub-lines a row's tails take; past them, a tail shares the line that frees up first. */
export const MAX_TAIL_LEVELS = 3;

/** Stack tails that overlap on sub-lines, the earliest first. */
function packLevels(tails: SpanTail[]): number {
  const ends: number[] = [];
  for (const tail of [...tails].sort((a, b) => a.start - b.start || b.end - a.end)) {
    let level = ends.findIndex((end) => end <= tail.start);
    if (level < 0 && ends.length < MAX_TAIL_LEVELS) level = ends.length;
    if (level < 0) level = ends.indexOf(Math.min(...ends));
    tail.level = level;
    ends[level] = Math.max(ends[level] ?? 0, tail.end);
  }
  return ends.length;
}

function rowName(row: WorkerRow, sharded: boolean): string {
  return row.shardIndex != null && sharded ? `S${row.shardIndex} W${row.slot + 1}` : `Worker ${row.slot + 1}`;
}

/**
 * The tails under each worker row, by its first lane. `origin` is the epoch ms
 * of the timeline's zero; a span whose worker has no row is left out.
 */
export function buildSpanTails(
  parts: RunResourceTimelinePart[],
  rows: WorkerRow[],
  origin: number,
  sharded: boolean,
): RowTails[] {
  const byLane = new Map<number, SpanTail[]>();
  for (const { part, rows: shardRows } of rowsForParts(parts, rows)) {
    const shift = part.timeline.startedAt - origin;
    (part.timeline.spans ?? []).forEach((span, i) => {
      const row = shardRows.find((r) => r.processes.includes(span.worker));
      if (!row) return;
      const list = byLane.get(row.baseLane) ?? [];
      list.push({
        key: `${part.shardIndex ?? 'all'}-${i}`,
        lane: row.baseLane,
        level: 0,
        verdict: span.verdict,
        kind: span.kind,
        where: span.where,
        site: span.site ?? null,
        lastUse: span.lastUse ?? null,
        start: span.from + shift,
        end: Math.max(span.from, span.to) + shift,
        untilWorkerEnd: span.untilWorkerEnd === true,
        scope: span.scope ?? null,
        pages: span.pages ?? 0,
        test: span.test ?? null,
        rowName: rowName(row, sharded),
      });
      byLane.set(row.baseLane, list);
    });
  }
  return [...byLane.entries()]
    .map(([lane, tails]) => ({ lane, levels: packLevels(tails), tails }))
    .sort((a, b) => a.lane - b.lane);
}

/**
 * The pages left open over time in one worker, from its leaked objects'
 * spans: each one's pages from its scope's end to its close. A step series.
 */
export function leftOpenPages(tails: SpanTail[]): SeriesPoint[] {
  const changes: SeriesPoint[] = [];
  for (const tail of tails) {
    if (tail.verdict !== 'leaked' || tail.pages <= 0) continue;
    changes.push([tail.start, tail.pages], [tail.end, -tail.pages]);
  }
  if (changes.length === 0) return [];
  changes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: SeriesPoint[] = [];
  let open = 0;
  for (const [at, delta] of changes) {
    open = Math.max(0, open + delta);
    const last = out[out.length - 1];
    if (last && last[0] === at) last[1] = open;
    else out.push([at, open]);
  }
  return out;
}

/** The pages left open over time across several workers' rows. */
export function leftOpenAcross(rows: RowTails[]): SeriesPoint[] {
  return sumSteps(rows.map((row) => leftOpenPages(row.tails)));
}

/** The tail at `t` (ms on the timeline's clock) on sub-line `level` of a row, the shortest when several cover it. */
export function tailAt(row: RowTails, t: number, level: number): SpanTail | null {
  let found: SpanTail | null = null;
  for (const tail of row.tails) {
    if (tail.level !== level || t < tail.start || t > tail.end) continue;
    if (!found || tail.end - tail.start < found.end - found.start) found = tail;
  }
  return found;
}

/** The tails' outline on each sub-line, x in ms and y in px from the area's top, for one verdict. */
export function tailsPath(tails: SpanTail[], verdict: SpanTail['verdict'], height: number, stride: number): string {
  return tails
    .filter((tail) => tail.verdict === verdict)
    .map((tail) => {
      const y = tail.level * stride;
      return `M${tail.start},${y}H${Math.max(tail.end, tail.start)}V${y + height}H${tail.start}Z`;
    })
    .join('');
}
