import { stripAnsi } from '#shared/error-fingerprint';

/** Where the run page keeps, per browser, whether the errors outside the tests are folded to one line. */
export const RUN_ERRORS_COLLAPSED_KEY = 'piwi-run-errors-collapsed';

/**
 * The one line the run page shows for its errors outside the tests while they are folded: the first line of the first
 * error's message with its colour codes taken out, as Playwright printed it (`Error: ENOSPC: no space left on device`).
 * A message that is only blank lines leaves nothing, and the title alone shows. The stack and the other errors are read
 * by unfolding the block.
 */
export function runErrorHeadline(errors: readonly { message: string }[]): string {
  const message = errors[0]?.message;
  if (!message) return '';
  for (const line of stripAnsi(message).split('\n')) {
    const text = line.trim();
    if (text) return text;
  }
  return '';
}
