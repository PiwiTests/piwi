/**
 * Pure presentation helpers for the Workers timeline (colors, time formatting,
 * and SVG layout constants). Kept dependency-free so the timeline composables
 * and the presentational sub-components can all share one source of truth.
 */
import { statusPalette } from './status-palette';

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

/** Bar fill color for a test-case status, from the test outcome palette (a pass after a retry is flaky). */
export function timelineStatusColor(status: string, retries?: number | null): string {
  return statusPalette(status, retries).color;
}

const statusFillStyles = new Map<string, { fill: string }>();

/**
 * A test bar's fill as an inline style (the palette colors are CSS variables,
 * which a `fill` attribute cannot read): one shared object per color, so a bar
 * re-rendered by a zoom patches no style.
 */
export function timelineStatusFill(status: string, retries?: number | null): { fill: string } {
  const color = timelineStatusColor(status, retries);
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
export function timelineRetriedAttemptStyle(status: string, retries?: number | null): RetriedAttemptStyle {
  const color = timelineStatusColor(status, retries);
  let style = retriedAttemptStyles.get(color);
  if (!style) {
    style = { fill: color, fillOpacity: 0.18, stroke: color, strokeWidth: 1.5 };
    retriedAttemptStyles.set(color, style);
  }
  return style;
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

/** What a stop at Piwi's pause bar was, by its reason: `Paused at a breakpoint`. */
export function pauseReasonText(reason: string | null | undefined): string {
  if (reason === 'step') return 'Paused after Step';
  if (reason === 'page-pause') return 'Paused at page.pause()';
  return 'Paused at a breakpoint';
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
