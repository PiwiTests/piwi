/**
 * Pure presentation helpers for the Workers timeline (colors, time formatting,
 * and SVG layout constants). Kept dependency-free so the timeline composables
 * and the presentational sub-components can all share one source of truth.
 */
import { STATUS_PALETTE, statusPalette } from '@piwitests/run-ui/status-palette';
import { stopWords } from './stop-words';

/** Fixed pixel geometry for the timeline SVG. */
export const TIMELINE_LAYOUT = {
  barHeight: 24,
  rowGap: 8,
  labelWidth: 80,
  sidePadding: 16,
  axisHeight: 28,
  /** Height of a step bar inside an expanded sub-lane (shorter than a test bar). */
  stepBarHeight: 15,
  /** Narrowest a passed hook section is drawn; below it the section would not show anyway. */
  hookMinWidth: 1,
  /** Narrowest a failed hook section is drawn, so a millisecond teardown failure stays visible. */
  failedHookMinWidth: 8,
  /** Height of a resource track's plot, and the gap below it. */
  trackHeight: 22,
  trackGap: 6,
  /** Space between a band of resource tracks and the worker rows under it. */
  bandGap: 6,
  /** Height a worker row's strip adds, and the height of its plot (it starts 2px under the row's last bar). */
  stripHeight: 12,
  stripPlot: 10,
  /** Height of one tail of an object kept open for nothing, and the space between two stacked under a row. */
  tailHeight: 4,
  tailGap: 2,
  /** Derived: a full row is a bar plus the gap below it. */
  get rowHeight(): number {
    return this.barHeight + this.rowGap;
  },
} as const;

/**
 * Fill per reporter step category, used when a test row is expanded into its
 * step waterfall. Chosen to sit apart from the pass/fail status palette so a
 * step reads by what it did, not by an outcome; a failed step overrides to red.
 */
const STEP_CATEGORY_HEX: Record<string, string> = {
  action: '#2563eb',
  input: '#4f46e5',
  navigation: '#0891b2',
  assertion: '#7c3aed',
  wait: '#d97706',
  hook: '#64748b',
  fixture: '#94a3b8',
  setup: '#0d9488',
  api: '#c026d3',
  'test.step': '#475569',
  other: '#6b7280',
};

/** Fill for a step bar: its category color, or red when the step failed. */
export function timelineStepColor(category: string, failed: boolean): string {
  if (failed) return '#dc2626';
  return STEP_CATEGORY_HEX[category] ?? STEP_CATEGORY_HEX.other!;
}

/**
 * Amber palette for wasted-wait bars, shared by the bar renderer and the
 * tooltip swatch.
 */
export const TIMELINE_WAIT_COLORS = {
  fill: '#facc15',
  stroke: '#ca8a04',
  swatch: '#f59e0b',
} as const;

/**
 * Distinct colors for lock lanes/brackets, chosen to sit apart from the test
 * outcome palette (emerald/rose/fuchsia/zinc/amber/blue) and the amber of wasted
 * waits, so a lock never reads as a result.
 * Assigned by index in the run's sorted lock order and reused past the end.
 */
export const TIMELINE_LOCK_COLORS = [
  '#0369a1',
  '#0891b2',
  '#db2777',
  '#0d9488',
  '#c026d3',
  '#4f46e5',
  '#65a30d',
  '#c2410c',
] as const;

/** Color for the lock at `index` in the run's sorted lock order. */
export function lockColorHex(index: number): string {
  return TIMELINE_LOCK_COLORS[
    ((index % TIMELINE_LOCK_COLORS.length) + TIMELINE_LOCK_COLORS.length) % TIMELINE_LOCK_COLORS.length
  ]!;
}

/** Bar fill color for a test-case status, from the test outcome palette (a pass after a failed attempt is flaky). */
export function timelineStatusColor(status: string, flaky?: boolean | null): string {
  return statusPalette(status, flaky).color;
}

const statusFillStyles = new Map<string, { fill: string }>();

/**
 * A test bar's fill as an inline style (the palette colors are CSS variables,
 * which a `fill` attribute cannot read): one shared object per color, so a bar
 * re-rendered by a zoom patches no style.
 */
export function timelineStatusFill(status: string, flaky?: boolean | null): { fill: string } {
  const color = timelineStatusColor(status, flaky);
  let style = statusFillStyles.get(color);
  if (!style) {
    style = { fill: color };
    statusFillStyles.set(color, style);
  }
  return style;
}

type RetriedAttemptStyle = { fill: string; fillOpacity: number; stroke: string; strokeWidth: number };

const retriedAttemptStyles = new Map<string, RetriedAttemptStyle>();

/**
 * An attempt Playwright retried: a pale wash of its outcome color under an
 * outline of it, so it reads as that outcome but not as the test's last word,
 * which the next attempt's solid bar gives. One shared object per color, like
 * `timelineStatusFill`.
 */
