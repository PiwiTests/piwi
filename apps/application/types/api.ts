import type { Serialize, Simplify } from 'nitropack/types';
/**
 * Shared types for API responses and requests
 * These types are used by both the server API and the app frontend
 */

import type { IngestHealth } from '#shared/ingest-health';
import type {
  FilterDetails,
  KeepSource,
  TestMetadata,
  TestSourceFrame,
  TestStepEventHook,
  WireExecutionResources,
} from '#shared/types';
import type { ScmProviderName } from '#shared/scm-urls';
import type { PageDiffSummary, PageDiffHunk } from '#shared/page-diff';
import type { ClusterState } from '#shared/cluster-state';
import type { NextStep } from '#shared/next-step';
import type { HeadlinePart } from '#shared/describe-failure';
import type { PageInteraction } from '#shared/page-interaction';
import type { IssueFilingFailure, KnownIssueRef } from '#shared/handlers/known-issues';
import type { AccessSummary, InstanceRole } from '#shared/permissions';
export type { TestMetadata, TestSourceFrame };
export type { ClusterState } from '#shared/cluster-state';
export type { NextStep } from '#shared/next-step';

/** One run's occurrence count for a cluster, for the occurrence sparkline. */
export interface OccurrenceSeriesPoint {
  runId: number;
  startedAt: string | Date | null;
  occurrences: number;
}

/**
 * The headline of a cluster's latest occurrence, or of its first one (the stored
 * sample error) when the latest execution carries no error.
 */
export interface ClusterLatestHeadline {
  parts: HeadlinePart[];
  /** A second, shorter fact the headline left out, or null. */
  detail: string | null;
  source: 'latest' | 'first';
  /** The run the occurrence it reads failed in. */
  runId: number;
}

// ============================================================================
// Metadata types
// ============================================================================

/**
 * SCM (source control) metadata attached to a test run
 */
export interface TestRunScmMetadata {
  commit?: string | null;
  branch?: string | null;
  prNumber?: string | number | null;
  author?: string | null;
  commitMessage?: string | null;
}

/**
 * CI metadata attached to a test run
 */
export interface TestRunCiMetadata {
  provider?: string | null;
  buildNumber?: string | null;
  buildUrl?: string | null;
  jobName?: string | null;
  workflow?: string | null;
}

/**
 * Metadata attached to a test run
 */
export interface TestRunMetadata {
  scm?: TestRunScmMetadata;
  ci?: TestRunCiMetadata;
  projectDescription?: string | null;
  relatedIssue?: string | null;
  tags?: string[];
  customData?: Record<string, unknown>;
  /** What ingest left out or rebuilt for the run; absent when it was stored whole. */
  ingestHealth?: IngestHealth;
  [key: string]: unknown;
}

// ============================================================================
// Report types (API responses)
// ============================================================================

/**
 * Report attached to a test run
 */
export interface ReportInfo {
  id: number;
  type: string;
  label: string;
  path: string;
  size?: number | null;
}

// ============================================================================
// Tag types (API responses)
// ============================================================================

/**
 * Tag used to label projects
 */
