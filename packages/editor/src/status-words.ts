/**
 * A test's status in the dashboard's words (`formatStatusLabel` in `apps/application/app/utils/index.ts`): a timeout
 * reads `timed out`, `didnotrun` `didn't run` and `never-run` `never run`; any other status is its own word.
 * `apps/application/tests/unit/status-words-drift.test.ts` holds the two together.
 */
export function statusWords(status: string): string {
  if (status === 'timedOut' || status === 'timedout') return 'timed out';
  if (status === 'didnotrun') return "didn't run";
  if (status === 'never-run') return 'never run';
  return status;
}
