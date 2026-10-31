/**
 * Small, deterministic relative-time and duration wording shared by every
 * surface that writes one in plain words or as a clock (the situation lines,
 * the cluster-state sentence, notifications, the pull-request comment). Pure:
 * no locale, no Nuxt, no date library, so two callers phrase "1 day ago" and
 * "2 days" the same way.
 */

/** Coerce a stored timestamp (epoch ms number, Date, or ISO string) to epoch ms. */
export function toEpochMs(value: number | string | Date | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * A span in words, one dominant unit: `2 days`, `9 hours`, `6 minutes`,
 * `30 seconds`. Never zero — a sub-second span reads as `1 second`.
 */
export function durationApprox(ms: number): string {
  const clamped = Math.max(0, ms);
  const days = Math.floor(clamped / 86_400_000);
  if (days >= 1) return plural(days, 'day');
  const hours = Math.floor(clamped / 3_600_000);
  if (hours >= 1) return plural(hours, 'hour');
  const minutes = Math.floor(clamped / 60_000);
  if (minutes >= 1) return plural(minutes, 'minute');
  const seconds = Math.floor(clamped / 1000);
  return plural(Math.max(1, seconds), 'second');
}

/**
 * `1 day ago`, `9 hours ago`, or null when the timestamp is missing. Anything
 * under a second reads as `just now`.
 */
export function relativeTimeAgo(
  from: number | string | Date | null | undefined,
  now: Date = new Date(),
): string | null {
  const then = toEpochMs(from);
  if (then == null) return null;
  const diff = now.getTime() - then;
  if (diff < 1000) return 'just now';
  return `${durationApprox(diff)} ago`;
}

/** A run's or a test's duration as a clock reads it: `850ms`, `12.4s`, `8m 32s`. */
export function durationShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const tenths = Math.round(ms / 100) / 10;
  if (tenths < 60) return `${tenths.toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
