import type { LocatorSnapshot } from './locator-healing.types';
import type {
  BrowserConfig,
  FilterDetails,
  SelectionStamp,
  SuiteConfigEntry,
  TestAnnotation,
  TestMetadata,
  TestSourceFrame,
  TestStepEvent,
  TestStepEventHook,
  ProcessRole,
  ResourceVerdict,
  RoleCost,
  RoleUsage,
  SeriesPoint,
  WireExecutionResources,
  WireNetworkRequest,
  WireResourceFinding,
  WireResourceReport,
  WireResourceTimeline,
  WireRunProfile,
  WorkerHealth,
} from '@piwitests/core/wire';

// The wire leaf shapes live in @piwitests/core (shared with the reporter);
// re-export them so `#shared/types` consumers keep importing them from here.
export type {
  BrowserConfig,
  FilterDetails,
  SelectionStamp,
  SuiteConfigEntry,
  TestAnnotation,
  TestMetadata,
  TestSourceFrame,
  TestStepEvent,
  TestStepEventHook,
  ProcessRole,
  ResourceVerdict,
  RoleCost,
  RoleUsage,
  SeriesPoint,
  WireExecutionResources,
  WireNetworkRequest,
  WireResourceFinding,
  WireResourceReport,
  WireResourceTimeline,
  WireRunProfile,
  WorkerHealth,
};

// ── Test status types ──────────────────────────────────────────────────────────
// These mirror the values stored in the test_runs.status column and the
// Playwright result.status values.

export type TestRunStatus =
  | 'passed'
  | 'failed'
  | 'timedout'
  | 'interrupted'
  | 'running'
  | 'cancelled'
  | 'initializing'
  | 'finalizing';

// `didnotrun` = a test that never executed: cut short by `maxFailures` or
// skipped as a side effect of an earlier failure in a `describe.serial` group.
// Distinct from `skipped`, which is reserved for intentional `test.skip()` /
// `test.fixme()`.
// `timedout` is the canonical stored spelling: ingest normalizes Playwright's
// camelCase `timedOut` wire value (`normalizeTestCaseStatus`), while a stored
// row may still carry the camelCase form — readers match both via
// `FAILED_STATUS_KEYS` (shared/utils/test-counts.ts).
export type TestCaseStatus = 'passed' | 'failed' | 'skipped' | 'timedout' | 'didnotrun';

// ── Roles ─────────────────────────────────────────────────────────────────────
// Instance roles, project roles and permissions live in `#shared/permissions`.

// ── Test case payload ─────────────────────────────────────────────────────────
// The JSON shape exchanged between the reporter and the server APIs.
// The reporter uses `location` (combined "file:line:col" string); the server
// parses it into filePath/line/column via parseLocation().

export interface TestCasePayload {
  title: string;
  location: string;
  status: string;
  duration?: number | null;
  /** Effective per-test timeout in ms (`TestCase.timeout`); `0` means unbounded. */
  timeout?: number | null;
  error?: string | null;
  retries?: number | null;
  /** One entry per attempt up to and including this one: `{ retry, status, duration, startedAt }`. */
  attempts?: Array<{ retry: number; status: string; duration: number; startedAt: number | null }> | null;
  steps?: unknown;
  stepEvents?: TestStepEvent[] | null;
  slowestStep?: string | null;
  slowestStepDuration?: number | null;
  wastedTimeMs?: number | null;
  networkRequests?: WireNetworkRequest[] | null;
  webVitals?: unknown;
  pageState?: unknown;
  /** Page inventory: controls and links per visited page (passing runs). */
  pageInventory?: unknown;
  /** The page each locator call ran on (`piwi-locator-pages`): `{ location, locator, origin, page, arrival }[]`. */
  locatorPages?: unknown;
  /** The repository-relative source files the test executed (`piwi-code-reach`), when code reach is on. */
  codeReach?: unknown;
  /**
   * The test's coverage (`@piwitests/core/coverage` `CoverageCapture`): per file and runtime, the functions and
   * lines that ran. Read through `sanitizeCoverage`.
   */
  coverage?: unknown;
  /** What the execution cost its worker and browsers, and what it found and left open (`piwi-resources`). */
  resources?: WireExecutionResources | null;
  /** AI-step usage manifest (`{ entries: string[] }`): committed AI-step artifacts this test replayed. */
  aiUsage?: unknown;
  consoleLogs?: unknown;
  dialogs?: unknown;
  ariaSnapshot?: unknown;
  ariaSnapshotJson?: unknown;
  workerIndex?: number | null;
  shardIndex?: number | null;
  startedAt?: number | null;
  browser?: BrowserConfig | null;
  suitePath?: string[] | null;
  suiteConfig?: SuiteConfigEntry[] | null;
  testAnnotations?: TestAnnotation[] | null;
  /** Tags declared on the test (`TestCase.tags`), normalized with `@` stripped. */
  tags?: string[] | null;
  /** Lock names the execution held (`TestCase._locks`); best effort — none from blob imports. */
  locks?: string[] | null;
  /** Ownership metadata declared via `piwi:` annotations. */
  testMeta?: TestMetadata | null;
  /** Per-element locator snapshots with ranked alternatives (transient — not stored as a column). */
  locatorSnapshots?: LocatorSnapshot[] | null;
  /** Source snippet around the failing line of the spec file (captured on failure only). */
  testSource?: string | null;
  /** In-project call-stack frames (innermost first): the failing line + its callers. */
  testSourceFrames?: TestSourceFrame[] | null;
  /** Why a `didnotrun` case never executed (`previous-failure`/`global-timeout`/`max-failures`/`interrupted`). */
  didNotRunReason?: string | null;
  /** Playwright's `TestCase.expectedStatus`: `failed` for a `test.fail()` test. */
  expectedStatus?: string | null;
  /** For a `previous-failure` cascade, the location of the failing test that blocked it. */
  blockedBy?: string | null;
}

