import { pausedOverlap, type PauseSpan } from '@piwitests/core/step-analysis';
import { hasSlowMark } from '#shared/analytics/timeout-hygiene';

interface PerformanceHint {
  type: 'warning' | 'info';
  message: string;
  details: string;
}

interface TestCaseData {
  duration?: number | null;
  retries?: number | null;
  status?: string;
  steps?: Array<{ title: string; duration: number; category: string; startTime?: number | null }> | null;
  /** The test's stops at Piwi's pause bar, in epoch ms: a step's time stopped is left out of its hint. */
  pauses?: PauseSpan[] | null;
  slowestStep?: string | null;
  slowestStepDuration?: number | null;
  /** Effective per-test timeout in ms (`TestCase.timeout`); `0`/null = unbounded/unknown. */
  timeout?: number | null;
  testAnnotations?: Array<{ type?: string; description?: string }> | null;
}

/** `"Navigate" took 3.5s`, and the time it stood paused at a breakpoint beside it. */
function tookText(step: { title: string; own: number; paused: number }): string {
  const paused = step.paused > 0 ? `, not counting ${(step.paused / 1000).toFixed(1)}s paused at a breakpoint` : '';
  return `"${step.title}" took ${(step.own / 1000).toFixed(1)}s${paused}`;
}

/**
 * Generate performance hints based on test case data. A step's time is its own: the time the test stood paused at
 * Piwi's pause bar while it ran is left out.
 */
export function getPerformanceHints(testCase: TestCaseData): PerformanceHint[] {
  const hints: PerformanceHint[] = [];

  if (!testCase) return hints;

  const pauses = testCase.pauses ?? [];
  const steps = (testCase.steps || []).map((s) => {
    const paused = pauses.length ? pausedOverlap(s.startTime, s.duration, pauses) : 0;
    return { ...s, paused, own: s.duration - paused };
  });

  // Slow navigation hint
  const navigationSteps = steps.filter((s) => s.category === 'navigation');
  const slowNavigations = navigationSteps.filter((s) => s.own > 3000);
  if (slowNavigations.length > 0) {
    const slowest = slowNavigations.sort((a, b) => b.own - a.own)[0]!;
    hints.push({
      type: 'warning',
      message: 'Slow navigation detected',
      details: `${tookText(slowest)}. The tested page may have performance issues (slow server response, heavy JS bundles, etc.).`,
    });
  }

  // Many sequential actions
  if (steps.length > 20) {
    hints.push({
      type: 'info',
      message: 'Many sequential actions',
      details: `This test has ${steps.length} steps. Consider splitting it into smaller, focused tests for better isolation and faster feedback.`,
    });
  }

  // Unstable locator (flaky test)
  if (testCase.status === 'passed' && (testCase.retries || 0) > 0) {
    hints.push({
      type: 'warning',
      message: 'Flaky test — passed after retries',
      details: `This test needed ${testCase.retries} ${testCase.retries === 1 ? 'retry' : 'retries'} to pass. Consider reviewing locator strategies, adding explicit waits, or checking for race conditions.`,
    });
  }

  // Slow assertions
  const slowAssertions = steps.filter((s) => s.category === 'assertion' && s.own > 2000);
  if (slowAssertions.length > 0) {
    const slowest = slowAssertions.sort((a, b) => b.own - a.own)[0]!;
    hints.push({
      type: 'info',
      message: 'Slow assertions detected',
      details: `${tookText(slowest)}. The UI may be slow to render or the assertion timeout may need tuning.`,
    });
  }

  // Stale test.slow() — marked slow but finished quickly
  if (hasSlowMark(testCase.testAnnotations) && typeof testCase.duration === 'number' && testCase.duration < 10000) {
    hints.push({
      type: 'info',
      message: 'test.slow() may be unnecessary',
      details: `This run finished in ${(testCase.duration / 1000).toFixed(1)}s, yet the test is marked test.slow(), which triples its timeout budget. If it is consistently this fast, removing test.slow() lets a failure surface sooner.`,
    });
  }

  // Oversized per-test timeout — the budget dwarfs the real runtime
  if (
    typeof testCase.timeout === 'number' &&
    testCase.timeout > 0 &&
    typeof testCase.duration === 'number' &&
    testCase.duration > 0 &&
    testCase.timeout >= 4 * testCase.duration &&
    testCase.timeout - testCase.duration >= 30000
  ) {
    hints.push({
      type: 'info',
      message: 'Oversized timeout',
      details: `The timeout is ${(testCase.timeout / 1000).toFixed(0)}s but this run took ${(testCase.duration / 1000).toFixed(1)}s. A large timeout means a hang or failure waits far longer than necessary — consider lowering it toward the test's real duration.`,
    });
  }

  return hints;
}
