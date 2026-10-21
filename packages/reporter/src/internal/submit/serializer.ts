import type { FullResult } from '@playwright/test/reporter';
import type { CollectedTestCase, WireTestCase } from '../../types.js';
import type { RunPayload } from './uploader.js';

/**
 * Resolve the overall Piwi run status from Playwright's `FullResult.status`
 * and the accumulated per-case counters.
 *
 * `passed`/`failed`/`timedout`/`interrupted` map directly and are kept
 * distinct — the dashboard treats all non-`passed` statuses as failing where
 * it matters, but a timed-out run and an interrupted (cancelled/maxFailures)
 * run read differently in the run list and the analytics. When Playwright
 * doesn't report a status, the run is `passed` only when no test failed or
 * timed out (and at least one test ran).
 */
export function resolveOverallStatus(
  result: FullResult,
  counters: { failedTests: number; timedOutTests: number; totalTests: number },
): string {
  const STATUS_MAP: Record<string, string> = {
    passed: 'passed',
    failed: 'failed',
    timedout: 'timedout',
    interrupted: 'interrupted',
  };
  if (result?.status) return STATUS_MAP[result.status] ?? 'failed';
  if (counters.failedTests === 0 && counters.timedOutTests === 0 && counters.totalTests > 0) return 'passed';
  return 'failed';
}

/**
 * Project an internally-collected test-case object into the wire shape sent to
 * the server. Carries the `type` discriminant through so the same mapper works
 * for `begin` and `complete` stream events as well as batch submissions.
 *
 * Field defaults:
 * - `status`/`duration`/`error`/`retries` pass through unchanged (no `null`
 *   default), so a `begin` event yields `undefined` for those fields.
 * - Numeric/array fields use `|| null` (so `0` and `''` collapse to `null`),
 *   while `workerIndex`/`shardIndex`/`startedAt`/`suitePath`/`suiteConfig`/
 *   `testAnnotations`/`tags`/`testMeta` use `?? null` (so `0` survives). Note:
 *   an empty array is truthy, so `steps: []` is preserved as `[]`, not `null`.
 */
export function toWireTestCase(tc: CollectedTestCase): WireTestCase {
  const { type, ...rest } = tc as any;
  return {
    type,
    title: rest.title,
    location: rest.location,
    status: rest.status,
    duration: rest.duration,
    timeout: rest.timeout ?? null,
    error: rest.error,
    retries: rest.retries,
    attempts: rest.attempts || null,
    workerIndex: rest.workerIndex ?? null,
    shardIndex: rest.shardIndex ?? null,
    startedAt: rest.startedAt ?? null,
    steps: rest.performanceMetrics?.steps || null,
    stepEvents: rest.stepEvents || null,
    slowestStep: rest.performanceMetrics?.slowestStep?.title || null,
    slowestStepDuration: rest.performanceMetrics?.slowestStep?.duration || null,
    wastedTimeMs: rest.performanceMetrics?.waitTotalDuration ?? null,
    networkRequests: rest.networkRequests || null,
    webVitals: rest.webVitals || null,
    pageState: rest.pageState || null,
    pageInventory: rest.pageInventory || null,
    aiUsage: rest.aiUsage || null,
    consoleLogs: rest.consoleLogs || null,
    dialogs: rest.dialogs || null,
    ariaSnapshot: rest.ariaSnapshot || null,
    ariaSnapshotJson: rest.ariaSnapshotJson || null,
    testSource: rest.testSource || null,
    testSourceFrames: rest.testSourceFrames || null,
    browser: rest.browser || null,
    suitePath: rest.suitePath ?? null,
    suiteConfig: rest.suiteConfig ?? null,
    testAnnotations: rest.testAnnotations ?? null,
    tags: rest.tags ?? null,
    locks: rest.locks ?? null,
    testMeta: rest.testMeta ?? null,
    // Kept `undefined` when unset (a `begin` event): `null` would tell the dashboard the test has no ID.
    externalId: rest.externalId,
    displayTitle: rest.displayTitle ?? null,
    locatorSnapshots: rest.locatorSnapshots || null,
    locatorPages: rest.locatorPages || null,
    codeReach: rest.codeReach || null,
    coverage: rest.coverage || null,
    resources: rest.resources ?? null,
    didNotRunReason: rest.didNotRunReason ?? null,
    expectedStatus: rest.expectedStatus ?? null,
    blockedBy: rest.blockedBy ?? null,
  };
}

/** Distinct-test run counts (one entry per test, not per attempt). */
interface RunCounts {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  timedOutTests: number;
  skippedTests: number;
  didNotRunTests: number;
}

