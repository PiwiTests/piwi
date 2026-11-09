import { isPiwiAnnotation, TEST_PRIORITIES, type TestMetadata } from '@piwitests/core/test-meta';
import { isExpectedFailurePassed } from '@piwitests/core/status-classify';
import { isFlakyExecution } from '#shared/utils/test-counts';
import type { TestCaseResult } from '~~/types/api';

/**
 * One badge on a test row. `BadgeGroup` shows the first three and folds the
 * rest into a `+N` popover, so the order here is the priority order: exceptional
 * badges (a red run's signals) come before tags and ownership metadata.
 */
export interface TestRowBadge {
  key: string;
  label: string;
  color: 'error' | 'warning' | 'info' | 'success' | 'neutral' | 'primary' | 'flaky';
  variant: 'solid' | 'subtle' | 'soft' | 'outline';
  icon?: string;
  title?: string;
  /** Render monospaced — Playwright marks (`@fixme`) and tags. */
  mono?: boolean;
}

const PRIORITY_COLOR: Record<(typeof TEST_PRIORITIES)[number], TestRowBadge['color']> = {
  critical: 'error',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};

function markColor(type: string): TestRowBadge['color'] {
  if (type === 'fixme' || type === 'slow') return 'warning';
  if (type === 'fail') return 'error';
  if (type === 'skip') return 'neutral';
  return 'info';
}

function markIcon(type: string): string | undefined {
  switch (type) {
    case 'fixme':
      return 'i-lucide-wrench';
    case 'skip':
      return 'i-lucide-skip-forward';
    case 'slow':
      return 'i-lucide-timer';
    case 'fail':
      return 'i-lucide-x-circle';
    default:
      return undefined;
  }
}

/** Inputs for a test row's badge list, drawn from one execution. */
export interface TestRowBadgeInput {
  /** This running attempt has run far longer than its test usually does (`#shared/stuck-tests`). */
  stuck?: boolean | null;
  isNewRegression?: boolean | null;
  isNewFlaky?: boolean | null;
  /** This execution failed at least once in the run and then passed. */
  passedOnRetry?: boolean | null;
  /** This test is currently quarantined. */
  quarantined?: boolean | null;
  /** A `test.fail()` test that passed: the bug it reproduces looks fixed. */
  looksFixed?: boolean | null;
  annotations?: Array<{ type: string; description?: string }> | null;
  tags?: string[] | null;
  /** Lock names this test held — a shared resource the runner serializes holders of. */
  locks?: string[] | null;
  meta?: TestMetadata | null;
}

/**
 * The ordered badge list for a test row: the exceptional signals first (new
 * regression, newly flaky, passed on retry, Playwright marks, quarantined),
 * then priority, tags, owner and feature. The row caps the visible count; this
 * only decides what and in which order.
 */
export function buildTestRowBadges(input: TestRowBadgeInput): TestRowBadge[] {
  const badges: TestRowBadge[] = [];

  if (input.stuck) {
    badges.push({
      key: 'stuck',
      label: 'Stuck?',
      color: 'warning',
      variant: 'subtle',
      icon: 'i-lucide-hourglass',
      title: 'Running far longer than its last passing runs took: open its live view, or its step, to see why',
    });
  }
  if (input.looksFixed) {
    badges.push({
      key: 'looks-fixed',
      label: 'Looks fixed',
      color: 'success',
      variant: 'subtle',
      icon: 'i-lucide-bug-off',
      title: 'Marked test.fail() and passed: remove test.fail() with the fix',
    });
  }
  if (input.isNewRegression) {
    badges.push({
      key: 'new-regression',
      label: 'New regression',
      color: 'error',
      variant: 'solid',
      icon: 'i-lucide-flame',
      title: 'Failing here, passing in the baseline run',
    });
  }
  if (input.isNewFlaky) {
    badges.push({
      key: 'newly-flaky',
      label: 'Newly flaky',
      color: 'flaky',
      variant: 'solid',
      icon: 'i-lucide-shuffle',
      title: 'First run in which this test was flaky',
    });
  }
  if (input.passedOnRetry) {
    badges.push({
      key: 'passed-on-retry',
      label: 'Passed on retry',
      color: 'flaky',
      variant: 'subtle',
      icon: 'i-lucide-rotate-cw',
      title: 'Failed at least once in this run, then passed',
    });
  }

  for (const ann of input.annotations ?? []) {
    if (isPiwiAnnotation(ann.type)) continue;
    const label = ann.type === 'tag' ? (ann.description ?? ann.type) : ann.type;
    badges.push({
      key: `mark:${ann.type}:${ann.description ?? ''}`,
      label,
      color: markColor(ann.type),
      variant: 'soft',
      icon: markIcon(ann.type),
      title: ann.type !== 'tag' ? (ann.description ?? undefined) : undefined,
      mono: true,
    });
  }

  if (input.quarantined) {
    badges.push({
      key: 'quarantined',
      label: 'Quarantined',
      color: 'warning',
      variant: 'subtle',
      icon: 'i-lucide-shield-alert',
      title: "Quarantined — still runs and reports, but excluded from the CI gate's verdict",
    });
  }

  const meta = input.meta;
  if (meta?.priority) {
    badges.push({
      key: 'priority',
      label: meta.priority,
      color: PRIORITY_COLOR[meta.priority] ?? 'neutral',
      variant: 'soft',
    });
  }
  for (const tag of input.tags ?? []) {
    badges.push({ key: `tag:${tag}`, label: `@${tag}`, color: 'primary', variant: 'soft', mono: true });
  }
  for (const lock of input.locks ?? []) {
    badges.push({
      key: `lock:${lock}`,
      label: lock,
      color: 'warning',
      variant: 'soft',
      icon: 'i-lucide-lock',
      title: `Lock: only one holder of "${lock}" runs at a time`,
    });
  }
  if (meta?.owner) {
    badges.push({
      key: 'owner',
      label: meta.owner,
      color: 'neutral',
      variant: 'soft',
      icon: 'i-lucide-user',
    });
  }
  if (meta?.feature) {
    badges.push({ key: 'feature', label: meta.feature, color: 'neutral', variant: 'outline' });
  }

  return badges;
}

/** Whether a badge is one of the exceptional signals (shown even when others hide). */
export function badgesFromTestCase(tc: TestCaseResult, opts?: { quarantined?: boolean }): TestRowBadge[] {
  return buildTestRowBadges({
    stuck: tc.status === 'running' && tc.stuck != null,
    looksFixed: isExpectedFailurePassed(tc.status, tc.expectedStatus),
    isNewRegression: tc.isNewRegression,
    isNewFlaky: tc.isNewFlaky,
    passedOnRetry: isFlakyExecution(tc),
    quarantined: opts?.quarantined,
    annotations: tc.testAnnotations,
    tags: tc.tags,
    locks: tc.locks,
    meta: tc.testMeta,
  });
}
