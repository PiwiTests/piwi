import type { TestCaseResult } from '~~/types/api';

/**
 * The identity every attempt of one repetition of a test in a run shares: the
 * persisted test case, its browser project and its `--repeat-each` repetition
 * once known, else the streaming key (title, location, browser and repetition),
 * so live placeholder rows and finished attempt rows group alike. A run stores
 * one row per attempt, and each repetition is a test result of its own.
 */
export function testAttemptKey(
  tc: Pick<TestCaseResult, 'testCaseId' | 'title' | 'location' | 'browser' | 'repeatEachIndex'>,
): string {
  const browser = tc.browser?.projectName ?? tc.browser?.browserName ?? '';
  const repeat = tc.repeatEachIndex ?? 0;
  return tc.testCaseId > 0
    ? `c${tc.testCaseId}\x00${browser}\x00${repeat}`
    : `${tc.title}\x00${tc.location}\x00${browser}\x00${repeat}`;
}

/**
 * The key the live run page matches a streamed test's `test-begin` and
 * `test-completed` events on: its title, location, browser and repetition. A
 * test's retries share it, so a later attempt updates the row of the earlier one.
 */
export function liveCaseKey(tc: Pick<TestCaseResult, 'title' | 'location' | 'browser' | 'repeatEachIndex'>): string {
  return `${tc.title}@@${tc.location}@@${JSON.stringify(tc.browser)}@@${tc.repeatEachIndex ?? 0}`;
}
