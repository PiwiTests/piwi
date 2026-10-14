/**
 * Type declarations for the demo failure-story fixture module.
 * See `failure-stories.mjs` for the data itself.
 */
import type { PageInteraction } from '#shared/page-interaction';

export interface StoryFrame {
  file: string;
  line: number;
  column: number;
  fn?: string;
}

/** One step a test ran, as Playwright reports it, with its typical duration in ms. */
export interface StoryStep {
  title: string;
  category: string;
  subtitle?: string;
  params?: Record<string, string>;
  /** Project-relative `file:line:col` of the call. */
  location?: string;
  duration?: number;
  /** The hook that runs the step; absent for a step of the test body. */
  hook?: 'beforeEach';
}

/** The call a failing case failed on, as its step, and whose timeout its error reports. */
export interface FailingCall extends StoryStep {
  /** The innermost frame of the error. */
  location: string;
  timeoutMs: number | null;
  /** The test's, the action's or the expect's timeout; null when the call failed without one. */
  timeout: 'test' | 'action' | 'expect' | null;
}

export interface FailingCase {
  title: string;
  failingLine: number;
  column: number;
  /** Innermost first — mirrors the reporter's collectSourceFrames order. */
  frames: StoryFrame[];
  /** Full reporter-format error text (message head, call log, at-frames). */
  error: string;
  call: FailingCall;
  /** The steps the test ran before the failing call, in order, when the story authors them. */
  before?: StoryStep[];
}

/** A stored step placed in its execution: `at` is ms from the test start. */
export interface PlacedStoryStep extends StoryStep {
  duration: number;
  at: number;
  failed?: boolean;
  error?: { message: string };
}

export interface StoryConsoleEntry {
  type: string;
  text: string;
  location: string | null;
  /** Logged this long after the story's slow request started, in ms. */
  intoSlowRequestMs?: number;
}

export interface StoryNetworkRequest {
  method: string;
  url: string;
  status: number;
  duration: number;
  resourceType: string;
  contentType?: string;
  /** For a story's slow request: how far into the failing step it starts, in ms. */
  intoStepMs?: number;
  serverLogs?: Array<{ timestamp: number; level: string; category: string; message: string; stack?: string }>;
}

export interface StoryDialog {
  type: string;
  message: string;
  defaultValue?: string | null;
}

export interface StoryEvidence {
  consoleOnFail?: StoryConsoleEntry[];
  failingNetwork?: StoryNetworkRequest[];
  /** Requests the project's passing runs send that the failure stops short of. */
  unreachedNetwork?: Array<{ method: string; url: string }>;
  /** A browser dialog left open at the failure moment. */
  dialogOnFail?: StoryDialog;
  /** localStorage keys missing from the failing page state (vs the passing template). */
  pageStateDropKeys?: string[];
  /** What the page was doing at the failure (focus, hover…), merged into the failing executions' page state. */
  pageInteraction?: PageInteraction;
  /** Crash stories: the page is gone — no console/aria/page-state/web-vitals at all. */
  noPageArtifacts?: boolean;
}

export interface StoryDiagnosis {
  seeded: boolean;
  kind: string;
  area: string;
  fix: { description: string; file: string; patch: string };
}

export interface StoryMedia {
  screenshot?: string;
  trace?: string;
  video?: string;
  visualDiffBaseline?: string;
}

export interface StoryFiring {
  /** Run index (newest = 0) at which the story started firing. */
  startAgo: number;
  /** Chance the story fires on an eligible run (deterministic PRNG). */
  chance: number;
  /** Only fire on runs whose browser config has this colorScheme. */
  requiresColorScheme?: string;
}

export interface StoryDomSnapshot {
  /** The recorded page viewport, for the picker's proportion-preserving zoom. */
  viewport: { width: number; height: number };
  /** Self-contained full-page HTML, served as if extracted from the case's trace. */
  html: string;
}

/**
 * A server file of a story's coverage, at line granularity, in the shape of
 * `@piwitests/core/coverage`: the git blob of the version its line numbers
 * refer to, the functions that ran and the executed lines.
 */
export interface StoryServerCoverage {
  path: string;
  runtime: 'server';
  blob: string;
  functions: Array<[number, number]>;
  lines: Array<[number, number]>;
}

/** A file of a story's coverage: a browser file at file granularity, by its path, or a server file. */
export type StoryCoverageFile = string | StoryServerCoverage;

/**
 * The coverage of the newest run the story fails in, per test: the files each
 * test of a spec file ran, keyed by the spec file, and the files one test ran,
 * keyed `<spec file> › <title>`. Browser files are recorded in Chromium only.
 * A test with no entry records none.
 */
export type StoryCoverage = Record<string, StoryCoverageFile[]>;

export interface FailureStory {
  key: string;
  clusterId: number;
  projectId: number;
  specFile: string;
  locator: string | null;
  /** The locator call-site healing snapshots are keyed on (innermost frame). */
  captureLocation?: string;
  failingCases: FailingCase[];
  aria: string | null;
  /** Authored failure-time DOM for the locator picker / DOM snapshot card. */
  domSnapshot?: StoryDomSnapshot;
  evidence: StoryEvidence;
  appFiles: string[];
  suspectSha: string;
  diagnosis: StoryDiagnosis;
  media: StoryMedia;
  firing: StoryFiring;
  /** Gives the cluster suspect lines: the coverage its newest failing run recorded. */
  coverage?: StoryCoverage;
}

