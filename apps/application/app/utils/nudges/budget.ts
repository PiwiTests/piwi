/**
 * How rare nudges stay in one browser: at most {@link NUDGE_BUDGET} shown in
 * any {@link NUDGE_BUDGET_WINDOW_MS}, counted from the times one was shown,
 * which the browser keeps under `localStorage['piwi-nudges']`. A page view
 * shows one nudge at most, and asks the budget once.
 */

/** The most nudges a browser shows in one window. */
export const NUDGE_BUDGET = 3;

/** The window the budget counts over: seven days. */
export const NUDGE_BUDGET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The `localStorage` key holding the times nudges were shown. */
export const NUDGE_SHOWS_KEY = 'piwi-nudges';

/** The stored times nudges were shown; anything unreadable counts as none. */
export function parseNudgeShows(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { shown?: unknown };
    return Array.isArray(parsed.shown) ? parsed.shown.filter((t): t is number => Number.isFinite(t)) : [];
  } catch {
    return [];
  }
}

/** The shows still inside the window ending at `now`. */
export function recentNudgeShows(shown: readonly number[], now: number): number[] {
  return shown.filter((t) => t <= now && now - t < NUDGE_BUDGET_WINDOW_MS);
}

/**
 * Asks the budget for one more nudge at `now`: the shows to store, with this
 * one added, when the window has room, else null.
 */
export function takeNudgeBudget(shown: readonly number[], now: number): number[] | null {
  const recent = recentNudgeShows(shown, now);
  return recent.length < NUDGE_BUDGET ? [...recent, now] : null;
}
