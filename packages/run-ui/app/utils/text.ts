import { ENGLISH_RUN_UI_WORDS } from './run-ui-words';

/**
 * Extract a human-readable message from an unknown error, unwrapping the
 * `{ data: { message } }` / `{ message }` shapes that `$fetch` throws. Without
 * either, `fallback`: the catalog's English "Unknown error" unless the caller
 * gives one in its own words.
 */
export function errorMessage(err: unknown, fallback = ENGLISH_RUN_UI_WORDS.t('runui_commonUnknownError')): string {
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
