/** Shared geometry helpers, palette and series definitions for the SVG trend charts. */
import { STATUS_PALETTE } from './status-palette';

/** One plotted series: how it is drawn and how the legend names it. */
export interface ChartSeries<K extends string = string> {
  key: K;
  color: string;
  label: string;
}

/**
 * Run-status series, in stacking order — failed sits on the baseline so red is
 * comparable across bars, and passed carries the bulk on top. `skipped` is the
 * plain `test.skip()` share and `fixme` the `test.fixme()` one, in two greys.
 */
export const RUN_STATUS_SERIES = [
  { key: 'failed', color: STATUS_PALETTE.failed.color, label: 'Failed' },
  { key: 'flaky', color: STATUS_PALETTE.flaky.color, label: 'Flaky' },
  { key: 'skipped', color: STATUS_PALETTE.skipped.color, label: 'Skipped' },
  { key: 'fixme', color: STATUS_PALETTE.fixme.color, label: 'Fixme' },
  { key: 'didNotRun', color: STATUS_PALETTE.didnotrun.color, label: "Didn't run" },
  { key: 'passed', color: STATUS_PALETTE.passed.color, label: 'Passed' },
] as const satisfies readonly ChartSeries[];

/** Duration series of the project performance trend. */
export const RUN_DURATION_SERIES = [
  { key: 'duration', color: 'rgb(59, 130, 246)', label: 'Total duration' },
  { key: 'avgTestDuration', color: 'rgb(34, 197, 94)', label: 'Avg test duration' },
  { key: 'p90TestDuration', color: 'rgb(249, 115, 22)', label: 'P90 test duration' },
] as const satisfies readonly ChartSeries[];

/** Per-execution outcomes coloring the test-case history bars. */
export const CASE_STATUS_SERIES = [
  { key: 'passed', color: STATUS_PALETTE.passed.color, label: 'Passed' },
  { key: 'flaky', color: STATUS_PALETTE.flaky.color, label: 'Passed on retry' },
  { key: 'failed', color: STATUS_PALETTE.failed.color, label: 'Failed' },
  { key: 'skipped', color: STATUS_PALETTE.skipped.color, label: 'Skipped' },
  { key: 'didnotrun', color: STATUS_PALETTE.didnotrun.color, label: "Didn't run" },
] as const satisfies readonly ChartSeries[];

/**
 * Storage families for the storage-analysis dashboard, coloured with an
 * Okabe-Ito categorical palette (colorblind-safe; validated for both surfaces).
 * Every mark that uses it is directly labelled, which is what keeps the closest
 * pair legible under deuteranopia.
 */
export const STORAGE_KIND_SERIES = [
  { key: 'trace', color: 'rgb(0, 114, 178)', label: 'Traces' },
  { key: 'screenshot', color: 'rgb(230, 159, 0)', label: 'Screenshots' },
  { key: 'video', color: 'rgb(213, 94, 0)', label: 'Videos' },
  { key: 'report', color: 'rgb(0, 158, 115)', label: 'Reports' },
  { key: 'attachment', color: 'rgb(204, 121, 167)', label: 'Attachments' },
  { key: 'visual-diff', color: 'rgb(86, 180, 233)', label: 'Visual diffs' },
] as const satisfies readonly ChartSeries[];

/**
 * Colors for the groups of a metric breakdown drawn as lines, in rank order:
 * the Okabe-Ito categorical palette (colorblind-safe), as the storage
 * families use. A breakdown draws at most this many lines.
 */
export const GROUP_SERIES_COLORS = [
  'rgb(0, 114, 178)',
  'rgb(230, 159, 0)',
  'rgb(0, 158, 115)',
  'rgb(213, 94, 0)',
  'rgb(204, 121, 167)',
  'rgb(86, 180, 233)',
  'rgb(240, 228, 66)',
  'rgb(117, 117, 117)',
] as const;

/** Legend rows for a series list — the color/label pairs `ChartCard` renders. */
export function legendOf(series: readonly ChartSeries[]): { color: string; label: string }[] {
  return series.map(({ color, label }) => ({ color, label }));
}

/** Y-axis ticks from 0 to the first 1/2/5×10ⁿ step multiple that clears `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const rough = max / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const steps = Math.ceil(max / step - 1e-9);
  return Array.from({ length: steps + 1 }, (_, i) => Math.round(i * step * 1e6) / 1e6);
}

/**
 * Indices worth labeling on a per-point (ordinal) x axis: the first point and
 * every point that starts a new calendar day, thinned to at most `maxTicks`.
 */
