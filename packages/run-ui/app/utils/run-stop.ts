/**
 * How a run's Stop goes: the first press asks the process to stop as Ctrl+C would, and the shell kills a process still
 * running `RUN_STOP_GRACE_MS` later (`STOP_GRACE` in the desktop crate's `interrupt.rs`). **Force stop**, which kills it
 * at once, takes no press for `RUN_FORCE_STOP_GUARD_MS` after the stop was asked, so a double-click on Stop never kills
 * the run before Playwright writes its report.
 */

/** How long the shell lets a stopped process wind down before it kills it. */
export const RUN_STOP_GRACE_MS = 10_000;

/** How long after a stop was asked Force stop takes no press. */
export const RUN_FORCE_STOP_GUARD_MS = 1_500;

/** The whole seconds left before the shell kills a process asked to stop at `since`, at `now`; 0 once it is due. */
export function runStopSecondsLeft(since: number, now: number): number {
  return Math.max(0, Math.ceil((since + RUN_STOP_GRACE_MS - now) / 1000));
}

/** Whether Force stop still takes no press at `now`, for a stop asked at `since`. */
export function runForceStopGuarded(since: number, now: number): boolean {
  return now - since < RUN_FORCE_STOP_GUARD_MS;
}
