import { stripAnsi } from '#shared/error-fingerprint';
import { workerNumber } from '#shared/worker-lane';
import type { WireRunError } from '#shared/types';

/** The cookie that keeps, per browser, whether the run page's errors outside the tests are folded to one line. */
export const RUN_ERRORS_COLLAPSED_COOKIE = 'piwi-run-errors-collapsed';

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

/**
 * The worker an error outside the tests came from, as the run page names it (`Worker 2 · Shard 3 · Playwright project
 * webkit`): its lane from 1, then its shard in a sharded run and its Playwright project. Empty for an error of no
 * worker, or from a reporter that names none.
 */
export function runErrorWorker(
  error: Pick<WireRunError, 'parallelIndex' | 'shardIndex' | 'playwrightProject'>,
): string {
  const worker = workerNumber(error.parallelIndex);
  if (worker === null) return '';
  const parts = [`Worker ${worker}`];
  if (error.shardIndex != null) parts.push(`Shard ${error.shardIndex}`);
  if (error.playwrightProject) parts.push(`Playwright project ${error.playwrightProject}`);
  return parts.join(' · ');
}
