/**
 * Internal collection model — the shapes the reporter accumulates *in process*
 * while a run executes.
 *
 * These are NOT sent to the server verbatim: the wire projection happens in
 * `serializer.ts` (`toWireTestCase` / `serializeRun`) at the JSON boundary. For
 * the external server contract, see `./wire.ts`.
 */

import type {
  BrowserConfig,
  SuiteConfigEntry,
  TestAnnotation,
  TestMetadata,
  TestSourceFrame,
  TestStepEvent,
  LocatorPageUse,
  WireExecutionResources,
  WireNetworkRequest,
} from './wire.js';
import type { CoverageCapture } from '@piwitests/core/coverage';
import type { LocatorSnapshot } from '../internal/capture/locator-healing.js';

/**
 * A raw Playwright attachment as exposed on `TestResult.attachments`.
 * Carried verbatim on `CollectedTestCase.attachments` so `FileHandler` can
 * resolve trace/attachment paths; never sent to the server.
 */
export interface RawAttachment {
  name: string;
  path?: string;
  contentType?: string;
  body?: Buffer;
  originalName?: string;
}

/** Performance metrics collected from `result.steps` by `collectStepMetrics`. */
export interface CollectedPerformanceMetrics {
  steps: Array<{ title: string; duration: number; category: string; error?: { message: string }; failed?: boolean }>;
  totalStepDuration: number;
  slowestStep: { title: string; duration: number } | null;
  navigationCount: number;
  navigationTotalDuration: number;
  waitTotalDuration: number;
  waitCount: number;
}

/**
 * What `onTestEnd` accumulates per test case. Mixes three concerns that the
 * reporter must keep together during a run:
 *  - **wire fields** (`title`, `status`, `duration`, …) that `toWireTestCase`
 *    projects onto `WireTestCase` before sending,
 *  - **collection-only state** (`attachments`, `performanceMetrics`,
 *    `stepEvents`) consumed by `FileHandler` and the run-level summary,
 *  - the `type` discriminant so the same collected object can be queued as a
 *    stream event.
 *
 * Upload bookkeeping is not on this object — `StreamManager` tracks uploaded
 * cases in a `WeakSet` (`uploadedCaseFiles`) so the data model stays clean.
 */
export interface CollectedTestCase {
  /** Stream-event discriminant: `'begin'` or `'complete'`. Omitted for batch-only runs. */
  type?: 'begin' | 'complete';
  /**
   * Playwright's `TestCase.id`, which tells apart tests that share a title and a
   * line (a parameterized test, a `--repeat-each` repetition). Collection-only:
   * the run counts read it, the wire never carries it.
   */
  testId?: string;
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
  /** Raw Playwright attachments — never sent on the wire. */
  attachments?: RawAttachment[];
  browser?: BrowserConfig | null;
  suitePath?: string[] | null;
  suiteConfig?: SuiteConfigEntry[] | null;
  testAnnotations?: TestAnnotation[] | null;
  /** Normalized `TestCase.tags`, `@` stripped (see `@piwitests/core/test-meta`). */
  tags?: string[] | null;
  /** Lock names read from the private `TestCase._locks` (best effort). */
  locks?: string[] | null;
  /** Ownership metadata parsed from `piwi:` annotations. */
  testMeta?: TestMetadata | null;
  /** The test's external ID, `null` when it has none to match on (see `externalId` in the options). */
  externalId?: string | null;
  /** The title without its external ID, with `externalId.stripFromTitle`. */
  displayTitle?: string | null;
  /** Source snippet around the failing line (failed/timedOut only). */
  testSource?: string;
  /** In-project call-stack frames (innermost first): the failing line + its callers. */
  testSourceFrames?: TestSourceFrame[];
  /** Step metrics from `collectStepMetrics`. Consumed by the run summary + `toWireTestCase`. */
  performanceMetrics?: CollectedPerformanceMetrics;
  stepEvents?: TestStepEvent[];
  /** Parsed from `piwi-network` attachments by `FileHandler`. */
  networkRequests?: WireNetworkRequest[];
  /** Parsed from `piwi-web-vitals` attachments. */
  webVitals?: unknown;
  pageState?: unknown;
  /** Parsed from `piwi-page-inventory`: controls and links per visited page (passing runs). */
  pageInventory?: unknown;
  /** Parsed from the `piwi-ai-usage` manifest: committed AI-step artifacts this test replayed. */
  aiUsage?: unknown;
  /** Parsed from `piwi-console` attachments. */
  consoleLogs?: unknown;
  /** Parsed from `piwi-dialogs` attachment: browser dialogs observed via the close event. */
  dialogs?: unknown;
  /** Parsed from `piwi-aria-snapshot` attachment. */
  ariaSnapshot?: string;
  /** Parsed from `piwi-aria-snapshot-json` attachment (Playwright ≥ 1.63). */
  ariaSnapshotJson?: string;
  /** Parsed from `piwi-locators` attachment. */
  locatorSnapshots?: LocatorSnapshot[];
  /** Parsed from `piwi-locator-pages`: the page each locator call ran on. */
  locatorPages?: LocatorPageUse[];
  /** Parsed from `piwi-code-reach`: the repository-relative source files the test executed. */
  codeReach?: string[];
  /** The test's coverage: its browser files and the server coverage collected from the backend. */
  coverage?: CoverageCapture;
  /** What the execution cost its worker and browsers, from its resource census. */
  resources?: WireExecutionResources;
  /** Why a `didnotrun` case never executed; unset for tests that ran. */
  didNotRunReason?: string | null;
  /** Playwright's `TestCase.expectedStatus`: `failed` for a `test.fail()` test. */
  expectedStatus?: string | null;
  /** For a `previous-failure` cascade, the location of the failing test that blocked it. */
  blockedBy?: string | null;
}

/** Hash + size of a single trace file, used for dedup against the server. */
export interface TraceHashInfo {
  tracePath: string;
  hash: string;
  size: number;
}
