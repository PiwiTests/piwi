/**
 * Maps a test or run outcome to the `--color-status-*` tokens defined in
 * `assets/css/main.css`, so every bar, chart, history cell, legend and filter
 * dot paints the same outcome with the same color.
 */

/** The outcomes the palette colors. */
export type StatusPaletteKey =
  | 'passed'
  | 'failed'
  | 'flaky'
  | 'skipped'
  | 'fixme'
  | 'didnotrun'
  | 'running'
  | 'interrupted';

export interface StatusPaletteEntry {
  /** CSS color for SVG fills, chart legends and inline styles. */
  color: string;
  /** Background utility for bar segments, dots and history cells. */
  bg: string;
  /** Ring utility marking the selected segment of a bar. */
  ring: string;
  /** Left-border color utility for a list row's status edge, beside a width such as `border-l-2`. */
  edge: string;
  /** Text utility for a count in this outcome, readable on the page background. */
  text: string;
  /** Text utility for a count written on a `bg` segment. */
  onBg: string;
  /** Pressed filter chip: tinted background and matching text. */
  chip: string;
  /** A row in this outcome among neutral rows: a faint background its text stays readable on. */
  tint: string;
  /**
   * A running attempt the Stuck? rule marks (`isStuckAttempt`): the warning tone of its **Stuck?** badge, as a CSS
   * color, the SVG fill utility of a label written on a bar in it, and the text utility of a count of them, readable
   * on the page background. Running only.
   */
  stuck?: { color: string; labelFill: string; text: string };
}

export const STATUS_PALETTE: Record<StatusPaletteKey, StatusPaletteEntry> = {
  passed: {
    color: 'var(--color-status-passed)',
    bg: 'bg-status-passed',
    ring: 'ring-status-passed',
    edge: 'border-l-status-passed',
    text: 'text-emerald-700 dark:text-emerald-400',
    onBg: 'text-white',
    chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    tint: 'bg-emerald-50 dark:bg-emerald-950/30',
  },
  failed: {
    color: 'var(--color-status-failed)',
    bg: 'bg-status-failed',
    ring: 'ring-status-failed',
    edge: 'border-l-status-failed',
    text: 'text-rose-700 dark:text-rose-400',
    onBg: 'text-white',
    chip: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
    tint: 'bg-rose-50 dark:bg-rose-950/30',
  },
  flaky: {
    color: 'var(--color-status-flaky)',
    bg: 'bg-status-flaky',
    ring: 'ring-status-flaky',
    edge: 'border-l-status-flaky',
    text: 'text-fuchsia-700 dark:text-fuchsia-400',
    onBg: 'text-white',
    chip: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-400',
    tint: 'bg-fuchsia-50 dark:bg-fuchsia-950/30',
  },
  skipped: {
    color: 'var(--color-status-skipped)',
    bg: 'bg-status-skipped',
    ring: 'ring-status-skipped',
    edge: 'border-l-status-skipped',
    text: 'text-zinc-500 dark:text-zinc-400',
    onBg: 'text-white',
    chip: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300',
    tint: 'bg-zinc-50 dark:bg-zinc-800/40',
  },
  // A `test.fixme()` skip: a second grey, stronger than a plain skip, since the
  // test is known broken rather than deliberately out of scope.
  fixme: {
    color: 'var(--color-status-fixme)',
    bg: 'bg-status-fixme',
    ring: 'ring-status-fixme',
    edge: 'border-l-status-fixme',
    text: 'text-zinc-700 dark:text-zinc-300',
    onBg: 'text-white dark:text-zinc-900 dark:text-shadow-none',
    chip: 'bg-zinc-300 text-zinc-800 dark:bg-zinc-600 dark:text-zinc-100',
    tint: 'bg-zinc-100 dark:bg-zinc-800/60',
  },
  didnotrun: {
    color: 'var(--color-status-didnotrun)',
    bg: 'bg-status-didnotrun',
    ring: 'ring-status-didnotrun',
    edge: 'border-l-status-didnotrun',
    text: 'text-amber-700 dark:text-amber-400',
    onBg: 'text-white',
    chip: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    tint: 'bg-amber-50 dark:bg-amber-950/30',
  },
  running: {
    color: 'var(--color-status-running)',
    bg: 'bg-status-running',
    ring: 'ring-status-running',
    edge: 'border-l-status-running',
    text: 'text-blue-700 dark:text-blue-400',
    onBg: 'text-white',
    chip: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    tint: 'bg-blue-50 dark:bg-blue-950/30',
    stuck: {
      color: 'var(--ui-warning)',
      labelFill: 'fill-amber-950',
      text: 'text-warning-700 dark:text-warning-400',
    },
  },
  // A test or run cut short (Ctrl+C, a crashed worker): no outcome, so a
  // neutral slate, apart from the skipped greys.
  interrupted: {
    color: 'var(--color-status-interrupted)',
    bg: 'bg-status-interrupted',
    ring: 'ring-status-interrupted',
    edge: 'border-l-status-interrupted',
    text: 'text-slate-600 dark:text-slate-400',
    onBg: 'text-white',
    chip: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
    tint: 'bg-slate-50 dark:bg-slate-800/40',
  },
};

/**
 * Palette key for a raw test or run status. Timed-out counts as failed (the run
 * counters fold it the same way); interrupted is an outcome of none, in its
 * neutral entry, as the counters leave it out of every bucket; an unknown or
 * cancelled status reads as neutral, like skipped. Pass an execution's verdict
 * (`flaky`: it passed after an earlier attempt failed or timed out, its stored
 * `passedAfterFailure` or `isFlakyExecution`) to color it as flaky, the way the
 * run counters count it.
 */
export function statusPaletteKey(status: string | null | undefined, flaky?: boolean | null): StatusPaletteKey {
  switch (status) {
    case 'passed':
      return flaky ? 'flaky' : 'passed';
    case 'failed':
    case 'timedout':
    case 'timedOut':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    case 'flaky':
      return 'flaky';
    case 'fixme':
      return 'fixme';
    case 'didnotrun':
      return 'didnotrun';
    case 'running':
    case 'initializing':
    case 'finalizing':
      return 'running';
    default:
      return 'skipped';
  }
}

/** Palette entry for a raw test or run status (see `statusPaletteKey`). */
export function statusPalette(status: string | null | undefined, flaky?: boolean | null): StatusPaletteEntry {
  return STATUS_PALETTE[statusPaletteKey(status, flaky)];
}
