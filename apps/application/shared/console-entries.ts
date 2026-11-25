/**
 * The console entries of an execution (`test_runs_cases.console_logs`): the page's `warning`, `error` and `assert`
 * messages, and each exception the page threw and nothing caught, typed `pageerror`, its `location` the place it was
 * thrown.
 */

/** The `type` of an entry recording an uncaught page error (Playwright's `pageerror`). */
export const PAGE_ERROR_TYPE = 'pageerror';

/** Whether a console entry's `type` reports an error: a `console.error` message or an uncaught page error. */
export function isConsoleErrorType(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  const t = type.toLowerCase();
  return t === 'error' || t === PAGE_ERROR_TYPE;
}

/** Whether a console entry's `type` is an uncaught page error. */
export function isPageErrorType(type: unknown): boolean {
  return typeof type === 'string' && type.toLowerCase() === PAGE_ERROR_TYPE;
}