function browserProjectName(browser: unknown): string {
  if (
    browser &&
    typeof browser === 'object' &&
    typeof (browser as { projectName?: unknown }).projectName === 'string'
  ) {
    return (browser as { projectName: string }).projectName;
  }
  return '';
}

/** Whether an attempt's status counts against the test. */
function isFailingStatus(status: string): boolean {
  return status === 'failed' || status === 'timedOut' || status === 'timedout' || status === 'interrupted';
}

/**
 * Run counts computed from the collected cases as **distinct tests**: the final
 * attempt of each test (Playwright's `test.id`, or its title, location, describe
 * path and browser for a case collected without one) decides its outcome, so
 * retries never inflate the totals while a parameterized test or a
 * `--repeat-each` repetition counts once each (`total = passed + failed +
 * timedOut + skipped + didNotRun`, ignoring any rare interrupted case). Of two
 * attempts with the same retry index, the failing one decides. Timed-out stays
 * its own bucket — the server folds it into failed on ingest — and a test that
 * passed only after a retry counts as passed. Playwright reports
 * each attempt through `onTestEnd`, so the raw counters tally attempts; this is
 * what turns them back into a per-test summary before the run body is sent.
 */
export function computeDistinctRunCounts(
  testCases: ReadonlyArray<{
    testId?: string;
    title: string;
    location: string;
    status?: string;
    retries?: number | null;
    browser?: unknown;
    suitePath?: string[] | null;
  }>,
): RunCounts {
  const final = new Map<string, { status: string; retries: number }>();
  for (const tc of testCases) {
    const key =
      tc.testId ??
      [tc.title, tc.location, (tc.suitePath ?? []).join('\x1f'), browserProjectName(tc.browser)].join('\x00');
    const status = tc.status ?? '';
    const retries = tc.retries ?? 0;
    const prev = final.get(key);
    // The highest-retry attempt is the final one, so it decides the outcome.
    const decides =
      !prev ||
      retries > prev.retries ||
      (retries === prev.retries && (isFailingStatus(status) || !isFailingStatus(prev.status)));
    if (decides) final.set(key, { status, retries });
  }
  const counts: RunCounts = {
    totalTests: final.size,
    passedTests: 0,
    failedTests: 0,
    timedOutTests: 0,
    skippedTests: 0,
    didNotRunTests: 0,
  };
  for (const { status } of final.values()) {
    if (status === 'passed') counts.passedTests++;
    else if (status === 'failed') counts.failedTests++;
    else if (status === 'timedOut' || status === 'timedout') counts.timedOutTests++;
    else if (status === 'skipped') counts.skippedTests++;
    else if (status === 'didnotrun') counts.didNotRunTests++;
  }
  return counts;
}

/** Options for `serializeRun`. */
export interface SerializeRunOptions {
  /** Include `testCases` (projected to wire shape) in the serialized body. */
  includeTestCases: boolean;
}

/**
 * Serialize a `RunPayload` into the JSON body sent to `/api/test-runs/submit`
 * (with `includeTestCases: true`) or the `testRun` form field of
 * `/api/test-runs/upload` (with `includeTestCases: false`, since the multipart
 * path appends `testCases` as a separate form field).
 *
 * This is the single source of truth for the run-level field list — adding a
 * field touches this helper plus the `RunPayload` type, not three files.
 */
export function serializeRun(payload: RunPayload, opts: SerializeRunOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    projectName: payload.projectName,
    projectDescription: payload.projectDescription,
    status: payload.status,
    startTime: payload.startTime,
    duration: payload.duration,
    totalTests: payload.totalTests,
    passedTests: payload.passedTests,
    failedTests: payload.failedTests,
    timedOutTests: payload.timedOutTests ?? 0,
    skippedTests: payload.skippedTests,
    didNotRunTests: payload.didNotRunTests ?? 0,
    environment: payload.environment ?? null,
    label: payload.label ?? null,
    keep: payload.keep === true,
    // A probe run is stamped in `onBegin` (see the reporter), so the marker
    // already rides in `payload.metadata` here and on every other submit path.
    metadata: payload.metadata,
    instanceId: payload.instanceId,
    playwrightVersion: payload.playwrightVersion,
    reporterVersion: payload.reporterVersion,
    shardIndex: payload.shardIndex,
    shardTotal: payload.shardTotal,
    isFullRun: payload.isFullRun ?? true,
    filterDetails: payload.filterDetails ?? null,
  };
  if (payload.resourceReport) body.resourceReport = payload.resourceReport;
  if (payload.deliveryKey) body.deliveryKey = payload.deliveryKey;
  if (opts.includeTestCases) {
    body.testCases = payload.testCases.map((tc) => toWireTestCase(tc));
  }
  return body;
}
