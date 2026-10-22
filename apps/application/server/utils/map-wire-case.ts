import { parseLocation } from '#shared/parse-location';
import type { TestCasePayload } from '#shared/types';
import type { RunCaseInput } from './persist-run-cases';

/**
 * A test case as the reporter sends it: a case of a submitted or uploaded run,
 * or a streamed `complete` event. Every field may be missing: the body is not
 * validated before it is mapped.
 */
export type WireCase = Partial<TestCasePayload>;

/**
 * Build the `RunCaseInput` `persistRunCases` stores from a wire test case, its
 * `location` (`file:line:col`) read into `filePath`, `line` and `column`. The
 * one wire-field → persisted-field mapping, shared by every ingest route
 * (`submit`, `upload`, `[id]/events`) and the demo's ingest
 * (`app/demo/api/reporter`). This module holds no database or runtime
 * dependency, so the demo's service worker can import it.
 */
export function mapWireCaseToRunCase(tc: WireCase): RunCaseInput {
  const { filePath, line, column } = tc.location
    ? parseLocation(tc.location)
    : { filePath: 'unknown', line: null, column: null };
  return {
    filePath,
    suitePath: tc.suitePath ?? null,
    suiteConfig: tc.suiteConfig ?? null,
    testAnnotations: tc.testAnnotations ?? null,
    tags: tc.tags ?? null,
    locks: tc.locks ?? null,
    testMeta: tc.testMeta ?? null,
    // Kept `undefined` when absent: an older reporter sends no field, and the server then reads `piwi:id` itself.
    externalId: tc.externalId,
    displayTitle: tc.displayTitle ?? null,
    title: tc.title as string,
    status: tc.status as string,
    duration: tc.duration,
    timeout: tc.timeout ?? null,
    error: tc.error,
    retries: tc.retries,
    repeatEachIndex: tc.repeatEachIndex ?? null,
    attempts: tc.attempts ?? null,
    line,
    column,
    steps: tc.steps,
    stepEvents: tc.stepEvents ?? null,
    slowestStep: tc.slowestStep,
    slowestStepDuration: tc.slowestStepDuration,
    wastedTimeMs: tc.wastedTimeMs ?? null,
    networkRequests: tc.networkRequests,
    webVitals: tc.webVitals,
    pageState: tc.pageState,
    pageInventory: tc.pageInventory,
    locatorPages: tc.locatorPages,
    codeReach: tc.codeReach,
    coverage: tc.coverage,
    resources: tc.resources ?? null,
    aiUsage: tc.aiUsage,
    consoleLogs: tc.consoleLogs,
    dialogs: tc.dialogs,
    ariaSnapshot: (tc.ariaSnapshot as string | null | undefined) ?? null,
    ariaSnapshotJson: (tc.ariaSnapshotJson as string | null | undefined) ?? null,
    testSource: tc.testSource ?? null,
    testSourceFrames: tc.testSourceFrames ?? null,
    workerIndex: tc.workerIndex ?? null,
    shardIndex: tc.shardIndex ?? null,
    startedAt: tc.startedAt ?? null,
    browser: tc.browser ?? null,
    locatorSnapshots: tc.locatorSnapshots ?? null,
    didNotRunReason: tc.didNotRunReason ?? null,
    expectedStatus: tc.expectedStatus ?? null,
    blockedBy: tc.blockedBy ?? null,
  };
}
