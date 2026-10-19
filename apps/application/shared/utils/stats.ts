/**
 * The statistics the server handlers and the demo's in-browser API share, so
 * every screen computes a median or a percentile the same way.
 */

/** The median of a list: its middle value, or the mean of its two middle values for an even count; null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The p-th percentile (0–100) of an ascending-sorted list, by nearest rank: the
 * smallest value at least p% of the list is at or under. 0 for an empty list.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[idx] ?? 0;
}

/**
 * The p-th percentile (0–100) of an ascending-sorted list at the lower of the
 * ranks around p% of the way from its first value to its last, so the largest
 * value of a short list stays above its 95th percentile. 0 for an empty list.
 */
export function lowerPercentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor((p / 100) * (sortedAsc.length - 1)))]!;
}

/**
 * Compute the average and p90 of a list of durations (ms). Null/undefined
 * entries are ignored. Returns null when there are no valid durations.
 */
export function durationStats(durations: Array<number | null | undefined>): { avg: number; p90: number } | null {
  const valid = durations.filter((d): d is number => d !== null && d !== undefined);
  if (valid.length === 0) return null;
  const sum = valid.reduce((a, b) => a + b, 0);
  const sorted = [...valid].sort((a, b) => a - b);
  return { avg: Math.round(sum / valid.length), p90: percentile(sorted, 90) };
}