export interface TagInfo {
  id: number;
  text: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tags response from API
 */
export interface TagsResponse {
  items: TagInfo[];
}

// ============================================================================
// Marker types (project timeline markers / events)
// ============================================================================

/**
 * A dated timeline marker for a project (deploy, config change, incident, ...).
 */
export interface MarkerInfo {
  id: number;
  projectId: number;
  occurredAt: string | Date;
  label: string;
  description: string | null;
  category: string;
  environment: string | null;
  source: string; // 'manual' | 'auto'
  runId: number | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/**
 * Markers response from API
 */
export interface MarkersResponse {
  items: MarkerInfo[];
}

// ============================================================================
// Test function catalog types (recorder codegen matching — see
// packages/core/src/function-match.ts for the deserialized `entry` shape)
// ============================================================================

export interface TestFunctionParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  /** For `type: 'object'` — the option bag's own property names, so codegen can emit `{ label: '…' }`. */
  fields?: string[];
}

export interface TestFunctionPatternTarget {
  role?: string | null;
  name?: string | null;
  testId?: string | null;
}

export type TestFunctionStepAction =
  | 'goto'
  | 'click'
  | 'fill'
  | 'check'
  | 'uncheck'
  | 'selectOption'
  | 'press'
  | 'assertVisible';

export interface TestFunctionPatternStep {
  action: TestFunctionStepAction;
  target: TestFunctionPatternTarget;
}

export interface TestFunctionParamSource {
  param: string;
  /** Which field of an `object` param this fills; absent for a scalar param, which takes the value whole. */
  path?: string | null;
  stepIndex: number;
  from: 'text' | 'value' | 'testId';
}

/** The deserialized catalog entry shape — matches `TestFunctionEntry` in `@piwitests/core/function-match`. */
export interface TestFunctionEntryInfo {
  id: number;
  name: string;
  kind: 'page-object-method' | 'helper' | 'fixture';
  module: string;
  receiver: string | null;
  importName: string | null;
  params: TestFunctionParam[];
  urlPattern: string | null;
  steps: TestFunctionPatternStep[];
  paramSources: TestFunctionParamSource[];
}

/** One catalog row as returned by the API — the raw row plus its deserialized `entry`. */
export interface TestFunctionInfo {
  id: number;
  projectId: number;
  name: string;
  kind: string;
  module: string;
  receiver: string | null;
  importName: string | null;
  urlPattern: string | null;
  source: string; // 'manual' | 'scanned' | 'recorded'
  confidence: number;
  createdAt: string | Date;
  updatedAt: string | Date;
  entry: TestFunctionEntryInfo;
}

export interface TestFunctionsResponse {
  items: TestFunctionInfo[];
}

// ============================================================================
// Period and Range types (used for filtering and date range selection)
// ============================================================================

export type Period = '1d' | '7d' | '30d' | '90d' | '1y' | 'daily' | 'weekly' | 'monthly';

export interface Range {
  start: Date;
  end: Date;
}

// ============================================================================
// Project types (API responses)
// ============================================================================

/**
 * Slim project entry for sidebar navigation - returned by GET /api/projects/menu
 */
export interface ProjectMenuItem {
  id: number;
  name: string;
  label: string | null;
}

/**
 * Project with statistics - returned by GET /api/projects
 */
export interface ProjectWithStats {
  id: number;
  name: string;
  label?: string | null;
  description?: string | null;
  tags?: TagInfo[];
  createdAt: Date;
  updatedAt: Date;
  // Statistics added by API
  latestRun?: {
    id: number;
    status: string;
    startTime: string | Date;
    duration?: number | null;
    passedTests: number;
    failedTests: number;
    skippedTests: number;
    /** `test.fixme()` skips — a subset of `skippedTests`. */
    fixmeTests?: number;
    didNotRunTests: number;
    flakyTests: number;
    totalTests: number;
    reports?: ReportInfo[];
    avgTestDuration?: number | null;
    p90TestDuration?: number | null;
    metadata: TestRunMetadata;
  } | null;
  totalRuns: number;
  totalTestCases: number;
}

/**
 * A single run entry in a project overview (slim, for trend bars)
 */
export interface ProjectOverviewRun {
  id: number;
  status: string;
  passedTests: number;
  failedTests: number;
  flakyTests: number;
  totalTests: number;
  startTime: string | Date;
  environment?: string | null;
}

/**
 * Per-project overview with trend data - returned by GET /api/projects/overview
 */
export interface ProjectOverview {
  id: number;
  name: string;
  label: string | null;
  tags: TagInfo[];
  totalFullRuns: number;
  latestFullRun: {
    id: number;
    status: string;
    startTime: string | Date;
    duration: number | null;
    passedTests: number;
    failedTests: number;
    flakyTests: number;
    totalTests: number;
  } | null;
  recentRuns: ProjectOverviewRun[];
  tendency: 'passing' | 'flaky' | 'failing' | 'unknown';
}

/**
 * One open failure cluster across projects - returned by
 * GET /api/failure-clusters?status=open. Drives the Home "Open failures" card.
 */
export interface OpenFailureCluster {
  id: number;
  projectId: number;
  projectName: string;
  projectLabel: string | null;
  title: string | null;
  signature: string;
  errorType: string | null;
  selector: string | null;
  sampleError: string | null;
  filePath: string | null;
  status: string;
  affectedTests: number;
  occurrences: number;
  firstSeenAt: string | Date | null;
  lastSeenAt: string | Date | null;
  lastSeenRunId: number;
  lastSeenRunStatus: string | null;
  owner: { name: string; source: 'annotation' | 'codeowners' } | null;
  /** Who the cluster is assigned to (name or email); overrides the derived owner. */
  assignee: string | null;
  issueLink: { url: string; provider: string; key: string | null } | null;
  /** A one-line cause hint for the row — muted secondary text. */
  topClue: { text: string; strength: 'strong' | 'medium' | 'weak' } | null;
  /** Fix-verification state; `'regressed'` drives the "fix didn't hold" queue and badge. */
  fixVerification: string | null;
  /** A new regression on the project's default branch in the last-seen run. */
  regressionOnDefault: boolean;
  /** The last-seen run was on the project's default branch — a needs-ticket candidate must be. */
  onDefaultBranch: boolean;
  /** The cluster already carries a tracker issue — excluded from needs-ticket. */
  hasKnownIssue: boolean;
  /** Days a cluster may sit untracked on the default branch before needs-ticket lists it. */
  needsTicketAfterDays: number;
  /** Affected tests currently quarantined, and how many are ready for release. */
  quarantinedCount: number;
  quarantineReadyCount: number;
  /** The cluster is part of a pending merge suggestion awaiting a decision. */
  mergeSuggestionPending: boolean;
  /** Snooze state — hidden from queues while snoozed; cleared/marked on wake. */
  snoozedUntil: string | Date | null;
  snoozeMode: string | null;
  /** Set when the cluster first appeared in a run flagged as an environment incident. */
  incidentRun: InboxIncidentRun | null;
}

/** The environment-incident run a cluster first appeared in, as the failure inbox groups it. */
export interface InboxIncidentRun {
  runId: number;
  reason: string;
  host: string | null;
  startedAt: string | Date | null;
}

/**
 * Project with test runs - returned by GET /api/projects/[id]
 */
export interface ProjectWithTestRuns {
  id: number;
  name: string;
  label?: string | null;
  description?: string | null;
  color?: string | null;
  tags?: TagInfo[];
  createdAt: Date;
  updatedAt: Date;
  testRuns: TestRunSummary[];
  diagnosisInstructions?: string | null;
  aiLanguage?: string | null;
  hasScmToken?: boolean;
  /** The repository the project's SCM calls read: pinned by its first run that names one, or set by a project admin. */
  repositoryUrl?: string | null;
  defaultBranch?: string | null;
  /** The project's setting, else its most common run branch, else `main`: what a run scope reads with no branch picked. */
  effectiveDefaultBranch?: string;
  openApiUrl?: string | null;
  /** Link to a test in the team's test management tool, `{id}` replaced by the test's external ID. */
  externalIdUrl?: string | null;
  serverProbes?: import('#shared/server-probes').ServerProbeSettings | null;
  /** Provider-specific "re-run from the dashboard" config (secrets excluded). */
  ciRerun?: import('#shared/ci-rerun').CiRerunSettings | null;
  /** True: a quarantined failure turns the run's commit status red. False: the status ignores it. */
  quarantineFailsStatus?: boolean;
  /** True: each gate evaluation also posts the `<statusContext>/gate` commit status. */
  gateStatus?: boolean;
  /** Test import and bugs folder for specs rendered from bug reports. */
  generatedSpecs?: { testImport?: string | null; bugsFolder?: string | null } | null;
  /** Per-project targets on catalog metrics. */
  targets?: import('#shared/analytics/targets').ProjectTargets | null;
  /** The files coverage totals count; null for the default excludes. */
  coverageScope?: import('@piwitests/core/coverage-scope').CoverageScope | null;
  coverageAreas?: import('@piwitests/core/coverage-scope').CoverageArea[] | null;
  /** Stored per-project capability decisions, for the edit form's overrides. */
  capabilities?: Partial<
    Record<import('#shared/capabilities').CapabilityId, import('#shared/capabilities').ProjectDecision>
  > | null;
}

/**
 * Project details for editing - used in edit forms
 */
export interface ProjectDetails {
  id: number;
  name: string;
  label?: string | null;
  description?: string | null;
  diagnosisInstructions?: string | null;
  hasScmToken: boolean;
  defaultBranch?: string | null;
  /** Provider-specific "re-run from the dashboard" config (secrets excluded). */
  ciRerun?: import('#shared/ci-rerun').CiRerunSettings | null;
  /** True: a quarantined failure turns the run's commit status red. False: the status ignores it. */
  quarantineFailsStatus?: boolean;
  /** True: each gate evaluation also posts the `<statusContext>/gate` commit status. */
  gateStatus?: boolean;
  /** Test import and bugs folder for specs rendered from bug reports. */
  generatedSpecs?: { testImport?: string | null; bugsFolder?: string | null } | null;
  /** Per-project targets on catalog metrics. */
  targets?: import('#shared/analytics/targets').ProjectTargets | null;
  /** The files coverage totals count; null for the default excludes. */
  coverageScope?: import('@piwitests/core/coverage-scope').CoverageScope | null;
  coverageAreas?: import('@piwitests/core/coverage-scope').CoverageArea[] | null;
  color?: string | null;
  tags?: TagInfo[];
  /** Stored per-project capability decisions, for the edit form's overrides. */
  capabilities?: Partial<
    Record<import('#shared/capabilities').CapabilityId, import('#shared/capabilities').ProjectDecision>
  > | null;
}

// ============================================================================
// Test Run types (API responses)
// ============================================================================

/**
 * Test run summary (without test cases)
 */
export interface TestRunSummary {
  id: number;
  projectId: number;
  status: string;
  startTime: string | Date;
  duration?: number | null;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  /** `test.fixme()` skips — a subset of `skippedTests`. */
  fixmeTests?: number;
  didNotRunTests: number;
  flakyTests: number;
  avgTestDuration?: number | null;
  p90TestDuration?: number | null;
  reports?: ReportInfo[];
  browsers?: string[];
  environment?: string | null;
  branch?: string | null;
  label?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: any | null;
  isFullRun?: boolean;
  filterDetails?: FilterDetails | null;
  /** Set when the run is kept forever: retention never deletes it. */
  keptAt?: string | Date | null;
  keepSource?: KeepSource | null;
  keepReason?: string | null;
  createdAt: Date;
}

/**
 * Test run with full details - returned by GET /api/test-runs/[id]
 */
export interface TestRunDetails {
  id: number;
  projectId: number;
  status: string;
  startTime: string | Date;
  /** Distinct endpoints captured for the run — the "Slow endpoints (n)" tab count. */
  networkRequestCount?: number;
  duration?: number | null;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  didNotRunTests: number;
  flakyTests: number;
  avgTestDuration?: number | null;
  p90TestDuration?: number | null;
  shardTotal?: number | null;
  shardsFinished?: number;
  isFullRun?: boolean;
  /** A reporter sent what the run cost and left open: the Resources tab has something to show. */
  hasResources?: boolean;
  filterDetails?: FilterDetails | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: any | null;
  setupSteps?: SetupStepEvent[] | null;
  environment?: string | null;
  label?: string | null;
  playwrightVersion?: string | null;
  reporterVersion?: string | null;
  /** Set when the run is kept forever: retention never deletes it. */
  keptAt?: string | Date | null;
  /** Who asked for the keep: a person, the reporter at ingest, or a release marker. */
  keepSource?: KeepSource | null;
  keepReason?: string | null;
  /** Why part of the run's server coverage is missing, per backend origin (`readRunCoverageGaps` reads it); null when whole. */
  serverCoverageGaps?: unknown;
  /** Display name of the person who kept the run, when one did and still exists. */
  keptByName?: string | null;
  createdAt: Date;
  project?: {
    id: number;
    name: string;
    label?: string | null;
    latestRunId?: number | null;
    latestRunStatus?: string | null;
    /** Link to a test in the team's test management tool, `{id}` replaced by the test's external ID. */
    externalIdUrl?: string | null;
  };
  reports?: ReportInfo[];
  testCases?: TestCaseResult[];
  suites?: SuiteInfo[];
  storageStats?: {
    totalFiles: number;
    totalSize: number;
    reportSizes: Array<{ label: string; size: number }>;
    testCaseFilesSize: number;
    testCaseFilesCount: number;
  };
  links?: EntityLinkInfo[];
  /** Effective allowlist of glob patterns classifying waits as wasted time. */
  wastedWaitPatterns?: string[];
  /** Nearest timeline marker at or before this run's start (matching env or global), if any. */
  precedingMarker?: MarkerInfo | null;
}

/**
 * Test run for charts and visualization
 */
export interface TestRunForChart {
  id: number;
  projectId?: number;
  projectName?: string;
  projectLabel?: string | null;
  status: string;
  startTime: string | Date;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  /** `test.fixme()` skips — a subset of `skippedTests`. */
  fixmeTests?: number;
  didNotRunTests: number;
  flakyTests: number;
  totalTests: number;
  duration?: number | null;
  avgTestDuration?: number | null;
  p90TestDuration?: number | null;
  isFullRun?: boolean;
  environment?: string | null;
  branch?: string | null;
}

// ============================================================================
// Performance types
// ============================================================================

/**
 * A single step recorded during test execution
 */
export interface PerformanceStep {
  title: string;
  duration: number;
  category: string;
  /** The step's target (rendered locator or URL), carried separately by newer Playwright. */
  subtitle?: string;
  /** Curated per-step arguments (rendered locator, URL, value, `test.step` author values). */
  params?: Record<string, string | number | boolean>;
  /**
   * The step's error when it failed (undefined when the step passed): its
   * message, and where it was thrown (`file:line:col`) on runs from a recent reporter.
   */
  error?: { message?: string; location?: string };
  /** True when the step failed. */
  failed?: boolean;
  /** True when the test caught the step's error and went on; set by a recent reporter. */
  recovered?: boolean;
  /** Source pointer `file:line:col` (not a code snippet); present on runs from a recent reporter. */
  location?: string;
  /** Absolute start time in ms; present on runs from a recent reporter. Enables per-step timing. */
  startTime?: number;
}

/**
 * A hook/fixture step event with absolute timing, used by WorkersTimeline
 * to render segments alongside the test case bar. A `pause` event is a stop at
 * Piwi's pause bar (an editor breakpoint): the call it held as its title.
 */
export interface TestStepEvent {
  title: string;
  /** The step's target (rendered locator or URL), carried separately by newer Playwright. */
  subtitle?: string | null;
  category: 'hook' | 'fixture' | 'test.step' | 'expect' | 'wait' | 'pause';
  startedAt: number;
  duration: number;
  /** `passed` or `failed`; `wasted` for a wait; for a stop, why it stopped: `breakpoint`, `step` or `page-pause`. */
  status: string;
  location?: string | null;
  /** The first line of the step's error, when it failed — hook and fixture events only. */
  error?: string | null;
  /** The hooks and fixtures a hook section (`Before Hooks`, `After Hooks`) ran, in order. */
  hooks?: TestStepEventHook[] | null;
}

/**
 * A suite-level setup step (beforeAll/afterAll) attached to a test run. Unlike
 * per-test step events it is not tied to a test case, so the reporter records
 * which worker it ran on.
 */
export interface SetupStepEvent extends TestStepEvent {
  workerIndex?: number | null;
}

export interface ServerLogEntry {
  timestamp: number;
  level: string;
  category: string;
  message: string;
  stack?: string;
}

/**
 * A server-side span captured for a request via the `X-Piwi-Trace` header (from
 * a Piwi instrumentation plugin). Mirrors the reporter/plugin `PiwiServerSpan`
 * shape; the root span carries `traceId` and `attrs.http.*`.
 */
export interface ServerSpanEntry {
  id: string;
  parentId?: string;
  name: string;
  kind?: string;
  startMs: number;
  durMs: number;
  status?: string;
  traceId?: string;
  attrs?: Record<string, string | number | boolean>;
}

/**
 * A single network request recorded during test execution (via dashboard fixture)
 */
export interface NetworkRequest {
  method: string;
  url: string;
  status: number;
  duration: number;
  resourceType: string;
  contentType?: string | null;
  startTime?: number;
  serverLogs?: ServerLogEntry[];
  serverTraces?: ServerSpanEntry[];
  /** Why the request failed without a response (`net::ERR_CONNECTION_RESET`); null or absent when it finished. */
  failure?: string | null;
  /** True when no server sent the response: the test's route handler fulfilled it, or a cache or service worker. */
  fulfilled?: boolean | null;
}

/** One frame of the trace-derived full call stack (innermost first). */
export interface TraceStackFrame {
  /** Display path — project-relative when derivable, shortened otherwise. */
  file: string;
  /** Original absolute path from the runner machine, when it differs from `file`. */
  absFile?: string;
  line: number;
  column?: number;
  functionName?: string;
  inProject: boolean;
  /** Window of the embedded source around `line`; null when the trace carries no source for this file. */
  source?: { startLine: number; lines: string[]; totalLines: number } | null;
}

/** `GET /api/test-runs/:id/cases/:caseId/trace-stacks` */
export interface TraceCallStackResponse {
  status: 'ok' | 'no-trace' | 'no-stacks';
  frames?: TraceStackFrame[];
  /** False when the trace was recorded without embedded sources — frames render header-only. */
  hasSources?: boolean;
  /** The action whose stack is shown (normally the failing action). */
  apiName?: string;
  errorMessage?: string;
}

/** One request from the trace's HAR-like network stream (headers masked server-side). */
export interface TraceNetworkEntry {
  index: number;
  method: string;
  url: string;
  /** HTTP status; <= 0 means the request failed or was aborted before a response. */
  status: number;
  statusText?: string;
  failureText?: string;
  resourceType?: string;
  mimeType?: string;
  requestHeaders: Array<{ name: string; value: string }>;
  responseHeaders: Array<{ name: string; value: string }>;
  requestBodySize?: number;
  responseBodySize?: number;
  transferSize?: number;
  /** Milliseconds relative to the first request in the trace. */
  start: number;
  duration: number;
  timings?: { dns?: number; connect?: number; ssl?: number; send?: number; wait?: number; receive?: number };
  /** True when the request overlaps the failing action's time window. */
  duringFailure: boolean;
  failed: boolean;
  /** Content-addressed name of the stored response body, fetchable via the trace-network-body endpoint. */
  bodySha1?: string | null;
  bodyPreviewable?: boolean;
  /** Masked, capped request post data. */
  requestPostData?: string | null;
}

/** `GET /api/test-runs/:id/cases/:caseId/trace-network` */
export interface TraceNetworkResponse {
  status: 'ok' | 'no-trace' | 'empty';
  requests?: TraceNetworkEntry[];
  /** Total waterfall span in ms (relative timeline). */
  timelineDuration?: number;
  /** Failing action's window on the same relative timeline, for shading. */
  failingWindow?: { start: number; end: number } | null;
  truncated?: boolean;
  totalBeforeCap?: number;
}

/** `GET /api/test-runs/:id/cases/:caseId/trace-network-body?sha1=` */
export interface TraceBodyResponse {
  status: 'ok' | 'not-found' | 'too-large' | 'unsupported';
  kind?: 'json' | 'text' | 'image';
  /** Masked, capped textual body (kind json/text). */
  content?: string;
  /** Inline image payload (kind image). */
  dataUri?: string;
  mimeType?: string;
  size?: number;
  truncated?: boolean;
}

/** Whether an action carries a snapshot for each phase, per snapshot kind. */
export interface TraceSnapshotAvailability {
  before: boolean;
  after: boolean;
}

/** One action's per-phase aria and screen snapshot availability, for the Screen tab and filmstrip. */
export interface TraceSnapshotStep {
  /** The action's callId — addresses its snapshot files in the resource endpoint. */
  callId: string;
  /** Position of the action in trace order. */
  index: number;
  /** Display title of the step (the action's api name). */
  title: string;
  /** True when this is the failing action. */
  failed: boolean;
  /** Start time of the action, in the trace's own timebase. */
  startTime: number;
  aria: TraceSnapshotAvailability;
  screen: TraceSnapshotAvailability;
}

/** `GET /api/test-run-cases/:id/trace-snapshots` */
export interface TraceSnapshotsResponse {
  status: 'ok' | 'no-trace' | 'no-snapshots';
  steps: TraceSnapshotStep[];
  /** The failing action's callId, when the trace recorded one. */
  failingCallId: string | null;
  /** Any step carries an aria / screen snapshot — drives the tab's presence. */
  hasAria: boolean;
  hasScreen: boolean;
  /**
   * Structural diff of the failing action's page *before* it ran against the
   * page *at the failure* (its before-phase aria tree vs its after-phase tree).
   * Null when either phase's aria snapshot is missing.
   */
  pageDiff?: { summary: PageDiffSummary; hunks: PageDiffHunk[] } | null;
  /**
   * The accessibility tree at the failing step, as ARIA text (the failing
   * action's after-phase snapshot, else its before-phase). Surfaced on the
   * failing step in the timeline. Null when the failing step recorded no aria.
   */
  failingAriaText?: string | null;
}

/**
 * Browser performance / web vitals recorded via dashboard fixture
 */
export interface WebVitals {
  navigation?: {
    url: string;
    ttfb: number;
    domInteractive: number;
    domContentLoaded: number;
    loadComplete: number;
    transferSize?: number;
    encodedBodySize?: number;
    decodedBodySize?: number;
  } | null;
  paint?: {
    firstPaint?: number;
    firstContentfulPaint?: number;
  } | null;
  /** Core Web Vitals (Chromium-only; null per metric when unavailable). */
  vitals?: {
    lcp?: number | null;
    cls?: number | null;
    inp?: number | null;
  } | null;
}

/**
 * Page state captured at test end by the reporter fixtures. Storage values and
 * cookie values are never captured — key names, lengths and flags only. Focus,
 * hover and a text selection name elements by element path and never carry a
 * value or the selected text (see `#shared/page-interaction`).
 */
export interface PageState extends PageInteraction {
  url: string;
  hash: string | null;
  /** `history.state` as JSON, capped and token-masked. */
  historyState: string | null;
  localStorage: Array<{ key: string; length: number }>;
  sessionStorage: Array<{ key: string; length: number }>;
  cookies: Array<{
    name: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: string;
    expires?: number;
  }>;
}

/**
 * A single console message captured during test execution (via dashboard fixture)
 */
export interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
  location?: string | null;
}

