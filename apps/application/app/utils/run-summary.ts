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
  const fixmePart = run.fixme > 0 ? ` (${run.fixme} fixme)` : '';
  return [
    `*Run #${run.id}*${label}`,
    `Status: ${statusEmoji} ${run.status} | Project: ${run.project}`,
    `Tests: ${run.total} total · ${run.passed} passed · ${run.failed} failed · ${run.skipped} skipped${fixmePart}${didNotRunPart}${interruptedPart}${flakyPart}`,
    `Duration: ${formatLongDuration(run.duration)}`,
  ].join('\n');
}
