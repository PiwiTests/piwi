import { formatLongDuration } from '~/utils';

/** What the run page's Copy run summary says about a run. */
export interface RunSummaryFacts {
  id: number;
  status: string;
  label?: string | null;
  project: string;
  duration?: number | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  fixme: number;
  /** Tests ended at a stop (End the test): a subset of `skipped`, named beside it. */
  endedAtStop?: number;
  flaky: number;
  didNotRun: number;
  /** Results the run's interruption cut short: in no outcome, named apart. */
  interrupted: number;
}

/** A run as plain text to paste in a chat: its outcome, its test counts and how long it took, in human units. */
export function runSummaryText(run: RunSummaryFacts): string {
  const statusEmoji =
    run.status === 'passed' ? '✅' : run.status === 'failed' ? '❌' : run.status === 'running' ? '🔄' : '⚠️';
  const label = run.label ? ` — ${run.label}` : '';
  const flakyPart = run.flaky > 0 ? ` · ${run.flaky} passed on retry` : '';
  const didNotRunPart = run.didNotRun > 0 ? ` · ${run.didNotRun} didn't run` : '';
  const interruptedPart = run.interrupted > 0 ? ` · ${run.interrupted} interrupted` : '';
  const skippedKinds = [
    run.fixme > 0 ? `${run.fixme} fixme` : '',
    run.endedAtStop ? `${run.endedAtStop} ended at a stop` : '',
  ].filter(Boolean);
  const skippedPart = skippedKinds.length ? ` (${skippedKinds.join(', ')})` : '';
  return [
    `*Run #${run.id}*${label}`,
    `Status: ${statusEmoji} ${run.status} | Project: ${run.project}`,
    `Tests: ${run.total} total · ${run.passed} passed · ${run.failed} failed · ${run.skipped} skipped${skippedPart}${didNotRunPart}${interruptedPart}${flakyPart}`,
    `Duration: ${formatLongDuration(run.duration)}`,
  ].join('\n');
}

/** How a run that ended came out, in one sentence: what the live view says as the run's end ends it. */
export function runVerdictText(run: { status: string; total: number; failed: number }): string {
  const tests = (n: number) => `${n} test${n === 1 ? '' : 's'}`;
  switch (run.status) {
    case 'passed':
      return `The run passed: ${tests(run.total)}.`;
    case 'failed':
      return run.failed > 0 ? `The run failed: ${run.failed} of ${tests(run.total)} failed.` : 'The run failed.';
    case 'timedout':
      return 'The run timed out.';
    case 'interrupted':
      return 'The run was interrupted.';
    case 'cancelled':
      return 'The run was cancelled.';
    default:
      return 'The run ended.';
  }
}
