import type { LocatorSnapshot } from '#shared/locator-healing.types';
import type { RunCaseInput } from './persist-run-cases';

/**
 * A streaming "complete" event whose source location has already been resolved
 * into `filePath` / `line` / `column`. The remaining wire fields are loosely
 * typed because the stream payload is not statically known.
 *
 * This module holds only types and a pure mapping function (no DB or runtime
 * dependencies) so both the live server ingest and the demo-mode ingest — which
 * runs in a service worker and deliberately avoids the DB-coupled
 * `persist-run-cases` module — can share it.
 */
export interface ParsedCompleteEvent {
  filePath: string;
  line: number | null;
  column: number | null;
  title?: string;
  status?: string;
  duration?: number | null;
  timeout?: number | null;
  error?: string | null;
  retries?: number | null;
  steps?: unknown;
  stepEvents?: unknown;
  slowestStep?: string | null;
  slowestStepDuration?: number | null;
  wastedTimeMs?: number | null;
  networkRequests?: unknown;
  webVitals?: unknown;
  pageState?: unknown;
  pageInventory?: unknown;
  locatorPages?: unknown;
  codeReach?: unknown;
  coverage?: unknown;
  resources?: unknown;
  aiUsage?: unknown;
  consoleLogs?: unknown;
  dialogs?: unknown;
  ariaSnapshot?: unknown;
  ariaSnapshotJson?: unknown;
  testSource?: string | null;
  testSourceFrames?: unknown;
  suitePath?: string[] | null;
  suiteConfig?: Array<{ mode: string; annotations: Array<{ type: string; description?: string }> }> | null;
  testAnnotations?: Array<{ type: string; description?: string }> | null;
  tags?: unknown;
  locks?: unknown;
  testMeta?: unknown;
  workerIndex?: number | null;
  shardIndex?: number | null;
  startedAt?: number | null;
  browser?: unknown;
  locatorSnapshots?: unknown;
  didNotRunReason?: string | null;
  expectedStatus?: string | null;
  blockedBy?: string | null;
}

/**
 * Build a `RunCaseInput` from a parsed streaming "complete" event. This is the
 * single source of truth for the wire-field → persisted-field mapping, shared by
 * the live server ingest (`api/test-runs/[id]/events`) and the demo-mode ingest
 * (`app/demo/api/reporter`), so both persist the same fields.
 */
export function mapCompleteEventToRunCase(tc: ParsedCompleteEvent): RunCaseInput {
  return {
    filePath: tc.filePath,
    suitePath: tc.suitePath ?? null,
    suiteConfig: tc.suiteConfig ?? null,
    testAnnotations: tc.testAnnotations ?? null,
    tags: tc.tags ?? null,
    locks: tc.locks ?? null,
    testMeta: tc.testMeta ?? null,
    title: tc.title as string,
    status: tc.status as string,
    duration: tc.duration,
    timeout: tc.timeout ?? null,
    error: tc.error,
    retries: tc.retries,
    attempts: (tc as { attempts?: unknown }).attempts ?? null,
    line: tc.line,
    column: tc.column,
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
    locatorSnapshots: (tc.locatorSnapshots as LocatorSnapshot[] | null | undefined) ?? null,
    didNotRunReason: tc.didNotRunReason ?? null,
    expectedStatus: tc.expectedStatus ?? null,
    blockedBy: tc.blockedBy ?? null,
  };
}