/**
 * Grouped endpoint summary returned by GET /api/test-runs/[id]/network-requests
 */
export interface EndpointSummary {
  method: string;
  route: string;
  count: number;
  avgDuration: number;
  maxDuration: number;
  minDuration: number;
  p90Duration: number;
  errorRate: number;
  /** Earliest request start in the group (Unix epoch ms) — null when no capture carried a start time. */
  firstStartTime: number | null;
  /** Latest request start in the group (Unix epoch ms) — null when no capture carried a start time. */
  lastStartTime: number | null;
  testCases: string[];
}

// ============================================================================
// Test Case types (API responses)
// ============================================================================

/**
 * Suite (describe block) info — returned as a flat list alongside test cases,
 * one entry per unique describe path across all files in the run.
 */
export interface SuiteInfo {
  filePath: string;
  suitePath: string[];
  mode: string;
  annotations: Array<{ type: string; description?: string }>;
}

/**
 * One AI-step intent mapping: the natural-language prompt a replayed locator
 * was compiled from (`page.piwiLocator` / a `page.piwiRun` step).
 */
export interface AiStepIntent {
  template: string;
  locator: string;
  kind: 'locator' | 'run';
}

/**
 * Test case result (for a specific test run)
 */
/**
 * One attempt of a test within a run. Every attempt is its own execution row;
 * `executionId` is that sibling row's id (null when the row is not stored,
 * e.g. rows recorded before attempts were kept).
 */
