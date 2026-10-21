/**
 * Wire contract — the **external** shapes sent to / received from the Piwi
 * Dashboard server.
 *
 * The small leaf shapes (`SuiteConfigEntry`, `TestAnnotation`, `FilterDetails`,
 * `BrowserConfig`, `TestStepEvent`) come from `@piwitests/core` (bundled at build
 * time, shared with the app). The per-case `WireTestCase` and the stream-event
 * union below are the reporter's own producer shapes; they stay structurally
 * compatible with the server's `TestCasePayload` / `StreamEventPayload` (pinned by
 * the dashboard's wire drift-guard test). **Any change here is a server-contract change.**
 *
 * For the in-process collection model (never sent verbatim), see `./collected.ts`.
 */
import type {
  BrowserConfig,
  FilterDetails,
  LocatorPageUse,
  SelectionStamp,
  SuiteConfigEntry,
  TestAnnotation,
  TestMetadata,
  TestSourceFrame,
  TestStepEvent,
  WireExecutionResources,
  WireNetworkRequest,
  WireResourceReport,
} from '@piwitests/core/wire';

export type {
  BrowserConfig,
  FilterDetails,
  LocatorPageUse,
  SelectionStamp,
  SuiteConfigEntry,
  TestAnnotation,
  TestMetadata,
  TestSourceFrame,
  TestStepEvent,
  WireExecutionResources,
  WireNetworkRequest,
  WireResourceReport,
};

// ── Per-case wire shape ──────────────────────────────────────────────────────

/**
 * The per-case wire shape that `toWireTestCase` produces and the server
 * receives. Structurally compatible with `TestCasePayload` and the per-event
 * `StreamEventPayload`.
 */
export interface WireTestCase {
  type?: 'begin' | 'complete' | 'step-begin' | 'step-end';
  title: string;
  location: string;
  status?: string;
  duration?: number;
  /** Effective per-test timeout in ms (`TestCase.timeout`); `0` means unbounded. */
  timeout?: number | null;
  error?: string | null;
  retries?: number;
  /** One entry per attempt up to and including this one: `{ retry, status, duration, startedAt }`. */
  attempts?: Array<{ retry: number; status: string; duration: number; startedAt: number | null }> | null;
  workerIndex?: number | null;
  shardIndex?: number | null;
  startedAt?: number | null;
  steps?: unknown;
  stepEvents?: TestStepEvent[] | null;
  slowestStep?: string | null;
  slowestStepDuration?: number | null;
  wastedTimeMs?: number | null;
  networkRequests?: WireNetworkRequest[] | null;
  webVitals?: unknown;
  pageState?: unknown;
  pageInventory?: unknown;
  aiUsage?: unknown;
  consoleLogs?: unknown;
  dialogs?: unknown;
  ariaSnapshot?: unknown;
  ariaSnapshotJson?: unknown;
  testSource?: string | null;
  testSourceFrames?: TestSourceFrame[] | null;
  browser?: BrowserConfig | null;
  suitePath?: string[] | null;
  suiteConfig?: SuiteConfigEntry[] | null;
  testAnnotations?: TestAnnotation[] | null;
  /** Normalized `TestCase.tags`, `@` stripped. */
  tags?: string[] | null;
  /** Lock names from the private `TestCase._locks` (best effort; none from blob imports). */
  locks?: string[] | null;
  /** Ownership metadata parsed from `piwi:` annotations. */
  testMeta?: TestMetadata | null;
  /**
   * The test's external ID (`piwi:id`, or read from the title with the reporter's `externalId.pattern`). `null` when
   * the reporter found none or set it aside as a duplicate; absent from older reporters, in which case the server reads
   * `piwi:id` from `testAnnotations`.
   */
  externalId?: string | null;
  /** The title without its external ID, when the reporter's `externalId.stripFromTitle` is on. `title` stays whole. */
  displayTitle?: string | null;
  /** Step-event discriminant (only for `step-begin`/`step-end` events). */
  stepCategory?: string | null;
  parentTitle?: string | null;
  /** Per-element locator snapshots with ranked alternatives (transient — not stored per-run). */
  locatorSnapshots?: unknown;
  /** The page each locator call ran on (`piwi-locator-pages`). */
  locatorPages?: unknown;
  /** The repository-relative source files the test executed (`piwi-code-reach`). */
  codeReach?: unknown;
  /**
   * The test's coverage (`@piwitests/core/coverage` `CoverageCapture`): per
   * repository-relative file and runtime, browser and server, the functions
   * and lines that ran at the configured granularity.
   */
  coverage?: unknown;
  /** What the execution cost its worker and browsers, and what it found and left open (`piwi-resources`). */
  resources?: WireExecutionResources | null;
  /** Why a `didnotrun` case never executed (`previous-failure`/`global-timeout`/`max-failures`/`interrupted`). */
  didNotRunReason?: string | null;
  /** Playwright's `TestCase.expectedStatus`: `failed` for a `test.fail()` test. */
  expectedStatus?: string | null;
  /** For a `previous-failure` cascade, the location of the failing test that blocked it. */
  blockedBy?: string | null;
}

