/**
 * Pass-rate bands: one threshold set and one color scale for every pass rate
 * the dashboard colors (percentages in tables and headers, gauges, heatmap
 * cells). The bands use the semantic colors of `app.config.ts` (success,
 * warning, error), so good and poor are the same emerald and rose as passed
 * and failed tests.
 */
import {
  PASS_RATE_FAIR as SHARED_PASS_RATE_FAIR,
  PASS_RATE_GOOD as SHARED_PASS_RATE_GOOD,
  PASS_RATE_STEP_DEFS,
  passRateTone as sharedPassRateTone,
  type PassRateTone as SharedPassRateTone,
} from '#shared/status-colors';
import { STATUS_PALETTE } from '@piwitests/run-ui/status-palette';

/** Lowest percentage that reads as good. */
export const PASS_RATE_GOOD = SHARED_PASS_RATE_GOOD;
/** Lowest percentage that reads as fair; anything below is poor. */
export const PASS_RATE_FAIR = SHARED_PASS_RATE_FAIR;

export type PassRateTone = SharedPassRateTone;

/** Band of a pass rate given as a percentage (0–100). */
export function passRateTone(percent: number): PassRateTone {
  return sharedPassRateTone(percent);
}

export interface PassRateToneEntry {
  /** Text utility for a percentage in this band. */
  text: string;
  /** Background utility for a gauge fill. */
  bg: string;
  /** CSS color for inline styles (heatmap cells, legends). */
  color: string;
}

export const PASS_RATE_TONES: Record<PassRateTone, PassRateToneEntry> = {
  good: { text: STATUS_PALETTE.passed.text, bg: STATUS_PALETTE.passed.bg, color: STATUS_PALETTE.passed.color },
  fair: { text: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-500', color: 'var(--color-amber-500)' },
  poor: { text: STATUS_PALETTE.failed.text, bg: STATUS_PALETTE.failed.bg, color: STATUS_PALETTE.failed.color },
};

/** Text utility for a percentage; muted when there is no rate. */
export function passRateTextClass(percent: number | null | undefined): string {
  return percent == null ? 'text-muted' : PASS_RATE_TONES[passRateTone(percent)].text;
}

export interface PassRateStep {
  /** Lowest percentage in the step. */
  min: number;
  tone: PassRateTone;
  /** Legend label. */
  label: string;
  /** Fill: the band color mixed with transparency. */
  color: string;
  /** Text utility for a value printed on the fill (white on the two strongest steps). */
  text: string;
}

function mix(tone: PassRateTone, strength: number): string {
  return `color-mix(in oklab, ${PASS_RATE_TONES[tone].color} ${strength}%, transparent)`;
}

/**
 * The five cell shades of the heatmap and the browser matrix, best first: each
 * band split in two so a perfect period and a near-failing one stand out. The
 * band edges are `PASS_RATE_GOOD` and `PASS_RATE_FAIR`; the steps themselves live in
 * `shared/status-colors.ts`, which documents and emails read too.
 */
export const PASS_RATE_STEPS: readonly PassRateStep[] = PASS_RATE_STEP_DEFS.map((step, i) => ({
  min: step.min,
  tone: step.tone,
  label: i === 0 ? '100%' : step.min === -Infinity ? `< ${PASS_RATE_FAIR}%` : `≥ ${step.min}%`,
  color: mix(step.tone, step.strength),
  text: step.strong ? 'text-white' : '',
}));

/** Cell shade for a percentage (0–100). */
export function passRateStep(percent: number): PassRateStep {
  return PASS_RATE_STEPS.find((step) => percent >= step.min)!;
}