// ── Submit (JSON) payload ─────────────────────────────────────────────────────

/** Who asked for a run to be kept forever: a person, the reporter at ingest, or a release marker. */
export type KeepSource = 'user' | 'reporter' | 'marker';

export interface TestRunSubmitPayload {
  projectName: string;
  projectDescription?: string;
  status: string;
  startTime: string;
  duration?: number;
  totalTests?: number;
  passedTests?: number;
  failedTests?: number;
  /** Timed-out tests; folded into `failedTests` by the server (no separate column). */
  timedOutTests?: number;
  skippedTests?: number;
  didNotRunTests?: number;
  environment?: string | null;
  label?: string | null;
  /** Keep the run forever: retention never deletes it. */
  keep?: boolean;
  metadata?: Record<string, unknown> | null;
  instanceId?: string | null;
  playwrightVersion?: string;
  reporterVersion?: string;
  testCases?: TestCasePayload[];
  shardIndex?: number;
  shardTotal?: number;
  isFullRun?: boolean;
  filterDetails?: FilterDetails | null;
  /** The run's resource findings and what it cost its machine, measured by the reporter. */
  resourceReport?: WireResourceReport | null;
  /**
   * An id the client generates once for these results and sends with every attempt to deliver them: a delivery
   * repeating a key the project already took answers with the run it went to and stores nothing.
   */
  deliveryKey?: string;
}

// ── Streaming event payload ───────────────────────────────────────────────────

export interface StreamEventPayload {
  type: 'begin' | 'complete' | 'step-begin' | 'step-end';
  title: string;
  location: string;
  status?: string;
  duration?: number | null;
  /** Effective per-test timeout in ms (`TestCase.timeout`); `0` means unbounded. */
  timeout?: number | null;
  error?: string | null;
  retries?: number | null;
  /** One entry per attempt up to and including this one: `{ retry, status, duration, startedAt }`. */
  attempts?: Array<{ retry: number; status: string; duration: number; startedAt: number | null }> | null;
  workerIndex?: number | null;
  shardIndex?: number | null;
  startedAt?: number | null;
  steps?: unknown;
  stepEvents?: TestStepEvent[] | null;
  stepCategory?: string | null;
  /** Step target for a `step-begin`/`step-end` event (rendered locator or URL). */
  subtitle?: string | null;
  parentTitle?: string | null;
  slowestStep?: string | null;
  slowestStepDuration?: number | null;
  wastedTimeMs?: number | null;
  networkRequests?: WireNetworkRequest[] | null;
  webVitals?: unknown;
  pageState?: unknown;
  pageInventory?: unknown;
  locatorPages?: unknown;
  codeReach?: unknown;
  coverage?: unknown;
  resources?: WireExecutionResources | null;
  aiUsage?: unknown;
  consoleLogs?: unknown;
  dialogs?: unknown;
  ariaSnapshot?: unknown;
  ariaSnapshotJson?: unknown;
  browser?: BrowserConfig | null;
  suitePath?: string[] | null;
  suiteConfig?: SuiteConfigEntry[] | null;
  testAnnotations?: TestAnnotation[] | null;
  tags?: string[] | null;
  locks?: string[] | null;
  testMeta?: TestMetadata | null;
  locatorSnapshots?: LocatorSnapshot[] | null;
  /** Source snippet around the failing line of the spec file (captured on failure only). */
  testSource?: string | null;
  /** In-project call-stack frames (innermost first): the failing line + its callers. */
  testSourceFrames?: TestSourceFrame[] | null;
  /** Why a `didnotrun` case never executed (`previous-failure`/`global-timeout`/`max-failures`/`interrupted`). */
  didNotRunReason?: string | null;
  /** Playwright's `TestCase.expectedStatus`: `failed` for a `test.fail()` test. */
  expectedStatus?: string | null;
  /** For a `previous-failure` cascade, the location of the failing test that blocked it. */
  blockedBy?: string | null;
}