// ── Stream events (discriminated union) ──────────────────────────────────────

export interface BeginStreamEvent {
  type: 'begin';
  title: string;
  location: string;
  workerIndex: number | null;
  shardIndex: number | null;
  browser?: BrowserConfig | null;
  suitePath?: string[] | null;
  suiteConfig?: SuiteConfigEntry[] | null;
}

export interface CompleteStreamEvent {
  type: 'complete';
  title: string;
  location: string;
  status: string;
  duration: number;
  timeout?: number | null;
  error: string | null;
  retries: number;
  /** One entry per attempt up to and including this one: `{ retry, status, duration, startedAt }`. */
  attempts?: Array<{ retry: number; status: string; duration: number; startedAt: number | null }> | null;
  workerIndex: number | null;
  shardIndex: number | null;
  startedAt: number | null;
  browser?: BrowserConfig | null;
  suitePath?: string[] | null;
  suiteConfig?: SuiteConfigEntry[] | null;
  testAnnotations?: TestAnnotation[] | null;
  tags?: string[] | null;
  locks?: string[] | null;
  testMeta?: TestMetadata | null;
  externalId?: string | null;
  displayTitle?: string | null;
  steps?: unknown;
  stepEvents?: TestStepEvent[] | null;
  slowestStep?: string | null;
  slowestStepDuration?: number | null;
  networkRequests?: WireNetworkRequest[] | null;
  webVitals?: unknown;
  pageState?: unknown;
  pageInventory?: unknown;
  aiUsage?: unknown;
  consoleLogs?: unknown;
  dialogs?: unknown;
  ariaSnapshot?: unknown;
  ariaSnapshotJson?: unknown;
  testSource?: string | null;
  testSourceFrames?: TestSourceFrame[] | null;
  locatorSnapshots?: unknown;
  /** The page each locator call ran on (`piwi-locator-pages`). */
  locatorPages?: unknown;
  /** The repository-relative source files the test executed (`piwi-code-reach`). */
  codeReach?: unknown;
  /**
   * The test's coverage (`@piwitests/core/coverage` `CoverageCapture`): per
   * repository-relative file and runtime, browser and server, the functions
   * and lines that ran at the configured granularity.
   */
  coverage?: unknown;
  /** What the execution cost its worker and browsers, and what it found and left open (`piwi-resources`). */
  resources?: WireExecutionResources | null;
  /** Why a `didnotrun` case never executed (`previous-failure`/`global-timeout`/`max-failures`/`interrupted`). */
  didNotRunReason?: string | null;
  /** Playwright's `TestCase.expectedStatus`: `failed` for a `test.fail()` test. */
  expectedStatus?: string | null;
  /** For a `previous-failure` cascade, the location of the failing test that blocked it. */
  blockedBy?: string | null;
}

export interface StepBeginStreamEvent {
  type: 'step-begin';
  title: string;
  /** The step's target (rendered locator or URL), carried separately by newer Playwright. */
  subtitle?: string | null;
  location: string;
  /** Playwright step category: `hook`, `fixture`, `pw:api` or `expect`. */
  stepCategory: string;
  parentTitle: string | null;
  workerIndex: number | null;
  startedAt: number | null;
}

export interface StepEndStreamEvent {
  type: 'step-end';
  title: string;
  /** The step's target (rendered locator or URL), carried separately by newer Playwright. */
  subtitle?: string | null;
  location: string;
  status: string;
  duration: number;
  /** Playwright step category: `hook`, `fixture`, `pw:api` or `expect`. */
  stepCategory: string;
  parentTitle: string | null;
  workerIndex: number | null;
  startedAt: number | null;
}

/** Discriminated union of events queued to `StreamManager` and persisted by `StreamBuffer`. */
export type StreamEvent = BeginStreamEvent | CompleteStreamEvent | StepBeginStreamEvent | StepEndStreamEvent;

// ── Suite-level setup steps (beforeAll/afterAll timeline) ─────────────────────

export interface SetupStep {
  title: string;
  category: string;
  startedAt: number;
  duration: number;
  status: string;
  location?: string | null;
  workerIndex?: number | null;
}