export interface AttemptOutcome {
  retry: number;
  status: string;
  duration: number;
  startedAt: number | null;
  executionId?: number | null;
}

export interface TestCaseResult {
  /** The execution id (a test_runs_cases row): this test case run within this run. */
  executionId: number;
  /** The stable test-case identity, shared across every run of this test. */
  testCaseId: number;
  title: string;
  /** The ID the test has in the team's test management tool (`piwi:id`, or read from its title). */
  externalId?: string | null;
  /** The title without its external ID, when the reporter removed it; `title` stays whole. */
  displayTitle?: string | null;
  filePath?: string;
  suitePath?: string[];
  testAnnotations?: Array<{ type: string; description?: string }> | null;
  /** Tags declared on the test, normalized with `@` stripped. */
  tags?: string[] | null;
  /** Lock names this execution held (best effort; none from blob imports). */
  locks?: string[] | null;
  /** Ownership metadata from `piwi:` annotations. */
  testMeta?: TestMetadata | null;
  status: string;
  duration?: number | null;
  location?: string;
  error?: string | null;
  testSource?: string | null;
  testSourceFrames?: TestSourceFrame[] | null;
  failureClusterId?: number | null;
  retries?: number | null;
  /** Playwright's `repeatEachIndex`: which `--repeat-each` repetition this execution belongs to, 0 without repeats. */
  repeatEachIndex?: number;
  /** Per-attempt outcomes, oldest first. */
  attempts?: AttemptOutcome[] | null;
  steps?: PerformanceStep[] | null;
  stepEvents?: TestStepEvent[] | null;
  slowestStep?: string | null;
  slowestStepDuration?: number | null;
  wastedTimeMs?: number | null;
  networkRequests?: NetworkRequest[] | null;
  webVitals?: WebVitals | null;
  /** What the test cost its worker and browser processes, and what it found open or left open. */
  resources?: WireExecutionResources | null;
  /** AI-step usage manifest: replayed artifacts + the prompts their locators compile from. */
  aiUsage?: { entries: string[]; intents?: AiStepIntent[] } | null;
  consoleLogs?: ConsoleEntry[] | null;
  ariaSnapshot?: string | null;
  workerIndex?: number | null;
  shardIndex?: number | null;
  startedAt?: number;
  browser?: {
    projectName?: string;
    browserName?: string | null;
    channel?: string | null;
    viewport?: { width: number; height: number } | null;
  } | null;
  links?: EntityLinkInfo[];
  isNewRegression?: boolean | null;
  isNewFlaky?: boolean | null;
  /** Why a `didnotrun` case never executed; null for tests that ran. */
  didNotRunReason?: DidNotRunReason | null;
  /** Playwright's expected status: `failed` for a `test.fail()` test. */
  expectedStatus?: string | null;
  /** For a `previous-failure` cascade, the location of the failing test that blocked it. */
  blockedBy?: string | null;
}

