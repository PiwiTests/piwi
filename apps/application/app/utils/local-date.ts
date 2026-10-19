/**
 * Dates picked in an `<input type="date">`, read in the viewer's own time zone:
 * `new Date('2026-10-19')` is UTC midnight, which is the evening before for a
 * viewer west of Greenwich and already past for one east of it.
 */

/** Today in the viewer's time zone, as an `<input type="date">` value (`YYYY-MM-DD`). */
export function localDateInputValue(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The last instant of a `YYYY-MM-DD` day in the viewer's time zone; null for any other text. */
export function endOfLocalDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isNaN(end.getTime()) ? null : end;
}
