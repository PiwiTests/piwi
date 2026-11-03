import type { TestCaseResult } from '~~/types/api';
import type { RetryCase, RetryMode } from '~/utils/retry-command';
import { buildRetryCommand, retryCaseOf } from '~/utils/retry-command';
import { isFlakyExecution } from '#shared/utils/test-counts';

/**
 * The run page's retry command, derived once from the run's execution rows so
 * every "Copy retry command" button on the page copies the same command for the
 * same failing set. The mode is page-level state shared by all callers.
 *
 * Each set holds one case per test and Playwright project, judged on the final
 * attempt (highest retry index) of each of its `--repeat-each` repetitions: the
 * failing set takes the tests with a repetition that failed or timed out, the
 * rows the Tests list selects, so a test that passed on retry is never re-run; the
 * flaky set the ones that passed after an earlier attempt failed (`isFlakyExecution`); the
 * whole set every test that was not skipped. File, line and project come from the row
 * itself, which makes the command exact.
 */
export function useRunRetryCommand(testCases: MaybeRefOrGetter<TestCaseResult[] | null | undefined>) {
  const mode = useState<RetryMode>('run-retry-mode', () => 'file-line');

  const testKeyOf = (tc: TestCaseResult) =>
    `${tc.testCaseId ?? tc.location ?? tc.title}|${(tc.browser as { projectName?: string } | null)?.projectName ?? ''}`;

  const finalAttempts = computed<TestCaseResult[]>(() => {
    const finalAttempt = new Map<string, TestCaseResult>();
    for (const tc of toValue(testCases) ?? []) {
      const key = `${testKeyOf(tc)}|${tc.repeatEachIndex ?? 0}`;
      const prev = finalAttempt.get(key);
      if (!prev || (tc.retries ?? 0) > (prev.retries ?? 0)) finalAttempt.set(key, tc);
    }
    return [...finalAttempt.values()];
  });

  /** One case per test and project among the final attempts `keep` selects, whichever repetition it came from. */
  const casesWhere = (keep: (tc: TestCaseResult) => boolean): RetryCase[] => {
    const cases = new Map<string, RetryCase>();
    for (const tc of finalAttempts.value) if (keep(tc)) cases.set(testKeyOf(tc), retryCaseOf(tc));
    return [...cases.values()];
  };

  const failedCases = computed<RetryCase[]>(() => casesWhere((tc) => isFailedStatus(tc.status)));
  const flakyCases = computed<RetryCase[]>(() => casesWhere(isFlakyExecution));
  const allCases = computed<RetryCase[]>(() =>
    casesWhere((tc) => !['skipped', 'fixme'].includes(statusPaletteKey(tc.status))),
  );

  const command = computed(() => buildRetryCommand(failedCases.value, { mode: mode.value }));

  const { copy, copied } = useCopy();
  function copyCommand() {
    if (command.value) copy(command.value, { toast: 'Retry command copied' });
  }

  const title = computed(() => (copied.value ? 'Copied!' : copyPreview(command.value)));

  return { mode, failedCases, flakyCases, allCases, command, copyCommand, copied, title };
}