/** Why a `didnotrun` case never executed — mirrors the reporter's taxonomy. */
export type DidNotRunReason = 'previous-failure' | 'global-timeout' | 'max-failures' | 'interrupted';

/** A lightweight reference to another execution in the same run (cause ↔ effect linking). */
export interface BlockedCaseRef {
  /** `test_runs_cases.id` — deep-links to that execution. */
  id: number;
  title: string;
  location: string;
  status: string;
  /**
   * On the execution that blocked this one: the hook or fixture its failure
   * happened in (a failing `beforeAll` skips the rest of its group), or null.
   */
  failedIn?: import('#shared/step-tree').FailureHookContext | null;
}

/**
 * One affected test case inside a failure group — part of GET /api/test-runs/[id]/failure-groups
 */
export interface FailureGroupCase {
  testRunsCaseId: number;
  testCaseId: number;
  title: string;
  filePath: string;
  retries: number;
  workerIndex: number | null;
  passedOnRetry: boolean;
}

/**
 * Failure group summary for a test run — returned by GET /api/test-runs/[id]/failure-groups
 */
export interface FailureGroup {
  clusterId: number;
  signature: string;
  title: string | null;
  errorType: string | null;
  selector: string | null;
  status: string;
  triageNote: string | null;
  caseCount: number;
  isNew: boolean;
  firstSeenRunId: number;
  firstSeenAt: string | null;
  occurrences: number;
  flaky: boolean;
  workerCorrelated: boolean;
  cases: FailureGroupCase[];
  diagnosis: DiagnosisCompact | null;
  /**
   * Present when this group's representative failure has a healable locator —
   * the panel on the cluster page can apply it. `healed` when the recommended
   * locator already passes at that call site in a later run.
   */
  locatorHealing?: { recommended: string; source: string; healed: boolean } | null;
  /** The tracker issue the cluster is known by, when one is linked or was created for it. */
  knownIssue?: KnownIssueRef | null;
}

/**
 * Per-cluster facts a run's test rows show next to a failing execution: the
 * cluster's name, its triage status and the issue it is tracked in.
 */
export type RunClusterMeta = Record<number, { name: string; status: string | null; issue?: KnownIssueRef | null }>;

/**
 * What a landed fix was corroborated against.
 *
 * `diagnosis-verified` is the strong verdict — the change touched the files the
 * diagnosis named. `stopped-failing` only says the tests went green, which is
 * the common and weaker case. `regressed` means the recorded fix did not hold.
 */
export type FixVerification = 'stopped-failing' | 'diagnosis-verified' | 'regressed';

/**
 * The resolution a cluster carries once a fix has landed. Every field is null
 * until then, so a cluster nobody has fixed simply omits the whole block.
 */
export interface ClusterResolutionFields {
  fixLandedRunId: number | null;
  fixLandedAt: string | Date | null;
  fixCommit: string | null;
  timeToResolutionMs: number | null;
  fixVerification: FixVerification | null;
  /** The latest run in which every affected test passed at the commit the cluster last failed at: flake evidence, not a fix. */
  flakeEvidenceRunId?: number | null;
}

/**
 * Full failure cluster — returned by GET /api/failure-clusters/[id]
 */
export interface FailureClusterDetail extends ClusterResolutionFields {
  id: number;
  projectId: number;
  fingerprint: string;
  signature: string;
  title: string | null;
  errorType: string | null;
  selector: string | null;
  sampleError: string | null;
  status: string;
  triageNote: string | null;
  firstSeenRunId: number;
  lastSeenRunId: number;
  firstSeenAt: string | Date | null;
  occurrences: number;
  affectedTests: number;
  lastSeenRunStatus: string | null;
  lastSeenAt: string | Date | null;
  /** The execution in the last-seen run — the cluster's latest occurrence, or null when none loads. */
  latestTestRunsCaseId: number | null;
  /** The test case that latest occurrence belongs to. */
  latestTestCaseId: number | null;
  /** The latest occurrence's headline, the page's heading when it says more than the cluster's name. */
  latestHeadline: ClusterLatestHeadline | null;
  diagnosis: DiagnosisCompact | null;
  project: { id: number; name: string; label: string | null; externalIdUrl?: string | null } | null;
  affectedTestCases: Array<{
    testCaseId: number;
    title: string;
    externalId?: string | null;
    displayTitle?: string | null;
    filePath: string;
    /** The describe blocks around the test, outermost first. */
    suitePath: string[];
    /** The test's `piwi:owner` annotation, when it declares one. */
    owner?: string | null;
    runCount: number;
    recentTestRunsCaseId: number;
    quarantined: boolean;
  }>;
  /** Known-issue links pinned to this cluster (Jira / GitHub issue, etc.). */
  links: EntityLinkInfo[];
  /** The cluster's known issue: its newest tracker link. Every surface names this one. */
  knownIssue: KnownIssueRef | null;
  /** An issue filing for this cluster waits on the tracker; the outbox retries it. */
  issueFilingQueued: boolean;
  /** The cluster's newest issue filing failed for good, with the tracker's reason; filing again replaces it. */
  issueFilingFailure: IssueFilingFailure | null;
  /** Effective owner of the cluster's tests: `piwi:owner` annotation or CODEOWNERS. */
  owner: { name: string; source: 'annotation' | 'codeowners' } | null;
  /** Inbox triage: assignee (overrides the owner) and snooze state. */
  assignee: string | null;
  snoozedUntil: string | Date | null;
  snoozeMode: string | null;
  /**
   * The failure goes on: the cluster was last seen in the project's latest finished
   * run or a later one. A Done issue then calls for a new one.
   */
  failureGoesOn: boolean;
  /** One sentence with one verb for the cluster's state, and the control that changes it. */
  clusterState: ClusterState;
  /** Occurrences per run over the project's last 20 runs, oldest first. */
  occurrenceSeries: OccurrenceSeriesPoint[];
  /** The single next step chosen by the policy. */
  nextStep: NextStep;
}

/**
 * Failure cluster summary for a project page — returned by GET /api/projects/[id]/failure-clusters
 */
export interface ProjectFailureCluster extends ClusterResolutionFields {
  id: number;
  fingerprint: string;
  signature: string;
  title: string | null;
  errorType: string | null;
  selector: string | null;
  sampleError: string | null;
  status: string;
  triageNote: string | null;
  firstSeenRunId: number;
  lastSeenRunId: number;
  occurrences: number;
  affectedTests: number;
  lastSeenRunStatus: string | null;
  lastSeenAt: string | Date | null;
  diagnosis: DiagnosisCompact | null;
  /** The pinned known-issue link (newest), shown as a chip. */
  issueLink: { url: string; provider: string; key: string | null } | null;
  /** Inbox triage — assignee and snooze state. A snoozed open cluster is not failing now. */
  assignee: string | null;
  snoozedUntil: string | Date | null;
  snoozeMode: string | null;
}

/**
 * Test case with statistics - one item of GET /api/projects/[id]/test-cases.
 * `failedRuns` includes timed-out runs; `status` is the derived category the
 * status filter operates on (flaky wins over the last run's status, timeouts
 * count as failed, `never-run` when the case has no executions). `passRate`
 * is over executed runs only (0..1), null when nothing executed.
 */
