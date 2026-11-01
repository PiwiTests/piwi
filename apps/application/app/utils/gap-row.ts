/**
 * A scenario gap as its row shows it, in the Coverage tab's Gaps view and on a
 * file's coverage page: the fields a row reads, the color of its class badge
 * and the line of factors behind its score.
 */
import type { GapCloseReason } from '#shared/gap-classes';

export interface GapFactors {
  churn: number;
  age: number;
  escapeHistory: number;
  priority: number;
}

/** What a gap row shows; a compact row needs only the identity, the class and the title. */
export interface GapRowItem {
  id: number;
  kind?: 'gap' | 'finding';
  detector: string;
  class: string;
  subject?: { kind: string; key: string };
  title: string;
  evidence?: string[];
  factors?: GapFactors | null;
  score: number | null;
  status?: string;
  closeReason?: GapCloseReason | null;
}

/** The badge color of each gap class. */
export const GAP_CLASS_COLOR: Record<string, string> = {
  'blind-spot': 'warning',
  'false-comfort': 'error',
  fragile: 'warning',
  unhandled: 'error',
  degraded: 'warning',
};

/**
 * The factors behind a gap's score. A finding ranks by its severity (its class)
 * times its route's reach, which its factors carry in `priority`, so it shows
 * the reach alone.
 */
export function gapFactorLine(gap: GapRowItem): string {
  const f = gap.factors;
  if (!f) return '';
  if (gap.kind === 'finding') return `reach ${f.priority.toFixed(1)}`;
  return `churn ${f.churn.toFixed(1)} · age ${f.age.toFixed(1)} · escape ${f.escapeHistory.toFixed(1)} · priority ${f.priority.toFixed(1)}`;
}