// ── Finish payload ────────────────────────────────────────────────────────────

export interface TestRunFinishPayload {
  streamToken: string | null;
  status: string;
  duration: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  /** Timed-out tests; folded into `failedTests` by the server (no separate column). */
  timedOutTests?: number;
  skippedTests: number;
  didNotRunTests?: number;
  flakyTests: number;
  durations: number[];
  /** Trace/report uploads are still in flight — the run enters `finalizing` instead of completing. */
  hasPendingUploads?: boolean;
  /** Suite-level hook/fixture steps (beforeAll/afterAll) for the run timeline. */
  setupSteps?: Array<{
    title: string;
    category: string;
    startedAt: number;
    duration: number;
    status: string;
    location?: string | null;
    workerIndex?: number | null;
  }>;
  label?: string | null;
  /** Keep the run forever: retention never deletes it. */
  keep?: boolean;
  metadata?: Record<string, unknown>;
  playwrightVersion?: string;
  reporterVersion?: string;
  shardIndex?: number;
  shardTotal?: number;
  isFullRun?: boolean;
  filterDetails?: FilterDetails | null;
  /** The run's resource findings and what it cost its machine, measured by the reporter (per shard). */
  resourceReport?: WireResourceReport | null;
}

// ── Setup / start payload ─────────────────────────────────────────────────────

export interface TestRunStartPayload {
  projectName: string;
  projectDescription?: string;
  startTime?: string;
  environment?: string | null;
  label?: string | null;
  /** Keep the run forever: retention never deletes it. */
  keep?: boolean;
  metadata?: Record<string, unknown>;
  instanceId?: string;
  playwrightVersion?: string;
  reporterVersion?: string;
  shardIndex?: number;
  shardTotal?: number;
  isFullRun?: boolean;
  filterDetails?: FilterDetails | null;
}

// ── Declared surface manifest (Test Map) ──────────────────────────────────────
//
// The declared-surface contract: what the application says it exposes, ahead of
// any test reaching it. Three ramps produce it — the instrumentation package's
// `/__piwi/manifest`, a committed `piwi.manifest.json` next to the Playwright
// config, and a project's OpenAPI URL fetched server-side. All three reduce to
// this one shape, uploaded through `PUT /api/projects/:id/surface/manifest` and
// turned into `route`/`page` graph nodes with origin `manifest` or `openapi`.

/** A declared route: its method, path pattern, handler file and documented codes. */
export interface ManifestRoute {
  /** HTTP method, upper-cased on ingest. */
  method: string;
  /** Path pattern, e.g. `/api/orders/:id`. */
  pattern: string;
  /** Handler source file, when the instrumentation knows it. */
  handler?: string | null;
  /** Documented response status codes (from OpenAPI), used to strengthen success-only. */
  responses?: number[];
}

/** A declared page: its path pattern and an optional display name. */
export interface ManifestPage {
  /** Path pattern, e.g. `/orders/:id`. */
  pattern: string;
  name?: string | null;
}

/** The declared surface of an application: its routes and pages. */
export interface AppManifest {
  routes?: ManifestRoute[];
  pages?: ManifestPage[];
}

/** Where a declared manifest came from — it decides the graph node origin. */
export type ManifestSource = 'instrumentation' | 'committed' | 'openapi';
