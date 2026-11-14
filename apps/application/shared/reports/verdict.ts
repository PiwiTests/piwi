/**
 * The rule-based verdict of a quality report: a tone from the numbers, never
 * from a model. The sentence that says it comes from the templates of the
 * report language (`sentences.en.ts`, `sentences.fr.ts`), so a verdict can
 * only ever repeat numbers it was given.
 */
import { PASS_RATE_FAIR, PASS_RATE_GOOD } from '#shared/status-colors';
import type { VerdictFacts, VerdictTone } from '#shared/analytics/types';

/** A pass-rate change smaller than this, in points, reads as steady. */
export const STEADY_POINTS = 0.5;
/** A drop of this many points or more is bad whatever the level. */
export const SHARP_DROP_POINTS = 5;

/**
 * - **bad**: the pass rate is poor (below the fair threshold), or it dropped
 *   sharply against the comparison period;
 * - **good**: the pass rate is good and did not drop by more than a point, and
 *   failure clusters are not piling up (no more opened than fixed while some are open);
 * - **mixed**: everything else, and a period with no runs.
 */
export function verdictTone(facts: VerdictFacts): VerdictTone {
  if (facts.runs === 0 || facts.passRate === null) return 'mixed';
  const delta = facts.passRateDelta;
  if (facts.passRate < PASS_RATE_FAIR || (delta !== null && delta <= -SHARP_DROP_POINTS)) return 'bad';
  const piling = facts.open > 0 && facts.opened > facts.fixed;
  if (facts.passRate >= PASS_RATE_GOOD && (delta === null || delta > -1) && !piling) return 'good';
  return 'mixed';
}

/** Which way the pass rate moved: `up`, `down` or `steady` (also when there is nothing to compare with). */
export function passRateDirection(facts: VerdictFacts): 'up' | 'down' | 'steady' {
  const delta = facts.passRateDelta;
  if (delta === null || Math.abs(delta) < STEADY_POINTS) return 'steady';
  return delta > 0 ? 'up' : 'down';
}
