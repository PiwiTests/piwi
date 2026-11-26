/**
 * The console entries of an execution (`test_runs_cases.console_logs`): the page's `warning`, `error` and `assert`
 * messages, and each exception the page threw and nothing caught, typed `pageerror`, its `location` the place it was
 * thrown.
 *
 * A `location` is stored as `url:line:column`, both 0-based as Playwright places a console message, none for a message
 * with an empty URL. The console card and the MCP tools show it 1-based, as an editor counts them, through
 * `shownConsoleLocation`; the REST API and the JSON export hand the stored entries as they are, 0-based.
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

/**
 * A stored console or page-error location as an editor counts it: `cart.js:1:8` stored reads `cart.js:2:9`, and one
 * with an empty URL (an inline script's) `:1:8` reads `:2:9`. A location at `0:0`, which Playwright gives a message
 * with no place in its resource (a resource that failed to load), reads as its URL alone, empty for an empty URL; one
 * without a line and a column reads as it is.
 */
export function shownConsoleLocation(location: string): string {
  const match = /^(.*):(\d+):(\d+)$/.exec(location);
  if (!match) return location;
  const [, url, line, column] = match;
  if (line === '0' && column === '0') return url!;
  return `${url}:${Number(line) + 1}:${Number(column) + 1}`;
}

/** Stored console entries with each string `location` read through `shownConsoleLocation`; anything else as it is. */
export function withShownConsoleLocations(entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries;
  return entries.map((entry) =>
    entry && typeof entry === 'object' && typeof (entry as { location?: unknown }).location === 'string'
      ? { ...entry, location: shownConsoleLocation((entry as { location: string }).location) || null }
      : entry,
  );
}
