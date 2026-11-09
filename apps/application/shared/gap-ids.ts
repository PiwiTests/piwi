/** The most gap ids one request names. */
export const MAX_GAP_IDS = 200;

/** A comma-separated list of gap ids from a query, checked: positive integers, at most {@link MAX_GAP_IDS}. */
export function parseGapIds(raw: unknown): number[] | { error: string } {
  const text = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '';
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const ids = parts.map(Number);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return { error: 'ids must be positive integers' };
  if (ids.length > MAX_GAP_IDS) return { error: `ids names at most ${MAX_GAP_IDS} gaps` };
  return [...new Set(ids)];
}
