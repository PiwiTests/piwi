/**
 * Retry-command helpers live in `#shared/retry-command` so the server can build
 * the fix plan's verify command with the same builder the UI uses. Re-exported
 * here for the app's `~/utils/retry-command` imports, with the conversion of a
 * run's execution row into the case a re-run names.
 */
import type { TestCaseResult } from '~~/types/api';
import type { RetryCase } from '#shared/retry-command';

export { buildRetryCommand, escapeGrep, toPosixPath } from '#shared/retry-command';
export type { RetryMode, RetryCase } from '#shared/retry-command';

/** An execution row of a run as the case a re-run names: its file, line, title and Playwright project. */
export function retryCaseOf(tc: TestCaseResult): RetryCase {
  return {
    filePath: (tc.filePath || tc.location?.split(':')[0]) ?? '',
    title: tc.title,
    line: tc.location ? parseInt(tc.location.split(':')[1] ?? '', 10) || null : null,
    projectName: (tc.browser as { projectName?: string } | null)?.projectName || null,
  };
}