export interface TestCaseWithStats {
  id: number;
  filePath: string;
  suitePath: string;
  title: string;
  /** The ID the test has in the team's test management tool. */
  externalId?: string | null;
  /** The title without its external ID, when the reporter removed it. */
  displayTitle?: string | null;
  /** Latest-known tags and `piwi:` metadata declared on the test. */
  tags: string[] | null;
  /** Latest-known lock names declared on the test (best effort). */
  locks: string[] | null;
  owner: string | null;
  priority: string | null;
  feature: string | null;
  link: string | null;
  status: string;
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  skippedRuns: number;
  /** Runs skipped by `test.fixme()` — a subset of `skippedRuns`. */
  fixmeRuns?: number;
  didNotRunRuns: number;
  flakyRuns: number;
  recentFlakyRuns?: number;
  passRate: number | null;
  avgDuration: number | null;
  lastRun: number | null;
  lastStatus: string | null;
  /** Where the test is declared, as its latest execution reported it; null before it ever ran. */
  line: number | null;
  column: number | null;
}

/**
 * Paginated envelope returned by GET /api/projects/[id]/test-cases
 */
export interface TestCasesPage {
  items: TestCaseWithStats[];
  total: number;
  limit: number;
  offset: number;
}

// ============================================================================
// Authentication types
// ============================================================================

/**
 * Authenticated user, as `GET /api/auth/me` and `POST /api/auth/login` return it
 */
export interface AuthUser {
  id: number;
  username: string;
  role: InstanceRole;
  name?: string | null;
  avatarUrl?: string | null;
  /** The instance role and the project roles held, own and through groups; `can()` in `#shared/permissions` reads it. */
  access: AccessSummary;
}

/**
 * Authentication state
 */
export interface AuthState {
  authenticated: boolean;
  user: AuthUser | null;
}

// ============================================================================
// API key types
// ============================================================================

/**
 * API key summary (key hash/plaintext is never returned after creation)
 */
export interface ApiKeySummary {
  id: number;
  name: string;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt?: Date | null;
  expiresAt?: Date | null;
  /** The connection of an MCP client that signed in through OAuth: there is no key value to use. */
  oauth: boolean;
}

/**
 * Response from GET /api/users/[id]/api-keys
 */
export interface ApiKeysResponse {
  items: ApiKeySummary[];
}

/**
 * Response from POST /api/users/[id]/api-keys – key is shown ONCE
 */
export interface CreateApiKeyResponse {
  key: string;
  prefix: string;
  name: string;
}

// ============================================================================
// Admin types
// ============================================================================

/**
 * Storage statistics returned by GET /api/admin/stats
 */
export interface AdminStats {
  totalProjects: number;
  totalRuns: number;
  totalTestCases: number;
  totalRunsCases: number;
  totalFiles: number;
  totalFileSize: number;
  storageSizeOnDisk: number | null;
  /** Where the database lives: a resolved SQLite file path, or a label for PostgreSQL. */
  databaseLocation: string;
  /** Where files live: a resolved local storage path, or a label for S3. */
  storageLocation: string;
}

/**
 * The evidence families a stored file belongs to, for the storage dashboard.
 * Trace bytes fold in the deduplicated blobs and their shared trace resources.
 */
export type StorageKind = 'trace' | 'screenshot' | 'video' | 'report' | 'attachment' | 'visual-diff';

/** Storage consumed by one evidence family. */
export interface StorageKindUsage {
  kind: StorageKind;
  bytes: number;
  files: number;
}

/** Storage consumed by one project. */
export interface StorageProjectUsage {
  projectId: number;
  name: string;
  label: string | null;
  bytes: number;
  files: number;
}

/** One time bucket in the storage-growth series. */
export interface StorageTimeBucket {
  /** Bucket start, ISO `YYYY-MM-DD` (UTC). */
  date: string;
  /** Bytes first stored within this bucket. */
  bytes: number;
  /** Running total of stored bytes through the end of this bucket. */
  cumulativeBytes: number;
}

/** The computed part of the storage analysis (shared by server + demo). */
export interface StorageAnalysisData {
  /** True physical footprint: non-deduplicated files + trace blobs + trace resources. */
  totalBytes: number;
  /** Number of `files` rows (logical evidence files). */
  totalFiles: number;
  /** Projects that hold any stored bytes. */
  projectCount: number;
  /** Usage per evidence family, largest first. */
  byKind: StorageKindUsage[];
  /** Usage per project, largest first. */
  byProject: StorageProjectUsage[];
  /** Storage growth over the lifetime of the retained data. */
  overTime: StorageTimeBucket[];
  /** Width of each `overTime` bucket, in days. */
  bucketDays: number;
  /**
   * Runs kept forever (never pruned by retention) and the files they hold.
   * `bytes` counts their own files only — a deduplicated trace is shared, so
   * it is not attributed to any one run.
   */
  kept: { runs: number; files: number; bytes: number };
  /** When the analysis was computed (ISO). */
  generatedAt: string;
}

/**
 * Storage analysis returned by GET /api/admin/storage — the computed breakdown
 * plus the physical location labels and, for local storage, the measured
 * on-disk size (which can exceed `totalBytes` when untracked files linger).
 */
export interface StorageAnalysis extends StorageAnalysisData {
  storageSizeOnDisk: number | null;
  /** Where the database lives: a resolved SQLite file path, or a label for PostgreSQL. */
  databaseLocation: string;
  /** Where files live: a resolved local storage path, or a label for S3. */
  storageLocation: string;
}

// ============================================================================
// Performance API response types
// ============================================================================

/**
 * Performance trend data point - returned by GET /api/projects/[id]/performance
 */
export interface PerformanceTrendPoint {
  id: number;
  startTime: string | Date;
  duration?: number | null;
  avgTestDuration?: number | null;
  p90TestDuration?: number | null;
  status: string;
  totalTests: number;
  commit?: string | null;
  branch?: string | null;
  isFullRun?: boolean;
}

/**
 * Test case history point - returned by GET /api/test-cases/[id]/history
 */
export interface TestCaseHistoryPoint {
  id: number;
  runId: number;
  status: string;
  duration: number | null;
  error: string | null;
  retries: number | null;
  /** Per-attempt outcomes, oldest first. */
  attempts?: AttemptOutcome[] | null;
  startTime: string | Date;
  runStatus: string;
}

/**
 * Trace file attached to a test case result
 */
export interface TraceInfo {
  id: number;
  filePath: string;
  createdAt: Date;
  size?: number | null;
}

/**
 * Attachment file (screenshot, video, custom) attached to a test case result
 */
export interface AttachmentInfo {
  id: number;
  name: string | null;
  contentType: string | null;
  path: string;
  size: number | null;
}

/**
 * Slow test entry - returned by GET /api/projects/[id]/slow-tests
 */
export interface SlowTest {
  id: number;
  title: string;
  filePath: string;
  avgDuration: number;
  maxDuration: number;
  minDuration: number;
  runCount: number;
  trend: 'faster' | 'slower' | 'stable';
  latestDuration: number;
}

// ============================================================================
// AI Diagnosis types (Pillar 4)
// ============================================================================

/**
 * Compact diagnosis summary — inlined in failure-groups and failure-clusters responses
 */
export interface DiagnosisCompact {
  status: string;
  category: string | null;
  confidence: string | null;
  summary: string | null;
  /** `agent` when an agent wrote it; otherwise the AI provider. */
  provider?: string | null;
}

/**
 * One rendered evidence section of the AI diagnosis context (a lens over what
 * will be sent to the model). Shared by the context modal, the cluster diagnosis
 * store and the demo context builder.
 */
export interface ContextSection {
  id: string;
  title: string;
  chars: number;
  truncated: boolean;
  markdown: string;
  items?: number;
}

/**
 * SCM coverage metadata returned alongside the diagnosis context preview.
 * null means the regression context block was never reached (DB error or no lastSeenRun).
 */