export interface DemoCase {
  file: string;
  title: string;
  declLine: number;
  declColumn: number;
}

export interface DemoBrowserProfile {
  projectName: string;
  browserName: string;
  channel: string | null;
  viewport: { width: number; height: number } | null;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  locale?: string;
  timezoneId?: string;
  colorScheme?: string;
  reducedMotion?: string;
  userAgent?: string;
}

export interface DemoProject {
  id: number;
  name: string;
  baseUrl: string | null;
  cases: DemoCase[];
  suites: Record<string, { suitePath: string[]; mode: string; annotations: Array<{ type: string }> }>;
  browsers: DemoBrowserProfile[];
  browserRotation: number[];
  network: StoryNetworkRequest[];
  consolePassing: StoryConsoleEntry[] | null;
  webVitals: boolean;
  pageState: {
    url: string;
    localStorage: Array<{ key: string; length: number }>;
    sessionStorage: Array<{ key: string; length: number }>;
    cookies: Array<Record<string, unknown>>;
  } | null;
  stepTitles: DemoStepTitle[];
}

/** A themed step for a project's cases; `children` nest inside its time window. */
export interface DemoStepTitle {
  title: string;
  category: string;
  weight: number;
  subtitle?: string;
  params?: Record<string, string | number | boolean>;
  /** Project-relative `file:line:col` of the call, as a step location reports it. */
  location?: string;
  /** The page key the call ran on, as the capture fixtures record it (`piwi-locator-pages`). */
  page?: string;
  /** The call ran before any locator interaction on that page. */
  arrival?: boolean;
  children?: DemoStepTitle[];
}

export interface ScmCommitFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  /** The git blob id of the file after the commit, where the history names it. */
  blob?: string;
}

export interface ScmCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  branch: string;
  files: ScmCommitFile[];
}

export interface ScmRepo {
  repositoryUrl: string;
  defaultBranch: string;
  branches: string[];
  commits: ScmCommit[];
}

export declare const SOURCE_FILES: Record<string, string[]>;
export declare const FAILURE_STORIES: FailureStory[];
export declare const DEMO_PROJECTS: DemoProject[];
export declare const SCM_REPOS: Record<number, ScmRepo>;
export declare const SIMULATOR_ERRORS: {
  checkoutPayTimeout: string;
  checkoutPayTimeoutPaypal: string;
  emailLabelRenamed: string;
};

export declare function renderSnippet(
  lines: string[],
  opts: { declLine?: number | null; failingLine?: number | null; context: number },
): string;
export declare function lineOf(lines: string[], needle: string, nth?: number): number;
export declare function buildTestTimeoutError(p: {
  timeoutMs: number;
  action: string;
  callLog: string[];
  frames: StoryFrame[];
}): string;
export declare function buildActionTimeoutError(p: {
  action: string;
  timeoutMs: number;
  callLog: string[];
  frames: StoryFrame[];
}): string;
export declare function buildValueAssertionError(p: {
  matcherLine: string;
  body: string[];
  frames: StoryFrame[];
}): string;
export declare function buildWebAssertionError(p: {
  matcher: string;
  locator: string;
  expected: string;
  received: string;
  timeoutMs: number;
  callLog: string[];
  frames: StoryFrame[];
  ansi?: boolean;
}): string;
export declare function buildStrictModeError(p: {
  action: string;
  selector: string;
  elements: string[];
  callLog: string[];
  frames: StoryFrame[];
}): string;
export declare function buildCrashError(p: { action: string; callLog: string[]; frames: StoryFrame[] }): string;
export interface PatchEdit {
  at: number;
  remove?: number;
  add?: string[];
  context?: number;
}
export declare function derivePatch(file: string, source: string[], edits: PatchEdit | PatchEdit[]): string;
export declare function sourceText(path: string): string;
export declare function buildTestSource(
  story: { specFile: string },
  failing: { failingLine: number },
  declLine: number,
): string;
export declare function buildSourceFrames(failing: {
  frames: Array<{ file: string; line: number }>;
}): Array<{ file: string; line: number; snippet: string }>;
export declare const FAILURE_TEARDOWN_MS: number;
export declare function failingCallDuration(call: FailingCall, at: number, fallbackMs: number): number;
export declare function failingStep(failing: FailingCase, at: number, duration: number): PlacedStoryStep;
export declare function authoredFailureSteps(
  failing: FailingCase,
  opts?: { scale?: number; startMs?: number; fallbackMs?: number },
): PlacedStoryStep[] | null;
export declare function authoredBeforeEachMs(failing: FailingCase, opts?: { scale?: number }): number;
export declare function storyEvidenceTimes(
  story: FailureStory,
  step: { at: number; duration: number },
): { requests: number[]; console: number[]; dialogClosedAt: number };
export declare function storyByClusterId(clusterId: number): FailureStory | null;
export declare function storyForCase(projectId: number, filePath: string, title: string): FailureStory | null;
export declare function projectSourceFilePaths(projectId: number): string[];
export declare function storyCoverageFiles(story: FailureStory, file: string, title: string): StoryCoverageFile[];
