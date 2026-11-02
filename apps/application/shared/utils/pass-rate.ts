/**
 * The pass rate, the one rule every pass rate the dashboard shows, stores or
 * exports follows: passed results over the results that passed or failed.
 *
 * - `failed` counts the failed and the timed-out results.
 * - A skipped, did-not-run or interrupted result is in neither term.
 * - A flaky result (passed on a retry) is passed.
 * - With no passed or failed result there is no rate: null, never 0 % or 100 %.
 *
 * `pass-rate-sql.ts` computes the same rule in a query.
 */

/** The two outcome counts a pass rate reads. `failed` holds the timed-out results too. */
export interface PassRateCounts {
  passed: number;
  failed: number;
}

function count(value: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The pass rate as a share from 0 to 1, or null with no passed or failed result. */
export function passRate(counts: PassRateCounts): number | null {
  const passed = count(counts.passed);
  const decided = passed + count(counts.failed);
  return decided > 0 ? passed / decided : null;
}

/** The pass rate as a percentage rounded to `decimals` places, or null with no passed or failed result. */
export function passRatePercent(counts: PassRateCounts, decimals = 0): number | null {
  const passed = count(counts.passed);
  const decided = passed + count(counts.failed);
  if (decided === 0) return null;
  const scale = 10 ** decimals;
  return Math.round((passed * 100 * scale) / decided) / scale;
}