export interface DiagnosisContextCoverage {
  scm: {
    hasLastGreen: boolean;
    hasCommitRange: boolean;
    /** Set when the user manually overrode the baseline commit SHA */
    baseCommitUsed: string | null;
    provider: ScmProviderName | null;
    commitsCount: number;
    filesCount: number;
    patchedFilesCount: number;
    patchesOmitted: boolean;
    patchesTruncated: boolean;
    /** What established the baseline commit: project-wide green run, per-test last-pass, or manual override. */
    baselineKind?: 'run-green' | 'test-green' | 'manual';
    /** Error message when the SCM diff fetch failed. */
    error?: string | null;
    /** The repository the runs point at, when they record one. */
    repositoryUrl?: string | null;
    /** The commit range compared, as short SHAs, when both ends are known. */
    range?: { from: string; to: string } | null;
    /** The range on the Git host's own compare page, when the host is one Piwi knows. */
    compareUrl?: string | null;
    /** The local command that lists the range. */
    gitCommand?: string | null;
    /** Whether a repository access token is set for the project or the instance. */
    hasToken?: boolean;
    /** The commits were read with git in the folder the desktop app links to the project, not from the host. */
    localGit?: boolean;
  } | null;
  /** True when the last passing run is newer than the cluster's lastSeen — test may already be fixed. */
  alreadyGreen?: boolean;
  /** Locator healing alternatives for the failing locator. null when not a locator failure or no snapshot data. */
  locatorHealing?: {
    source: import('#shared/locator-healing.types').LocatorHealingSource;
    alternativesCount: number;
  } | null;
  /** Full source files fetched to ground the diagnosis (suspect changed files + test imports). */
  sourceFiles?: {
    count: number;
    /** Repo-relative paths of the fetched files. */
    paths: string[];
    /** true when at least one file was truncated to the size cap. */
    truncated: boolean;
  } | null;
  /** Environment diff vs the last passing execution. null when no passing baseline exists. */
  environmentDiff?: {
    changedKeys: number;
    baselineRunId: number | null;
  } | null;
  /** Visual screenshot diff vs the last passing execution. null when no comparable screenshots exist. */
  visualDiff?: {
    changedPixelRatio: number;
    dimensionMismatch: boolean;
  } | null;
  /** Failure-time DOM snapshot rendered from the stored trace. null when no trace or no snapshot. */
  domSnapshot?: {
    chars: number;
    snapshotName?: string;
  } | null;
  /** Full call stack of the failing action from the trace's stacks index. null when no trace/stacks. */
  traceCallStack?: {
    frames: number;
    framesWithSource: number;
  } | null;
  /** Network activity parsed from the trace's HAR-like stream. null when no trace or no entries. */
  traceNetwork?: {
    requests: number;
    failed: number;
  } | null;
  /** App state (URL/storage keys/cookie flags) at test end. null when not captured. */
  appState?: {
    hasBaseline: boolean;
  } | null;
  /**
   * The changed lines the failing tests executed (suspect lines) the context carried: how many suspects it
   * listed, of how many changed lines and how many of them the failing tests executed at line granularity.
   * null when the cluster has none to join (no coverage, no diff).
   */
  suspectLines?: {
    suspects: number;
    changedLines: number;
    executedLines: number;
  } | null;
  /**
   * The code the execution ran that the test's last passing execution with coverage did not, and the reverse:
   * the baseline execution and the counts the context carried. null when there is nothing to compare.
   */
  coverageDivergence?: {
    baselineExecutionId: number;
    filesOnlyHere: number;
    linesOnlyHere: number;
    filesOnlyBaseline: number;
    linesOnlyBaseline: number;
  } | null;
  /** Sections where data is not applicable (with reason), keyed by section id. Absent in coverage means "no data". */
  notApplicable?: Record<string, string>;
}

// Suspect lines: `GET /api/test-run-cases/:id/suspect-lines` and `GET /api/failure-clusters/:id/suspect-lines`.
// The shapes live in `#shared/suspect-lines`, shared with the server, the demo mirror and the fix plan.
export type { ClusterSuspectLinesAnswer } from '#shared/suspect-lines';

/**
 * A commit as returned by the failure-cluster commit-list endpoints and rendered
 * by the commit picker / browser. Shared so those components don't each redeclare it.
 */
export interface CommitListItem {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
}

/**
 * Changed file returned in SCM diff — mirrors ScmProvider.ChangedFile
 */
export interface ScmChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  /** The git blob id of the file at the head commit, where the host gives it. */
  blob?: string;
}

/**
 * Structured SCM changes returned alongside the context preview
 */
export interface ScmChanges {
  commits: { sha: string; message: string }[];
  files: ScmChangedFile[];
  patchesOmitted?: boolean;
}

/**
 * Supported AI provider identifiers.
 * - `anthropic` — the Anthropic API (needs an API key).
 * - `openai` — any OpenAI-compatible HTTP endpoint (OpenAI, OpenRouter, Groq, Ollama, LM Studio, …).
 * - `claude-cli` — the locally-installed `claude` CLI (Claude Code). Desktop app only: the
 *   bundled server shells out to `claude -p --output-format json`, so authentication is the CLI's
 *   own subscription/OAuth login and no API key is stored.
 */
export type AiProvider = 'anthropic' | 'openai' | 'claude-cli' | 'codex-cli' | 'deepseek-cli';

/** Local Codex CLI health, ChatGPT authentication and usage since server startup. */
export interface CodexCliStatus {
  available: boolean;
  binaryPath: string | null;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
  error: string | null;
  usage: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    since: string | null;
  };
}

/**
 * Health + authentication state of the local `claude` CLI, returned by
 * GET /api/ai/claude-cli/status. Only meaningful inside the desktop app.
 */
export interface ClaudeCliStatus {
  /** True when the desktop app is running and may shell out to the CLI at all. */
  desktop: boolean;
  /** True when the `claude` binary was found and is runnable. */
  available: boolean;
  /** Resolved absolute path to the binary, when found. */
  binaryPath: string | null;
  /** CLI version string (e.g. "2.1.270"), when detectable. */
  version: string | null;
  /** True when `claude auth status` reports a signed-in account. */
  loggedIn: boolean;
  /** How the CLI is authenticated: "oauth_token", "api_key", … */
  authMethod: string | null;
  /** The API provider the CLI talks to: "firstParty", "bedrock", "vertex". */
  apiProvider: string | null;
  /** A human-readable problem when the CLI is missing or misconfigured. */
  error: string | null;
  /** Running usage totals since the server started (live, not persisted). */
  usage: ClaudeCliUsageTotals;
}

/** In-memory usage tally for CLI calls since the server started. Resets on restart. */
export interface ClaudeCliUsageTotals {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /** ISO timestamp the tally started (server start / first call). */
  since: string | null;
}

/**
 * Model metadata returned by the provider's models endpoint.
 * Shared between the server models endpoint and frontend model picker UI.
 */
export interface ModelInfo {
  id: string;
  label?: string;
  ownedBy?: string;
  contextLength?: number;
  maxTokens?: number;
  description?: string;
  pricing?: { prompt?: string; completion?: string };
  modalities?: string[];
}

/**
 * The distinct model "slots" Piwi can call. Each role has its own complete
 * provider configuration (or reuses another role's credentials):
 * - `diagnosis`  — the main model that writes the final diagnosis (required root)
 * - `research`   — optional cheaper/faster pre-analysis pass (two-stage diagnosis)
 * - `embedding`  — optional embeddings model for semantic failure clustering
 * - `assistant`  — optional model the in-app assistant answers with; the diagnosis model when unset
 */
export type AiModelRole = 'diagnosis' | 'research' | 'embedding' | 'assistant';

/** A fully-resolved provider config for a single role (server-side; holds the raw key). */
export interface ResolvedAiRole {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string | null;
  /** OpenAI-compat only: sampling temperature. Omitted from the request when null (provider default applies) — reasoning models (o1/o3/GPT-5-class) reject any explicit value. */
  temperature: number | null;
}