export function timelineRetriedAttemptStyle(status: string, flaky?: boolean | null): RetriedAttemptStyle {
  const color = timelineStatusColor(status, flaky);
  let style = retriedAttemptStyles.get(color);
  if (!style) {
    style = { fill: color, fillOpacity: 0.18, stroke: color, strokeWidth: 1.5 };
    retriedAttemptStyles.set(color, style);
  }
  return style;
}

/** A running attempt's bar: the running color, amber when the Stuck? rule marks it. One shared object each. */
const RUNNING_FILL = { fill: STATUS_PALETTE.running.color };
const STUCK_FILL = { fill: STATUS_PALETTE.running.stuck!.color };
export function timelineRunningFill(stuck: boolean | undefined): { fill: string } {
  return stuck ? STUCK_FILL : RUNNING_FILL;
}

/**
 * The ghost behind a running attempt, its test's usual duration: a pale wash of the running color under a dashed
 * outline, so it reads as where the attempt would usually end, not as time that ran.
 */
export const TIMELINE_GHOST_STYLE = {
  fill: STATUS_PALETTE.running.color,
  fillOpacity: 0.12,
  stroke: STATUS_PALETTE.running.color,
  strokeOpacity: 0.7,
  strokeWidth: 1,
  strokeDasharray: '3 2',
} as const;

/**
 * Now on a live run's clock, at `browserNow` on this browser's: the browser's time, unless the results the page last
 * heard (`heard`: the latest moment they tell, `at`, and when the page heard it, `seenAt`, on the browser's clock) put
 * the run's clock ahead of it, as a runner whose clock runs ahead does and as the demo's simulated run does.
 */
export function liveRunNow(browserNow: number, heard: { at: number; seenAt: number } | null): number {
  return heard ? Math.max(browserNow, heard.at + (browserNow - heard.seenAt)) : browserNow;
}

/**
 * Where the plot of a live run ends once its clock reached `elapsedMs` from the timeline's zero: some way past it,
 * so the running bars grow into room drawn ahead, and the plot widens (and every bar moves) once in a while rather
 * than at each tick.
 */
export function livePlotEnd(elapsedMs: number): number {
  return Math.max(elapsedMs * 1.2, elapsedMs + 10_000);
}

/**
 * Which shards of a live sharded run have started, as the Timeline's header says it: `all 4 shards started`, else the
 * ones that have, `shards 1 and 3 of 4 started`. `started` are the shards from 1 that have a test on the timeline.
 */
export function shardsStartedText(started: readonly number[], total: number): string {
  const shards = [...new Set(started)].filter((shard) => shard >= 1 && shard <= total).sort((a, b) => a - b);
  if (shards.length >= total) return `all ${total} shards started`;
  if (shards.length === 0) return `no shard of ${total} started`;
  if (shards.length === 1) return `shard ${shards[0]} of ${total} started`;
  return `shards ${shards.slice(0, -1).join(', ')} and ${shards.at(-1)} of ${total} started`;
}

/**
 * Hook sections sit over their test's bar as a hatched overlay: a dark wash
 * when they passed, so the bar reads setup · body · teardown in any outcome
 * color, and a deep red with a light outline when they failed, so the broken
 * hook stands out even on a red bar.
 */
export const TIMELINE_HOOK_COLORS = {
  passed: { fill: '#0f172a', opacity: 0.3, stroke: 'none' },
  failed: { fill: '#7f1d1d', opacity: 0.9, stroke: '#fecaca' },
} as const;

/** The overlay colors for a hook section with this status. */
export function timelineHookColors(status: string): (typeof TIMELINE_HOOK_COLORS)[keyof typeof TIMELINE_HOOK_COLORS] {
  return status === 'failed' ? TIMELINE_HOOK_COLORS.failed : TIMELINE_HOOK_COLORS.passed;
}

/**
 * What a stop at Piwi's pause bar or in the editor was, in the run page's words for its reason (`stopWords`): `Stopped
 * at a breakpoint`, `Paused` for a Pause. A stop whose reporter named no reason was at a breakpoint.
 */
export function pauseReasonText(reason: string | null | undefined): string {
  return stopWords(reason ?? 'breakpoint');
}

/**
 * A stop's band over its test's bar on the workers timeline: a pale wash under
 * upright stripes and a dashed edge, so it reads as time the test stood still,
 * apart from the hatched hook sections, in any outcome color.
 */
export const TIMELINE_PAUSE_COLORS = { fill: '#f8fafc', opacity: 0.55, stripe: '#334155', stroke: '#334155' } as const;

/** Human-readable duration used for timeline ticks, bar labels and tooltips. */
export function formatTimelineTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
