/**
 * Stuck?: a running test attempt of a live run that has run far longer than the test usually takes. Its threshold is
 * the longer of `STUCK_FLOOR_MS` and `STUCK_FACTOR` times the test's longest duration among its last
 * `STUCK_HISTORY` passing executions on the same browser; a test with fewer than `STUCK_MIN_PASSING` of them is never
 * said to be stuck. The server checks the attempts of its live runs (`server/utils/stuck-tests.ts`), the demo its
 * simulated ones, both from the attempt's start, whoever watches.
 */

/** The least time an attempt runs before it may be said to be stuck, whatever its test usually takes. */
export const STUCK_FLOOR_MS = 2 * 60_000;
/** How many times its test's longest passing duration an attempt runs before it is said to be stuck. */
export const STUCK_FACTOR = 3;
/** How many of a test's last passing executions its longest duration reads. */
export const STUCK_HISTORY = 10;
/** How many passing executions a test needs before any attempt of it may be said to be stuck. */
export const STUCK_MIN_PASSING = 2;

/** What a running attempt said to be stuck carries to the run page and the notification. */
export interface StuckAttempt {
  /** How long the attempt had run when it was said to be stuck, in milliseconds. */
  elapsedMs: number;
  /** The test's longest duration among its last passing executions, in milliseconds. */
  usualMs: number;
}

/**
 * Whether an attempt that has run `elapsedMs` is stuck, from the durations of its test's last passing executions:
 * what it carries when it is, null when it is not or when they are too few to tell.
 */
export function stuckAttempt(elapsedMs: number, passingDurations: readonly number[]): StuckAttempt | null {
  const thresholdMs = stuckThresholdMs(passingDurations);
  if (thresholdMs === null || elapsedMs <= thresholdMs) return null;
  return { elapsedMs, usualMs: Math.max(...passingDurations.filter((ms) => Number.isFinite(ms) && ms >= 0)) };
}

/**
 * The run event that tells the run page a running test is stuck (`test-stuck`): the fields of its begin event the page
 * keys its row by, and what it carries.
 */
export function testStuckEventData(
  begin: { title?: unknown; location?: unknown; browser?: unknown; repeatEachIndex?: unknown },
  stuck: StuckAttempt,
): Record<string, unknown> {
  return {
    title: begin.title,
    location: begin.location ?? null,
    browser: begin.browser ?? null,
    repeatEachIndex: begin.repeatEachIndex ?? 0,
    ...stuck,
  };
}

/**
 * The time past which an attempt of a test is stuck, from the durations of its last passing executions; null when
 * there are too few of them to tell.
 */
export function stuckThresholdMs(passingDurations: readonly number[]): number | null {
  const durations = passingDurations.filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (durations.length < STUCK_MIN_PASSING) return null;
  return Math.max(STUCK_FLOOR_MS, STUCK_FACTOR * Math.max(...durations));
}