/**
 * Runtime AI configuration — built from env vars or DB settings.
 * Contains the raw API key; never sent to the client.
 * AiSettings is the client-facing equivalent (hasApiKey + envManaged instead).
 *
 * The top-level `provider`/`apiKey`/`model`/`baseUrl` fields mirror the
 * `diagnosis` role for back-compat with callers that take an AiConfig directly.
 */
export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string | null;
  temperature: number | null;
  autoDiagnose: boolean;
  source: 'env' | 'settings';
  /** Per-role resolved configs. `diagnosis` is always present; others are null when unconfigured. */
  roles: {
    diagnosis: ResolvedAiRole;
    research: ResolvedAiRole | null;
    embedding: ResolvedAiRole | null;
    assistant: ResolvedAiRole | null;
  };
}

/**
 * AI status — returned by GET /api/ai/status
 */
export interface AiStatus {
  configured: boolean;
  provider?: AiProvider | null;
  model?: string | null;
  autoDiagnose?: boolean;
  source?: string | null;
}

/**
 * Client-facing config for one model role (no raw secret — only `hasApiKey`).
 * A role with `reuse` set inherits its provider/key/baseUrl from another role.
 */
export interface AiRoleSettings {
  provider: AiProvider | null;
  model: string | null;
  baseUrl: string | null;
  reuse: AiModelRole | null;
  hasApiKey: boolean;
  /** OpenAI-compat only: sampling temperature override, or null for the provider default. */
  temperature: number | null;
}

/**
 * AI settings — returned by GET /api/settings/ai.
 * Each model role carries a complete (or reused) provider config.
 */
export interface AiSettings {
  roles: {
    diagnosis: AiRoleSettings | null;
    research: AiRoleSettings | null;
    embedding: AiRoleSettings | null;
    assistant: AiRoleSettings | null;
  };
  autoDiagnose: boolean;
  hasScmToken: boolean;
  envManaged: boolean;
  customInstructions: string | null;
  /** The AI response language ("French", "Japanese", …); null keeps English prose. */
  language: string | null;
  /** True when the language is fixed by `PIWI_AI_LANGUAGE` (rendered locked). */
  languageEnvManaged: boolean;
  /** False when `PIWI_SECRET_KEY` is unset, so an API key or SCM token cannot be saved. */
  canStoreSecrets: boolean;
  /** True when this server may run the local Claude Code CLI: the desktop app, or `PIWI_CLAUDE_CLI_PATH` set. */
  claudeCliAvailable: boolean;
  /** Whether this server is allowed to run the local Codex CLI. */
  codexCliAvailable: boolean;
  /** Whether this server may run official DeepSeek Harness. */
  deepseekCliAvailable: boolean;
}

// ============================================================================
// AI Settings request body types
// ============================================================================

/**
 * One role config as submitted by the client (apiKey is plaintext or omitted).
 */
export interface AiRoleConfigInput {
  provider?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  reuse?: AiModelRole | null;
  /** OpenAI-compat only: sampling temperature override, or null/omitted for the provider default. */
  temperature?: number | null;
}

/**
 * Request body for PUT /api/settings/ai
 */
export interface SaveAiSettingsBody {
  roles?: Partial<Record<AiModelRole, AiRoleConfigInput | null>> | null;
  autoDiagnose?: boolean;
  customInstructions?: string | null;
  scmToken?: string | null;
  /** The instance-wide AI response language; ignored when env-managed. */
  language?: string | null;
}

/**
 * Aggregated AI token usage for one provider + model pair.
 */
export interface AiUsageModelRow {
  provider: string | null;
  model: string;
  diagnoses: number;
  failed: number;
  /** Assistant answers (turns), counted apart from diagnoses; their tokens are in `inputTokens` and `outputTokens`. */
  assistantTurns: number;
  inputTokens: number;
  outputTokens: number;
  avgDurationMs: number | null;
  /** Completed diagnoses rated helpful, and rated at all (helpful or unhelpful). */
  helpful: number;
  rated: number;
  /** Suggested patches checked against the source files, and those that apply. */
  patchesChecked: number;
  patchesApplying: number;
  /** Diagnoses a fix confirmed in the window (it changed the diagnosed files), and those whose cause failed again. */
  verified: number;
  regressed: number;
}

/**
 * AI usage summary — returned by GET /api/settings/ai/usage
 */
export interface AiUsageSummary {
  days: number;
  /** The fewest ratings a helpful share is given over. */
  minRatings: number;
  totals: { diagnoses: number; assistantTurns: number; inputTokens: number; outputTokens: number };
  byModel: AiUsageModelRow[];
}

// ============================================================================
// Entity Link types (A.4)
// ============================================================================

/**
 * Entity link — attach an external URL to a run, test-case run, or test case.
 * API response type, mirrors the DB row minus internal-only fields.
 */
export interface EntityLinkInfo {
  id: number;
  testRunId?: number | null;
  testRunsCaseId?: number | null;
  testCaseId?: number | null;
  url: string;
  provider: string;
  key?: string | null;
  title?: string | null;
  statusText?: string | null;
  statusColor?: string | null;
  unfurledAt?: string | Date | null;
  /** The connection that can read/write this record, when Piwi owns it. */
  connectionId?: number | null;
  externalId?: string | null;
  /** Who put the link there: pinned by a person, created by Piwi, etc. */
  origin?: string | null;
  createdBy?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Flaky tests types (Pillar 3)
// ============================================================================

/**
 * Flaky test entry — returned by GET /api/projects/[id]/flaky-tests
 */
export interface FlakyTest {
  testCaseId: number;
  latestRunsCaseId: number;
  title: string;
  /** The ID the test has in the team's test management tool. */
  externalId?: string | null;
  /** The title without its external ID, when the reporter removed it. */
  displayTitle?: string | null;
  filePath: string;
  totalRuns: number;
  failedRuns: number;
  retryPassRuns: number;
  alternations: number;
  failureRate: number;
  score: number;
  lastFlakeAt: string | Date | null;
  rootCause: string | null;
  /** Tags declared on the test, `@` stripped. */
  tags?: string[] | null;
  /** Effective owner — the `piwi:owner` annotation, else CODEOWNERS. */
  owner?: string | null;
  /** Which of the two the owner came from, or null when nothing owns it. */
  ownerSource?: 'annotation' | 'codeowners' | null;
  priority?: string | null;
  impact: number;
  wastedCiMinutes: number;
  avgFailedDurationMs: number;
}

/** A flaky test a Flake Lab verified fix took off the ranking, until it retry-passes again. */
export interface VerifiedFixedFlakyTest {
  testCaseId: number;
  title: string;
  filePath: string;
  retryPassRuns: number;
  lastFlakeAt: string | Date | null;
  verifiedFix: {
    testCaseId: number;
    experimentId: number;
    commit: string | null;
    verifiedAt: string;
    flakedAgainAt: string | null;
  };
}

/** A page diff between a failing execution and its last green sample. */
export interface PageDiff {
  status: 'ok' | 'no-failure-snapshot' | 'no-green-sample' | 'not-applicable' | 'not-found';
  baseline?: {
    executionId: number;
    runId: number;
    at: number | null;
    commit: string | null;
    branch: string | null;
    environment: string | null;
  };
  baselineNote?: string | null;
  summary?: import('#shared/page-diff').PageDiffSummary;
  hunks?: import('#shared/page-diff').PageDiffHunk[];
}

/**
 * The JSON response type of a server route handler, as the client receives it
 * (dates serialized to strings): `ApiResponse<typeof import('~~/server/api/version.get').default>`.
 * The app's `$fetch` and `useFetch` carry no route map (see the `types:extend`
 * hook in `nuxt.config.ts`), so a call site names its response type, with this
 * helper or with a type from this file.
 */
export type ApiResponse<H extends (...args: any[]) => unknown> = Simplify<Serialize<Awaited<ReturnType<H>>>>;
