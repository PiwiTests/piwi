/**
 * The literal colors of test outcomes and the pass-rate scale, for everything
 * drawn outside the Vue app: quality reports, offline exports, emails, PDFs.
 *
 * The dashboard paints through the `--color-status-*` tokens of
 * `app/assets/css/main.css`; `app/utils/status-palette.ts` and
 * `app/utils/pass-rate.ts` add the Tailwind utilities on top and read the
 * thresholds and steps from here. `tests/unit/status-colors.test.ts` pins the
 * tokens to the `token` names below, so a document, an email and the page
 * cannot paint one outcome three ways.
 */

export type StatusColorKey = 'passed' | 'failed' | 'flaky' | 'skipped' | 'fixme' | 'didnotrun' | 'running';

export interface StatusColor {
  /** Tailwind palette entry the `--color-status-*` token points at. */
  token: string;
  /** The mark color (bars, lines, dots): the token's own shade. */
  fill: string;
  /** Text on a light background (a count, a status word). */
  text: string;
  /** Text on a dark background. */
  textDark: string;
  /** Text in print, a shade darker for paper. */
  print: string;
}

export const STATUS_COLORS: Record<StatusColorKey, StatusColor> = {
  passed: { token: 'emerald-500', fill: '#10b981', text: '#047857', textDark: '#34d399', print: '#065f46' },
  failed: { token: 'rose-500', fill: '#f43f5e', text: '#be123c', textDark: '#fb7185', print: '#9f1239' },
  flaky: { token: 'fuchsia-500', fill: '#d946ef', text: '#a21caf', textDark: '#e879f9', print: '#86198f' },
  skipped: { token: 'zinc-400', fill: '#a1a1aa', text: '#71717a', textDark: '#a1a1aa', print: '#52525b' },
  fixme: { token: 'zinc-600', fill: '#52525b', text: '#3f3f46', textDark: '#d4d4d8', print: '#27272a' },
  didnotrun: { token: 'amber-500', fill: '#f59e0b', text: '#b45309', textDark: '#fbbf24', print: '#92400e' },
  running: { token: 'blue-500', fill: '#3b82f6', text: '#1d4ed8', textDark: '#60a5fa', print: '#1e40af' },
};

/** Lowest percentage that reads as good. */
export const PASS_RATE_GOOD = 90;
/** Lowest percentage that reads as fair; anything below is poor. */
export const PASS_RATE_FAIR = 50;

export type PassRateTone = 'good' | 'fair' | 'poor';

/** The three pass-rate bands: good and poor are the passed and failed colors, fair is amber. */
export const PASS_RATE_COLORS: Record<PassRateTone, StatusColor> = {
  good: STATUS_COLORS.passed,
  fair: { token: 'amber-500', fill: '#f59e0b', text: '#b45309', textDark: '#fbbf24', print: '#92400e' },
  poor: STATUS_COLORS.failed,
};

/** Band of a pass rate given as a percentage (0–100). */
export function passRateTone(percent: number): PassRateTone {
  if (percent >= PASS_RATE_GOOD) return 'good';
  if (percent >= PASS_RATE_FAIR) return 'fair';
  return 'poor';
}

export interface PassRateStepDef {
  /** Lowest percentage in the step. */
  min: number;
  tone: PassRateTone;
  /** Share of the band color in the fill, 0–100; the rest is transparent (or white on paper). */
  strength: number;
  /** Whether text printed on the fill is white. */
  strong: boolean;
}

/**
 * The five cell shades of the heatmap and the browser matrix, best first: each
 * band split in two so a perfect period and a near-failing one stand out.
 */
export const PASS_RATE_STEP_DEFS: readonly PassRateStepDef[] = [
  { min: 99.5, tone: 'good', strength: 85, strong: true },
  { min: PASS_RATE_GOOD, tone: 'good', strength: 45, strong: false },
  { min: 75, tone: 'fair', strength: 45, strong: false },
  { min: PASS_RATE_FAIR, tone: 'fair', strength: 75, strong: false },
  { min: -Infinity, tone: 'poor', strength: 75, strong: true },
];

/** The step a percentage (0–100) falls in. */
export function passRateStepDef(percent: number): PassRateStepDef {
  return PASS_RATE_STEP_DEFS.find((step) => percent >= step.min)!;
}

/** `#rrggbb` → `[r, g, b]` in 0–255. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}

/** A step's fill as a solid color over white, for documents that cannot blend. */
export function passRateStepHex(percent: number): string {
  const step = passRateStepDef(percent);
  const [r, g, b] = hexToRgb(PASS_RATE_COLORS[step.tone].fill);
  const mix = (c: number) => Math.round(255 + (c - 255) * (step.strength / 100));
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
