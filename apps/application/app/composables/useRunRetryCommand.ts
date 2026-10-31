import type { TestCaseResult } from '~~/types/api';
import type { RetryCase, RetryMode } from '~/utils/retry-command';
import { buildRetryCommand, retryCaseOf } from '~/utils/retry-command';

/**
 * The run page's retry command, derived once from the run's execution rows so
 * every "Copy retry command" button on the page copies the same command for the
 * same failing set. The mode is page-level state shared by all callers.
 *
 * Each set is one row per test and Playwright project, its final attempt
 * (highest retry index): the failing set takes the ones that failed or timed
 * out, the rows the Tests list selects, so a test that passed on retry is never re-run; the
 * flaky set the ones that passed on a retry; the whole set every test that was
 * not skipped. File, line and project come from the row itself, which makes the
 * command exact.
 */
export function useRunRetryCommand(testCases: MaybeRefOrGetter<TestCaseResult[] | null | undefined>) {
  const mode = useState<RetryMode>('run-retry-mode', () => 'file-line');

  const finalAttempts = computed<TestCaseResult[]>(() => {
    const finalAttempt = new Map<string, TestCaseResult>();
    for (const tc of toValue(testCases) ?? []) {
      const projectName = (tc.browser as { projectName?: string } | null)?.projectName ?? '';
      const key = `${tc.testCaseId ?? tc.location ?? tc.title}|${projectName}`;
      const prev = finalAttempt.get(key);
      if (!prev || (tc.retries ?? 0) > (prev.retries ?? 0)) finalAttempt.set(key, tc);
    }
    return [...finalAttempt.values()];
  });

  const failedCases = computed<RetryCase[]>(() =>
    finalAttempts.value.filter((tc) => isFailedStatus(tc.status)).map(retryCaseOf),
  );
  const flakyCases = computed<RetryCase[]>(() =>
    finalAttempts.value.filter((tc) => statusPaletteKey(tc.status, tc.retries) === 'flaky').map(retryCaseOf),
  );
  const allCases = computed<RetryCase[]>(() =>
    finalAttempts.value
      .filter((tc) => !['skipped', 'fixme'].includes(statusPaletteKey(tc.status, tc.retries)))
      .map(retryCaseOf),
  );

  const command = computed(() => buildRetryCommand(failedCases.value, { mode: mode.value }));

  const { copy, copied } = useCopy();
  function copyCommand() {
    if (command.value) copy(command.value, { toast: 'Retry command copied' });
  }

  const title = computed(() => (copied.value ? 'Copied!' : copyPreview(command.value)));

  return { mode, failedCases, flakyCases, allCases, command, copyCommand, copied, title };
}