export function dayTickIndices(dates: Date[], maxTicks: number): number[] {
  if (maxTicks <= 0) return [];
  const dayStarts: number[] = [];
  for (let i = 0; i < dates.length; i++) {
    if (i === 0 || dates[i]?.toDateString() !== dates[i - 1]?.toDateString()) dayStarts.push(i);
  }
  if (dayStarts.length <= maxTicks) return dayStarts;
  const step = Math.ceil(dayStarts.length / maxTicks);
  return dayStarts.filter((_, i) => i % step === 0);
}

/** 'Jul 29' — the x-tick date format shared by every trend chart. */
export function formatTickDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Maps a timestamp onto an ordinal (per-point) x axis by interpolating between
 * the centers of the two neighboring points. Returns null outside the plotted
 * range, so a marker off the time axis is skipped.
 */
export function timeToOrdinalX(dates: Date[], centers: number[], time: number): number | null {
  if (dates.length === 0 || dates.length !== centers.length) return null;
  const times = dates.map((d) => d.getTime());
  const first = times[0] as number;
  const last = times[times.length - 1] as number;
  if (time < first || time > last) return null;
  if (times.length === 1) return centers[0] as number;
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i] as number;
    const b = times[i + 1] as number;
    if (time < a || time > b) continue;
    const fraction = b === a ? 0 : (time - a) / (b - a);
    const start = centers[i] as number;
    const end = centers[i + 1] as number;
    return start + fraction * (end - start);
  }
  return null;
}

/**
 * {@link timeToOrdinalX} for charts whose points are bucket starts: a time
 * after the newest bucket's start but before `endMs` (the end of the period)
 * sits on the newest bucket instead of falling off the axis.
 */
export function bucketTimeToX(dates: Date[], centers: number[], time: number, endMs: number): number | null {
  const x = timeToOrdinalX(dates, centers, time);
  if (x !== null) return x;
  const last = dates[dates.length - 1]?.getTime();
  return last !== undefined && time >= last && time < endMs ? (centers[centers.length - 1] ?? null) : null;
}

/**
 * Per-index slot layout for ordinal charts: `centerOf` positions points and
 * hover columns, `xOf`/`barWidth` position the bars themselves.
 */
export function barGeometry(count: number, plotWidth: number, maxBarWidth = 24) {
  const slotWidth = count > 0 ? plotWidth / count : plotWidth;
  const barWidth = Math.max(2, Math.min(maxBarWidth, slotWidth * 0.7));
  return {
    slotWidth,
    barWidth,
    centerOf: (i: number) => i * slotWidth + slotWidth / 2,
    xOf: (i: number) => i * slotWidth + (slotWidth - barWidth) / 2,
  };
}

export interface StackSegment {
  color: string;
  y: number;
  height: number;
}

/**
 * Pixel segments for one stacked bar, bottom-up in `series` order. Non-zero
 * values get at least `minPx` so a single failure stays visible next to a
 * hundred passes; the excess is taken from the tallest segment.
 */
export function stackSegments(
  series: Array<{ color: string; value: number }>,
  plotHeight: number,
  yScale: (value: number) => number,
  minPx = 2,
): StackSegment[] {
  const heights = series.map((s) => (s.value > 0 ? Math.max(minPx, plotHeight - yScale(s.value)) : 0));
  const idealTotal = series.reduce((sum, s) => sum + (s.value > 0 ? plotHeight - yScale(s.value) : 0), 0);
  const excess = heights.reduce((sum, h) => sum + h, 0) - idealTotal;
  if (excess > 0) {
    const tallest = heights.indexOf(Math.max(...heights));
    heights[tallest] = Math.max(minPx, (heights[tallest] as number) - excess);
  }
  const segments: StackSegment[] = [];
  let y = plotHeight;
  for (let i = 0; i < series.length; i++) {
    const height = heights[i] as number;
    if (height <= 0) continue;
    y -= height;
    segments.push({ color: (series[i] as { color: string }).color, y, height });
  }
  return segments;
}

/** One series of `TrendLinesChart`: a line over time buckets. */
export interface TrendLine {
  label: string;
  /** A CSS color: a palette entry's `color`, or one of `GROUP_SERIES_COLORS`. */
  color: string;
  /** Bucket start dates (`YYYY-MM-DD`), the same for every series; `note` follows the value in the tooltip. */
  points: Array<{ date: string; value: number | null; note?: string | null }>;
  dashed?: boolean;
}
