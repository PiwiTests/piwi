/**
 * Extract a human-readable message from an unknown error, unwrapping the
 * `{ data: { message } }` / `{ message }` shapes that `$fetch` throws.
 */
export function errorMessage(err: unknown, fallback = 'Unknown error'): string {
  if (err && typeof err === 'object') {
    const e = err as { data?: { message?: string }; message?: string };
    return e.data?.message ?? e.message ?? fallback;
  }
  return fallback;
}

/** One line of `text` for a tooltip: newlines become a middot, and a line past `max` characters is cut. */
export function copyPreview(text: string | null | undefined, max = 120): string {
  if (!text) return '';
  const singleLine = text.replace(/\n/g, ' · ');
  return singleLine.length <= max ? singleLine : singleLine.slice(0, max) + '…';
}
