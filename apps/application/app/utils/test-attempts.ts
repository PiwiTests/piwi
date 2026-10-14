import type { TestCaseResult } from '~~/types/api';

/**
 * The identity every attempt of one test in a run shares: the persisted test
 * case and its browser project once known, else the streaming key (title,
 * location and browser), so live placeholder rows and finished attempt rows
 * group alike. A run stores one row per attempt.
 */
export function testAttemptKey(tc: Pick<TestCaseResult, 'testCaseId' | 'title' | 'location' | 'browser'>): string {
  const browser = tc.browser?.projectName ?? tc.browser?.browserName ?? '';
  return tc.testCaseId > 0 ? `c${tc.testCaseId}\x00${browser}` : `${tc.title}\x00${tc.location}\x00${browser}`;
}
