/**
 * The Copy retry command choices a browser remembers: how the tests are named
 * and the run options. The Playwright project is not among them: it belongs to
 * the run on the page.
 */
import { RETRY_OPTION_LIMITS, type RetryMode, type RetryTraceMode } from '#shared/retry-command';

export interface RetryPrefs {
  mode: RetryMode;
  headed: boolean;
  trace: RetryTraceMode | null;
  repeatEach: number;
  /** Null keeps the config's. */
  workers: number | null;
}

export const DEFAULT_RETRY_PREFS: RetryPrefs = {
  mode: 'file-line',
  headed: false,
  trace: null,
  repeatEach: 1,
  workers: null,
};

export const RETRY_PREFS_COOKIE = 'piwi-retry-options';

const MODES: readonly RetryMode[] = ['file-line', 'grep', 'file'];
const TRACES: readonly RetryTraceMode[] = ['on', 'retain-on-failure'];

function inRange(value: unknown, limits: { min: number; max: number }): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= limits.min && value <= limits.max;
}

/** The remembered choices from a cookie's value; anything missing or out of bounds reads as its default. */
export function parseRetryPrefs(raw: unknown): RetryPrefs {
  let value: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object') value = raw as Record<string, unknown>;
  else if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') value = parsed as Record<string, unknown>;
    } catch {
      value = null;
    }
  }
  if (!value) return { ...DEFAULT_RETRY_PREFS };
  return {
    mode: MODES.includes(value.mode as RetryMode) ? (value.mode as RetryMode) : DEFAULT_RETRY_PREFS.mode,
    headed: value.headed === true,
    trace: TRACES.includes(value.trace as RetryTraceMode) ? (value.trace as RetryTraceMode) : null,
    repeatEach: inRange(value.repeatEach, RETRY_OPTION_LIMITS.repeatEach) ? value.repeatEach : 1,
    workers: inRange(value.workers, RETRY_OPTION_LIMITS.workers) ? value.workers : null,
  };
}

/**
 * Popover content options for a menu whose trigger also copies: the copy's fallback, without clipboard permission or
 * over plain HTTP, selects a hidden textarea, and focus leaving the menu must not close it. A click outside and
 * Escape still do.
 */
export const KEEP_OPEN_ON_FOCUS_OUT = { onFocusOutside: (event: Event) => event.preventDefault() };
