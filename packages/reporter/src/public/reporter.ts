import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  FullConfig,
  Suite,
  TestCase,
  TestError,
  TestResult,
  FullResult,
  TestStep,
} from '@playwright/test/reporter';
import {
  resolveOptions,
  usedDesktopDiscovery,
  usedDesktopToken,
  requestedRunProblem,
  requestedRunTarget,
  desktopReplacedServer,
  normalizeBoolEnv,
  usedDotEnv,
  ignoredEnvValues,
  PIWI_DEFAULTED_CAPTURE_ENV,
  PIWI_ENV_KEYS,
  PIWI_SHARE_LIVE_ENV,
  readBool,
  PIWI_RESOURCES_RESULTS_ENV,
  type DotEnvUse,
  type IgnoredEnvValue,
} from '../internal/config/env.js';
import { applyRequestedRunEnv, namesRequestedRun } from '../internal/config/requested-run.js';
import { PIWI_EDITOR_ENV, followHub, runInteractive, type FollowedHub } from '../internal/config/hub.js';
import type { PiwiDashboardOptions, ShardInfo } from './options.js';
import { HttpClient, serverUrlProblem } from '../internal/transport/http-client.js';
import { Uploader } from '../internal/submit/uploader.js';
import { StreamBuffer } from '../internal/streaming/stream-buffer.js';
import { CrashRecovery } from '../internal/streaming/crash-recovery.js';
import { FileHandler } from '../internal/files/file-handler.js';
import { htmlReportFolder } from '../internal/files/html-report.js';
import { ATTACHMENT_NAMES, INTERNAL_ATTACHMENT_NAMES, findPiwiAttachment } from '../internal/capture/attachments.js';
import { MetadataCollector, resolveScmBranch } from '../internal/collect/metadata-collector.js';
import { StreamManager } from '../internal/streaming/stream-manager.js';
import { RunHubLink, countedOutcome } from '../internal/streaming/run-hub-link.js';
import { TerminalProgress, terminalFeatures } from '../internal/support/terminal.js';
import {
  collectStepMetrics,
  extractTestStepEvents,
  extractWaitEvents,
  hideTypedStepTitle,
} from '@piwitests/core/step-analysis';
import { isCaptureStep } from '@piwitests/core/step-tree';
import { pauseStepEvents, readPauses } from '../internal/collect/pause-events.js';
import { computeInstanceId } from '../internal/support/instance-id.js';
import { getReporterVersion } from '../internal/support/reporter-version.js';
import {
  collectSourceFrames,
  extractFailingLine,
  readSourceSnippet,
  sourceLineReader,
} from '../internal/support/source-snippet.js';
import { detectCi, resolveRunLabel } from '../internal/support/ci.js';
import { parallelIndexOf, workerIndexOf } from '../internal/support/worker-index.js';
import { detectCliFileFilters, detectCliGrep, detectCliNarrowingFlags } from '../internal/support/cli-filters.js';
import { readSelectionStamp } from '../internal/support/selection-env.js';
import { resolveShardInfo } from '../internal/support/shard-info.js';
import { isListMode, isMergeReports } from '../internal/support/run-mode.js';
import { peekSetupFailure, peekSetupInfo, readSetupInfo, type SetupInfo } from '../internal/support/setup-file.js';
import { privateTempDir, readPrivateFile } from '../internal/support/private-file.js';
import {
  LIVE_VIEW_ENV,
  formatLiveViewEnv,
  formatLiveViewMissing,
  LIVE_SHARE_MISSING,
  type LiveViewMissing,
} from '@piwitests/core/live-view';
import { ciLiveViewNote } from '../internal/streaming/live-view-note.js';
import { RUN_CHANNEL_ENV } from '@piwitests/core/run-channel';
import { RUN_INTERACTIVE_METADATA_KEY } from '@piwitests/core/wire';
import { createGlobalSetup } from './global-setup.js';
import { wrapConfig } from './config-wrapper.js';
import { toWireTestCase } from '../internal/submit/serializer.js';
import { isProbeMode } from '../internal/probe/mode.js';
import { probeRunMetadata } from '../internal/probe/plan.js';
import { flakeRunMetadata, isFlakeMode, loadFlakePlan } from '../internal/flake/mode.js';
import { errorMessage } from '../internal/support/errors.js';
import {
  mergeAnnotations,
  classifyStatus,
  expectedFailureError,
  resolveUnrunReason,
  linkBlockedTests,
} from '@piwitests/core/status-classify';
import {
  collectTestLocks,
  collectTestMetadata,
  collectTestTags,
  formatTagsTruncated,
} from '../internal/collect/test-meta.js';
import {
  formatExternalIdDuplicates,
  planExternalIds,
  resolveOnDuplicate,
  type ExternalIdPlan,
} from '../internal/collect/external-ids.js';
import { buildErrorText } from '../internal/collect/error-text.js';
import { runErrorOf } from '../internal/collect/run-errors.js';
import { testOutputOf } from '../internal/collect/test-output.js';
import { MAX_RUN_ERRORS } from '@piwitests/core/run-errors';
import { collectTagsTruncated } from '@piwitests/core/test-meta';
import { RunSubmitter } from '../internal/submit/run-submitter.js';
import { readLeakCheck, type ResourceCensus } from '../internal/capture/resource-ledger.js';
import {
  buildResourceReport,
  formatResourceSummary,
  parseResourceCensus,
  parseResourceResults,
  tallyLifecycleSteps,
  userFixturesOf,
  type LifecycleTally,
} from '../internal/collect/resource-verdicts.js';
import { Logger } from '../internal/support/logger.js';
import { emitResourceSummary } from '../internal/support/ci-output.js';
import { RunSampler } from '../internal/collect/process-sampler.js';
import { LiveResources } from '../internal/streaming/live-resources.js';
import { executionResources, resourceReportWire } from '../internal/collect/resource-wire.js';
import {
  artifactKind,
  emptyArtifacts,
  formatMachinePanel,
  workerHealthOf,
  type ArtifactBytes,
} from '../internal/collect/machine-panel.js';
import { FailureLinks, failureHeadline, type FailedTest } from '../internal/support/failure-links.js';
import { coverageSettings, type CoverageSettings } from '../internal/collect/coverage-settings.js';
import { CoverageCollection, LastTestWatch } from '../internal/collect/test-coverage.js';
import { baseUrlsFromConfig, ignoresHttpsErrors } from '../internal/collect/server-coverage.js';
import { backendManifestFetch } from '../internal/manifest/collect.js';
import { configDirFromConfig, relativeTestPath } from '../internal/support/test-paths.js';
import { RunManifests } from '../internal/manifest/run-manifests.js';
import { collectRunnerEnvironment } from '../internal/collect/environment.js';
import { RunEnvironments } from '../internal/collect/run-environments.js';
import type {
  CollectedTestCase,
  StreamEvent,
  SetupStep,
  FilterDetails,
  TestAnnotation,
  WireResourceReport,
  WireRunError,
} from '../types.js';
import type { WireEnvironmentSnapshot } from '../types/wire.js';
import { readStopNotes, type StopNote, type StopNotesReader } from '../internal/support/stop-notes.js';

/**
 * Relative `file:line:column` location string for a test, normalized to POSIX
 * path separators so Playwright's CLI file filter (and the dashboard's copyable
 * retry command) match on every platform — `path.relative` yields backslashes on Windows.
 */
function testLocation(test: TestCase, base: string): string {
  return `${testFile(test, base)}:${test.location.line}:${test.location.column}`;
}

/** Spec path relative to `base` (the config's folder), POSIX separators — the `filePath` the dashboard stores. */
function testFile(test: TestCase, base: string): string {
  return relativeTestPath(test.location.file, base);
}

/**
 * Whether an attempt made Playwright calls with no capture fixtures set up: its steps hold a `pw:api` call outside its
 * hooks and no step of the `piwiCapture` fixture, which every test that imports `test` from a file extending
 * `piwiFixtures` sets up. A `beforeAll` runs before the test's own fixtures: its calls say nothing of them.
 */
function uncapturedCalls(steps: readonly TestStep[]): boolean {
  let calls = false;
  const captured = (list: readonly TestStep[], inHook: boolean): boolean =>
    list.some((step) => {
      if (step.category === 'pw:api' && !inHook) calls = true;
      return (
        (step.category === 'fixture' && /\bpiwiCapture\b/.test(step.title)) ||
        captured(step.steps, inHook || step.category === 'hook')
      );
    });
  return !captured(steps, false) && calls;
}

/** Whether a test's steps set up Playwright's `page` fixture: a test without one has no page to watch. */
function usesPage(steps: readonly TestStep[]): boolean {
  return steps.some((step) => (step.category === 'fixture' && /"page"/.test(step.title)) || usesPage(step.steps));
}

/** How many of the other spec files that ran without the capture fixtures the run's last line names. */
const MAX_UNCAPTURED_NAMED = 5;

/**
 * Whether an attempt has a say in its test's outcome, as Playwright reads it: an interrupted attempt and a skip of a
 * test expected to run (`didnotrun`) have none (status as `classifyStatus` stores it).
 */
function decidesOutcome(status: string): boolean {
  return status !== 'interrupted' && status !== 'didnotrun';
}

/**
 * Whether a test's attempts read as Playwright's `unexpected` outcome: every attempt with a say in it failed or timed
 * out (statuses as `classifyStatus` stores them).
 */
function failedEveryAttempt(attempts: ReadonlyArray<{ status: string }>): boolean {
  const ran = attempts.filter((attempt) => decidesOutcome(attempt.status));
  return ran.length > 0 && ran.every((attempt) => attempt.status === 'failed' || attempt.status === 'timedOut');
}

/** The line saying which hub a run started in a terminal attached to, how it attends it, and how to change that. */
function followedLine(followed: FollowedHub): string {
  const where = followed.pid === null ? followed.name : `${followed.name} (pid ${followed.pid})`;
  if (!followed.attended) {
    return (
      `Following this run in ${where}, unattended: its output goes to no terminal, so no failure waits and only a ` +
      `Pause stops it. ${PIWI_EDITOR_ENV}=on attends it, ${PIWI_EDITOR_ENV}=off runs it alone.`
    );
  }
  const stops = followed.kind === 'editor' ? 'whose breakpoints stop it' : 'whose window pauses and watches it';
  return `Following this run in ${where}, ${stops}: ${PIWI_EDITOR_ENV}=off runs it alone.`;
}

/**
 * Piwi Dashboard Playwright reporter.
 *
 * Collects test results, metadata, performance metrics and trace files, then
 * hands the collected run to a `RunSubmitter` which drives the JSON / multipart
 * / streaming submit ladder. The reporter itself only owns the Playwright hooks
 * and the running counters.
 */
export class PiwiDashboardReporter {
  private options: PiwiDashboardOptions;
  private testCases: CollectedTestCase[] = [];
  /** The failed and timed-out attempts collected so far: the blockers a `describe.serial` cascade links to. */
  private readonly failedCases: CollectedTestCase[] = [];
  private startTime: string | null = null;
  private playwrightVersion: string | null = null;
  private readonly reporterVersion = getReporterVersion();
  private totalTests = 0;
  private passedTests = 0;
  private failedTests = 0;
  private skippedTests = 0;
  private timedOutTests = 0;
  private didNotRunTests = 0;
  /**
   * Tests whose attempts read as Playwright's `unexpected` outcome (`failedEveryAttempt`), counted once their last
   * attempt ended: what `maxFailures` counts.
   */
  private failedTestCount = 0;
  /** Full set of tests Playwright planned to run this shard (captured in `onBegin`). */
  private plannedTests: TestCase[] = [];
  /** Ids of tests that actually reported via `onTestEnd`, to find the ones that never ran. */
  private reportedTestIds = new Set<string>();
  /**
   * The spec files said to have run without the capture fixtures in a run that can stop, or whose workers stream to
   * the instance's live view (`noteUncaptured`).
   */
  private uncapturedSpecs = new Set<string>();
  /** Whether the run is a CI run whose workers stream to the instance's live view, set in `onBegin`. */
  private liveViewOn = false;
  /** The run's own connection to the hub its workers reach, from `onBegin` to `onEnd`; null for a run without one. */
  private hubLink: RunHubLink | null = null;
  /** The live steps begun and not ended, by step, sent again when someone opens the run (`onWatched`). */
  private openSteps = new Map<unknown, StreamEvent>();
  /** The attempts running now, by test id, for the stops their workers note (`heardStop`). */
  private runningTests = new Map<string, { test: TestCase; result: TestResult }>();
  /** Reads the stops the workers note (`readStopNotes`). */
  private stopNotes: StopNotesReader | null = null;
  /** The run's progress in its terminal's tab or taskbar, for a run outside CI that reports to the dashboard. */
  private terminalProgress: TerminalProgress | null = null;
  /**
   * The failed attempts with retries left, by `test.id`: each is its test's last failure when no later attempt has a
   * say in its outcome (`decidesOutcome`), the run stopping before the retry or the retry not running.
   */
  private failuresAwaitingRetry = new Map<string, () => FailedTest>();
  /** Per-test attempt history, keyed by `test.id`; snapshotted onto every attempt's payload. */
  private attemptsByTest = new Map<
    string,
    Array<{ retry: number; status: string; duration: number; startedAt: number | null }>
  >();
  /** The folder test files are named relative to: the Playwright config's, set in `onBegin`. */
  private testPathBase = process.cwd();
  /** The folder the run's html reporter writes its report to, set in `onBegin`; null when the run has none. */
  private htmlReport: string | null = null;
  /** Derived in `onBegin`, once the shard is known. */
  private instanceId = '';
  private shardInfo: ShardInfo | null = null;
  private metadata: Record<string, any> = {};
  /** Each planned test's external ID and the IDs two tests share, settled in `onBegin`. */
  private externalIds: ExternalIdPlan | null = null;
  private enabled: boolean;
  /** Why the configured `serverUrl` cannot be used, which leaves the reporter off; null when it can. */
  private readonly serverUrlProblem: string | null;
  /**
   * True under `playwright test --list`, where Playwright still constructs this
   * reporter and fires `onBegin`/`onEnd` but runs no tests. Registering and
   * finalizing a run would create an empty phantom run and upload an empty report.
   */
  private readonly listMode: boolean;
  /** True under `playwright merge-reports`, which replays blob reports: no test runs and nothing of the run is live. */
  private readonly mergingReports = isMergeReports();
  /** True when the server URL and API key came from the desktop app, not from config. */
  private viaDesktopApp: boolean;
  /** The team instance a requested run uploads to, or why it uploads nowhere. */
  private requestedRun: { instance: string | null; problem: string | null };
  /** The configured server `desktopApp: 'prefer'` set aside for the desktop app, if any. */
  private readonly desktopReplaced: string | null;
  /** The config folder's `.env` file and the connection variables taken from it, if any. */
  private readonly viaDotEnv: DotEnvUse | null;
  /** The `PIWI_*` variables whose values could not be read, so their options kept their defaults. */
  private readonly ignoredEnv: readonly IgnoredEnvValue[];
  private isFullRun = true;
  private filterDetails: FilterDetails | null = null;
  /** Configured `maxFailures` (0 = unlimited) — disambiguates an interrupted run's unrun reason. */
  private maxFailures = 0;
  /** Each Playwright project's `dependencies`, by project name, set in `onBegin`. */
  private projectDependencies = new Map<string, readonly string[]>();
  /** The resource censuses the capture fixtures attached, one per test attempt. */
  private resourceCensuses: ResourceCensus[] = [];
  /** Lifecycle steps of the tests that ran without the fixtures. */
  private lifecycleTallies: LifecycleTally[] = [];
  /** The spec and helper files those steps point at, read once each. */
  private readonly sourceLines = sourceLineReader();
  /** The user fixtures set up by the tests that left a page unused, by test id. */
  private fixturesByTest = new Map<string, string[]>();
  /** The file workers append their shutdown census to, set in `onBegin`. */
  private resourcesFile: string | null = null;
  /** Samples the run's processes and the machine from `onBegin` to `onEnd`. */
  private sampler: RunSampler | null = null;
  /** Posts what the sampler and the censuses add while someone has the run open on the dashboard. */
  private liveResources: LiveResources | null = null;
  /** Bytes of the files the tests attached, by kind. */
  private artifactBytes: ArtifactBytes = emptyArtifacts();
  /** The run's resource report for the dashboard, built in `onEnd`. */
  private resourceReport: WireResourceReport | null = null;
  /** The coverage the options switch on, per runtime. */
  private readonly coverageSettings: CoverageSettings;
  /** Each test's coverage, when browser or server coverage is on; set in `onBegin`. */
  private coverage: CoverageCollection | null = null;
  /** Tells when the run's last test ended, while server coverage needs it. */
  private lastTestWatch: LastTestWatch | null = null;
  /** The manifests of the instrumented origins the run reaches beyond its base URLs. */
  private manifests: RunManifests | null = null;
  /** Where the run executes: the runner, each project's browser and each server under test; null when off. */
  private environments: RunEnvironments | null = null;
  /** Result events that stream once their test's server coverage is in. */
  private coverageSends: Array<Promise<void>> = [];
  /** The errors Playwright reported outside any test (`onError`), the first `MAX_RUN_ERRORS` of them. */
  private readonly runErrors: WireRunError[] = [];

  private httpClient: HttpClient;
  private uploader: Uploader;
  private fileHandler: FileHandler;
  private metadataCollector: MetadataCollector;
  private streamManager: StreamManager | null = null;
  private recovery: CrashRecovery;
  private submitter: RunSubmitter;
  private readonly failureLinks: FailureLinks;
  private readonly logger: Logger;

  static wrapConfig = wrapConfig;
  static createGlobalSetup = createGlobalSetup;

  constructor(rawOptions: Record<string, any> = {}) {
    // Playwright passes the config's folder to every reporter it constructs.
    const configDir = typeof rawOptions.configDir === 'string' ? rawOptions.configDir : undefined;
    this.options = resolveOptions(rawOptions, configDir);
    this.serverUrlProblem =
      this.options.enabled !== false && this.options.serverUrl ? serverUrlProblem(this.options.serverUrl) : null;
    this.enabled = this.options.enabled !== false && !!this.options.serverUrl && !this.serverUrlProblem;
    this.listMode = isListMode();
    this.viaDesktopApp = usedDesktopDiscovery();
    this.requestedRun = { instance: requestedRunTarget(), problem: requestedRunProblem() };
    this.desktopReplaced = desktopReplacedServer();
    this.viaDotEnv = usedDotEnv();
    this.ignoredEnv = ignoredEnvValues();
    this.coverageSettings = coverageSettings(this.options);

    const logger = new Logger(this.options.verbose ?? false);
    this.logger = logger;
    this.httpClient = new HttpClient(
      this.options.serverUrl ?? 'http://localhost:3000',
      logger,
      undefined,
      undefined,
      usedDesktopToken() ? (this.options.apiKey ?? null) : null,
    );
    this.fileHandler = new FileHandler(logger);
    this.uploader = new Uploader(this.httpClient, this.fileHandler, logger);
    this.recovery = new CrashRecovery(this.httpClient.baseUrl, this.options.projectName!, logger);
    this.metadataCollector = new MetadataCollector(logger);
    this.failureLinks = new FailureLinks(this.httpClient.baseUrl, logger);

    const streamBuffer = new StreamBuffer(this.options.projectName!);
    streamBuffer.clearStale();

    // A disabled reporter streams nothing, so it queues no event and stages no file for an upload.
    if (this.options.streaming && this.enabled) {
      this.streamManager = new StreamManager(
        this.httpClient,
        streamBuffer,
        this.recovery,
        this.uploader,
        this.fileHandler,
        this.options,
        logger,
      );
    }

    this.submitter = new RunSubmitter(
      this.httpClient,
      this.uploader,
      this.recovery,
      this.streamManager,
      logger,
      this.failureLinks,
    );
  }

  /**
   * Playwright reporter hook: whether this reporter writes the run's progress to
   * the terminal. It does not (it prints only its own `[Piwi Dashboard]` lines),
   * so Playwright keeps its own terminal reporter when Piwi is the only one
   * configured.
   */
  printsToStdio(): boolean {
    return false;
  }

  /** Playwright reporter hook: called once at the start of the test run */
  onBegin(config: FullConfig, suite: Suite): void {
    if (this.listMode) {
      this.logger.debug('List mode (--list) detected — no run registered or report uploaded.');
      return;
    }
    // The workers, which start after this hook, read the boolean variables as the reporter does.
    normalizeBoolEnv(process.env);
    // A requested run's workers reach neither the config's server nor its credentials.
    if (namesRequestedRun(process.env)) applyRequestedRunEnv(process.env);
    // A run started in a terminal attaches to its hub, the editor whose workspace holds it, else the desktop app whose
    // linked folder does: its workers, which start after this hook, inherit the hub's run channel.
    const dirs = [configDirFromConfig(config), process.cwd()];
    const gate = { env: process.env, argv: process.argv, terminal: !!process.stdout.isTTY || !!process.stderr.isTTY };
    const followed = followHub(dirs, gate);
    if (followed) this.logger.info(followedLine(followed));
    // The hub its workers reach hears how far the run is, from its own process.
    this.hubLink = RunHubLink.open(process.env, config, suite.allTests().length, getReporterVersion());
    // The run the global setup registered names its page now; the stream names the run it opens, another on a refusal.
    const registered = this.enabled && this.hubLink ? peekSetupInfo(this.options.projectName!) : null;
    if (registered) this.hubLink?.page(registered.runId, registered.runUrl);
    if (this.enabled && terminalFeatures(process.env, !!process.stdout.isTTY).progress) {
      this.terminalProgress = new TerminalProgress(suite.allTests().length, (text) => process.stdout.write(text));
      this.terminalProgress.begin();
    }
    if (!this.enabled) {
      if (this.requestedRun.problem) this.logger.warn(`${this.requestedRun.problem} Nothing is sent to the dashboard.`);
      else if (this.serverUrlProblem) this.logger.warn(`${this.serverUrlProblem} Nothing is sent to the dashboard.`);
      else this.logger.info('Not enabled — set PIWI_DASHBOARD_URL or serverUrl to enable.');
      // A run the editor follows says why it cannot be shared live.
      if (!detectCi(process.env)) process.env[LIVE_VIEW_ENV] = formatLiveViewMissing('no-instance');
      return;
    }
    // Nothing in the config pointed at a server, so results are going to the
    // desktop app found on this machine — say so rather than uploading silently.
    if (this.requestedRun.instance) {
      this.logger.info(`Sending the run to ${this.requestedRun.instance}, which asked for it.`);
    }
    if (this.viaDesktopApp) {
      this.logger.info(
        this.desktopReplaced
          ? `Using the desktop app running at ${this.options.serverUrl} instead of ${this.desktopReplaced} (desktopApp: 'prefer', not on CI).`
          : `Using the desktop app running at ${this.options.serverUrl} (no serverUrl configured).`,
      );
    }
    if (this.viaDotEnv) this.logger.debug(`Read ${this.viaDotEnv.keys.join(', ')} from ${this.viaDotEnv.file}.`);
    for (const { name, value, fallback } of this.ignoredEnv) {
      this.logger.warn(`${name}=${value} is not a number of 0 or more, so the default (${fallback}) applies.`);
    }
    this.startTime = new Date().toISOString();
    this.testPathBase = configDirFromConfig(config);
    this.htmlReport = htmlReportFolder(config.reporter, this.testPathBase);
    this.playwrightVersion = config.version;
    this.maxFailures = config.maxFailures ?? 0;
    this.projectDependencies = new Map((config.projects ?? []).map((p) => [p.name, p.dependencies ?? []] as const));

    // Workers inherit the environment when they start, after this hook: the
    // shutdown census of each one lands in this file, read back in `onEnd`.
    if (this.options.captureResources !== false) {
      this.resourcesFile = path.join(privateTempDir(), `piwi-resources-${process.pid}-${Date.now()}.jsonl`);
      process.env[PIWI_RESOURCES_RESULTS_ENV] = this.resourcesFile;
      try {
        this.sampler = new RunSampler({ outputDirs: (config.projects ?? []).map((project) => project.outputDir) });
        this.sampler.start();
      } catch (error) {
        this.sampler = null;
        this.logger.debug(`Run sampler not started: ${errorMessage(error)}`);
      }
    }
    // Plumbing: the run's own line is its page's (`View live progress`).
    this.logger.debug(
      `Starting test run for project: ${this.options.projectName} (Playwright v${this.playwrightVersion})`,
    );

    // `wrapConfig` records a summary of the capture options it defaulted; name
    // them once so a half-installed project knows failure evidence is on without
    // the fixtures.
    const defaulted = process.env[PIWI_DEFAULTED_CAPTURE_ENV];
    if (defaulted) {
      this.logger.info(
        `Defaulted Playwright ${defaulted} for failure evidence (set defaultCapture: false to opt out).`,
      );
    }

    // Detect partial-run filters so the dashboard can distinguish full-suite runs from ad-hoc focused runs.
    const rawConfig = config as any;
    const grepRe = rawConfig.grep instanceof RegExp ? rawConfig.grep : undefined;
    const grepInvertRe = rawConfig.grepInvert instanceof RegExp ? rawConfig.grepInvert : undefined;
    // Playwright's default grep is /.*/ (matches everything): only another pattern is a real filter. A
    // pattern given on the command line reaches the runner, not config.grep, so it is read from there too.
    const cliGrep = detectCliGrep();
    const grep = (grepRe && grepRe.source !== '.*' ? grepRe.source : undefined) ?? cliGrep.grep;
    const grepInvert = grepInvertRe?.source ?? cliGrep.grepInvert;
    // File/path filters come from the CLI invocation, not config.grep, and so do the flags that run
    // a subset chosen from history, a diff or a list (`--last-failed`, `--only-changed`, `--test-list`).
    const fileFilters = detectCliFileFilters();
    const narrowed = detectCliNarrowingFlags().length > 0;
    // A run launched by `piwi run <key>` carries the resolved selection's
    // identity in the environment; stamp it so the dashboard can name the
    // subset and a gate can re-resolve the same definition.
    const selection = readSelectionStamp();
    if (grep || grepInvert || fileFilters.length > 0 || selection || narrowed) {
      this.isFullRun = false;
      this.filterDetails = {
        ...(grep ? { grep } : {}),
        ...(grepInvert ? { grepInvert } : {}),
        ...(fileFilters.length > 0 ? { files: fileFilters } : {}),
        ...(selection ? { selection } : {}),
      };
      this.logger.debug(
        selection ? `Selection run detected (${selection.key})` : 'Partial run detected (filter active)',
      );
    }

    this.metadata = this.metadataCollector.collect(config, suite, this.options);
    // A run a hub steers names it: its stops are a person's, at the editor's or the desktop app's breakpoints.
    const interactive = runInteractive(process.env, followed);
    if (interactive) this.metadata[RUN_INTERACTIVE_METADATA_KEY] = interactive;

    // Stamp a probe run at the source, before any run body is sent. The
    // streaming start/begin and finish calls carry this same metadata object, so
    // stamping it here (rather than only at serialize time) marks the run on
    // every submit path — the dashboard then routes it to its silent path (no
    // clusters, regression signals, notifications or pull-request feedback).
    if (isProbeMode()) this.metadata = probeRunMetadata(this.metadata);

    // A flake-lab run is stamped the same way, with the experiment and arm it
    // ran, so the dashboard keeps it out of flakiness, regression signals,
    // clusters and notifications. A plan that cannot be read still stamps the
    // run (the capture fixtures fail its tests with the reason).
    if (isFlakeMode()) {
      let stamp: { experimentId: string; armId: string } = { experimentId: 'unknown', armId: 'unknown' };
      try {
        const plan = loadFlakePlan();
        stamp = { experimentId: plan.experimentId, armId: plan.arm.id };
      } catch (error) {
        this.logger.warn(errorMessage(error));
      }
      this.metadata = flakeRunMetadata(stamp, this.metadata);
    }

    // Snapshot the planned test list so `onEnd` can materialize tests that
    // never ran (e.g. cut short by `maxFailures`) as `didnotrun` cases. The
    // suite is already filtered/sharded, so this matches what this shard
    // attempts.
    this.plannedTests = suite.allTests();
    this.planExternalIds();
    this.noteTagsTruncated();

    // Detect the shard: Playwright's --shard=1/3, or the one `piwi run --shard` set.
    this.shardInfo = resolveShardInfo(config);
    if (this.shardInfo) {
      this.logger.debug(`Shard ${this.shardInfo.current}/${this.shardInfo.total} detected`);
    }
    this.instanceId = computeInstanceId(
      this.options.projectName!,
      resolveRunLabel(this.options.runLabel, this.shardInfo !== null),
    );

    if (
      this.options.collectEnvironmentInfo !== false &&
      process.env[PIWI_ENV_KEYS.collectEnvironmentInfo] !== 'false'
    ) {
      this.environments = new RunEnvironments(
        collectRunnerEnvironment(process.env, this.shardInfo?.current ?? null),
        backendManifestFetch(ignoresHttpsErrors(config)),
      );
    }

    // Workers start after this hook and inherit the environment, so the
    // capture fixtures record the coverage the options switch on.
    const coverage = this.coverageSettings;
    // Each origin the run reaches beyond its base URLs has its manifest fetched as its first response is noted.
    if (this.options.uploadManifest !== false && this.options.projectName) {
      this.manifests = new RunManifests(
        baseUrlsFromConfig(config),
        this.logger,
        backendManifestFetch(ignoresHttpsErrors(config)),
      );
    }
    // The run's last test ending is when the servers under test are read again: Playwright stops a `webServer`
    // before `onEnd`.
    if (coverage.server !== 'off' || this.environments)
      this.lastTestWatch = new LastTestWatch(this.plannedTests.length);
    if (coverage.browser !== 'off' || coverage.server !== 'off' || coverage.css === 'rules') {
      if (coverage.browser !== 'off') process.env[PIWI_ENV_KEYS.coverageBrowser] = coverage.browser;
      if (coverage.css === 'rules') process.env[PIWI_ENV_KEYS.coverageCss] = coverage.css;
      if (coverage.server !== 'off') {
        process.env[PIWI_ENV_KEYS.coverageServer] = coverage.server;
      }
      this.coverage = new CoverageCollection({
        settings: coverage,
        baseUrls: baseUrlsFromConfig(config),
        ignoreHttpsErrors: ignoresHttpsErrors(config),
        configDir: configDirFromConfig(config),
        logger: this.logger,
      });
    }

    this.shareLiveView();
    this.streamManager?.start(
      this.startTime,
      this.metadata,
      this.instanceId,
      this.playwrightVersion,
      this.reporterVersion,
      this.shardInfo,
      this.isFullRun,
      this.filterDetails,
      // The planned suite size for this shard, known before any test runs, so
      // the dashboard shows the real total from the first render.
      this.plannedTests.length,
      this.environments?.atBegin(),
    );
    if (this.streamManager) {
      this.streamManager.onOpened = (runId, runUrl) => this.hubLink?.page(runId, runUrl);
      // A teammate asks to watch the run: the hub's tool asks the developer, and the run's terminal says so, whether a
      // tool showed it or not.
      this.streamManager.onAsk = (ask) => {
        const asked = this.hubLink?.ask(ask) ?? false;
        this.logger.info(
          asked
            ? `${ask.by} asks to watch this run live on the dashboard: share it from the editor or the app that follows it.`
            : `${ask.by} asks to watch this run live on the dashboard. A run that no editor or app follows is shared from its start with PIWI_SHARE_LIVE=1.`,
        );
      };
      if (this.hubLink) this.hubLink.onAskAnswer = (answer) => this.streamManager?.answerAsk(answer);
      // A person who opens the run sees the step each test is in now, not only the steps that begin after, at once.
      this.streamManager.onWatched = () => {
        void this.liveResources?.tick();
        const open = [...this.openSteps.values()];
        if (open.length > 0) this.streamManager?.queueEventsNow(open);
      };
      // A test outside CI may stop, at a breakpoint or a Pause: the run page says so, as text.
      if (!detectCi(process.env)) this.stopNotes = readStopNotes((note) => this.heardStop(note));
    }
    if (this.streamManager && this.options.captureResources !== false) {
      const live = new LiveResources(
        this.streamManager,
        this.httpClient,
        {
          sampler: this.sampler,
          censuses: () => this.resourceCensuses,
          shardIndex: this.shardInfo?.current ?? null,
          runStartedAt: Date.now(),
        },
        this.logger,
      );
      live.start();
      this.liveResources = live;
    }
  }

  /**
   * Name the run's live view on the instance for the workers, which Playwright starts after this hook with this
   * environment: the key the instance gave the global setup, for a project that turned its live view on, for this run
   * alone. A CI run's workers stream with it at once; a run outside CI's hold it until a person shares the run (Share
   * live), and such a run without a key names why instead, for the surfaces that would share it; a CI run without one
   * says why in its log (`ciLiveViewNote`). Read before the stream starts, which takes the setup file. A run that
   * merges blob reports starts no worker and is not live: it says nothing of the live view.
   */
  private shareLiveView(): void {
    if (this.mergingReports) return;
    const ci = detectCi(process.env);
    const setup = this.streamManager ? peekSetupInfo(this.options.projectName!) : null;
    // PIWI_SHARE_LIVE shares a run outside CI that no editor or app follows from its start; the workers read it as
    // they open their live view.
    const shareLive = !ci && !process.env[RUN_CHANNEL_ENV] && readBool(process.env[PIWI_SHARE_LIVE_ENV]) === true;
    if (shareLive) process.env[PIWI_SHARE_LIVE_ENV] = 'true';
    else delete process.env[PIWI_SHARE_LIVE_ENV];
    if (!setup?.liveViewKey) {
      const why = this.liveViewMissing(setup);
      if (shareLive) this.logger.warn(`PIWI_SHARE_LIVE: ${LIVE_SHARE_MISSING[why]}`);
      if (!ci) process.env[LIVE_VIEW_ENV] = formatLiveViewMissing(why);
      // A CI run says why nobody can watch it, for the person who reads its log to know what to change.
      else if (why !== 'local') {
        const failure = why === 'setup-failed' ? peekSetupFailure(this.options.projectName!) : null;
        this.logger.info(ciLiveViewNote(why, failure));
      }
      return;
    }
    process.env[LIVE_VIEW_ENV] = formatLiveViewEnv(this.httpClient.baseUrl, setup.runId, setup.liveViewKey);
    if (ci) {
      this.liveViewOn = true;
      this.logger.info(
        "Live view on for the specs that use Piwi's fixtures: people who may open this run can watch their tests' pages on the dashboard while it runs. Nothing is stored.",
      );
    } else if (shareLive) {
      this.liveViewOn = true;
      this.logger.info(
        `Shared live (PIWI_SHARE_LIVE) for the specs that use Piwi's fixtures: people who may open this run on ${this.httpClient.baseUrl} watch each worker's page, its calls and its stops while it runs, the secret fields painted over. Nothing is stored.`,
      );
    } else if (process.env[RUN_CHANNEL_ENV]) {
      this.logger.info(
        'Live view ready: this run can be shared live from the editor or Piwi Picker. Nothing is sent until it is.',
      );
    }
  }

  /** Why the run holds no live view key, from what its global setup left (`setup`, its registration, if any). */
  private liveViewMissing(setup: SetupInfo | null): Exclude<LiveViewMissing, 'no-instance'> {
    if (!this.streamManager) return 'streaming-off';
    if (setup) return setup.liveViewLocal ? 'local' : 'off';
    return peekSetupFailure(this.options.projectName!) !== null ? 'setup-failed' : 'unregistered';
  }

  /**
   * Settle each planned test's external ID before any test runs, name the IDs two tests share, and record them on
   * the run so the dashboard lists them too.
   */
  private planExternalIds(): void {
    const options = this.options.externalId ?? {};
    const plan = planExternalIds(
      this.plannedTests.map((test) => ({
        testId: test.id,
        filePath: testFile(test, this.testPathBase),
        suitePath: this.metadataCollector.getSuiteInfo(test).suitePath ?? [],
        title: test.title,
        line: test.location.line,
        annotations: test.annotations ?? [],
      })),
      options,
    );
    if (plan.patternError) {
      this.logger.error(
        `externalId.pattern is not a valid regular expression, so no ID is read from titles: ${plan.patternError}`,
      );
    }
    const { onDuplicate, invalid } = resolveOnDuplicate(options.onDuplicate);
    if (invalid !== undefined) {
      this.logger.warn(
        `externalId.onDuplicate is "${invalid}"; expected 'report' or 'fail', so duplicates are reported.`,
      );
    }
    for (const line of formatExternalIdDuplicates(plan.duplicates, onDuplicate)) this.logger.warn(line);
    if (plan.duplicates.length > 0) this.metadata = { ...this.metadata, externalIdDuplicates: plan.duplicates };
    this.externalIds = plan;
  }

  /**
   * Name the planned tests whose tags are cut at the limit, once, and record them on the run so the dashboard shows
   * them too. A planned test whose properties cannot be read is left out.
   */
  private noteTagsTruncated(): void {
    const readable: Array<{
      filePath: string;
      suitePath: string[];
      title: string;
      line: number;
      tags: unknown;
    }> = [];
    for (const test of this.plannedTests) {
      try {
        readable.push({
          filePath: testFile(test, this.testPathBase),
          suitePath: this.metadataCollector.getSuiteInfo(test).suitePath ?? [],
          title: test.title,
          line: test.location.line,
          tags: test.tags,
        });
      } catch (error) {
        this.logger.debug(`Tags of a planned test not read: ${errorMessage(error)}`);
      }
    }
    const found = collectTagsTruncated(readable);
    for (const line of formatTagsTruncated(found)) this.logger.warn(line);
    if (found) this.metadata = { ...this.metadata, tagsTruncated: found };
  }

  /** The external ID fields of a test's payload: `null` tells the dashboard the test has none to match on. */
  private externalIdFields(test: TestCase): { externalId?: string | null; displayTitle?: string | null } {
    if (!this.externalIds) return {};
    const id = this.externalIds.byTestId.get(test.id);
    return { externalId: id?.externalId ?? null, displayTitle: id?.displayTitle ?? null };
  }

  /**
   * A stop a worker noted (`stop-notes.ts`), of an attempt running now: a `test-stopped` event as it shows and a
   * `test-resumed` as it ends, named as its `begin` named the attempt, sent whoever watches.
   */
  private heardStop(note: StopNote): void {
    const running = this.runningTests.get(note.testId);
    if (!running || running.result.retry !== note.retry || !this.streamManager) return;
    const { test, result } = running;
    const of = {
      title: test.title,
      location: testLocation(test, this.testPathBase),
      retries: note.retry,
      repeatEachIndex: test.repeatEachIndex,
      workerIndex: workerIndexOf(result),
      parallelIndex: parallelIndexOf(result),
      shardIndex: this.shardInfo?.current ?? null,
      browser: this.metadataCollector.getBrowserConfig(test) || undefined,
    };
    if (note.kind === 'stopped') {
      this.streamManager.queueEvent({ type: 'test-stopped', ...of, stop: note.stop });
    } else {
      this.streamManager.queueEvent({ type: 'test-resumed', ...of, pausedMs: note.pausedMs });
    }
  }

  /** Playwright reporter hook: called when an individual test begins */
  onTestBegin(test: TestCase, result: TestResult): void {
    this.runningTests.set(test.id, { test, result });
    this.lastTestWatch?.begin(test.id);
    const { suitePath, suiteConfig } = this.metadataCollector.getSuiteInfo(test);
    const tags = collectTestTags(test);
    const locks = collectTestLocks(test);
    const beginEvent: CollectedTestCase = {
      type: 'begin',
      title: test.title,
      location: testLocation(test, this.testPathBase),
      // The attempt beginning, and how many retries the test has, so a retry reads as one while it runs.
      retries: result?.retry ?? 0,
      maxRetries: test.retries ?? 0,
      repeatEachIndex: test.repeatEachIndex,
      workerIndex: workerIndexOf(result),
      parallelIndex: parallelIndexOf(result),
      shardIndex: this.shardInfo?.current ?? null,
      browser: this.metadataCollector.getBrowserConfig(test) || undefined,
      suitePath,
      suiteConfig,
      // What the run page's search reads, known before the test runs.
      tags: tags.length ? tags : null,
      locks: locks.length ? locks : null,
      testMeta: collectTestMetadata((test.annotations ?? []) as TestAnnotation[]),
    };

    if (this.streamManager) {
      this.streamManager.queueEvent(toWireTestCase(beginEvent) as StreamEvent);
    }
  }

  /**
   * Playwright reporter hook: an error outside any test, such as a global setup that threw, a spec file that did not
   * load (`No tests found` and a web server that did not start come the same way, before any test), or a worker
   * fixture whose teardown threw. The run keeps the first `MAX_RUN_ERRORS`, with what may be a secret hidden, and sends
   * them with its end.
   */
  onError(error: TestError): void {
    if (this.listMode || !this.enabled || this.runErrors.length >= MAX_RUN_ERRORS) return;
    const kept = runErrorOf(error, this.testPathBase);
    if (kept) this.runErrors.push(kept);
  }

  /**
   * The steps outside any test, for the run's timeline. Playwright 1.59 and later, the oldest the reporter supports,
   * give every hook step to a test, `beforeAll` and `afterAll` hooks and worker fixture setup included, so it stays
   * empty.
   */
  private setupSteps: SetupStep[] = [];

  /** Step categories streamed live while the run executes. */
  private static readonly LIVE_STEP_CATEGORIES = new Set(['hook', 'fixture', 'pw:api', 'expect', 'test.step']);

  /**
   * Whether a step streams live: its category is in `LIVE_STEP_CATEGORIES`,
   * no ancestor is an `expect` step, and neither it nor an ancestor is Piwi's
   * own (`isCaptureStep`: its fixtures, its attachments, its page reads). The
   * steps inside an assertion are its polling — every `expect.poll` attempt and
   * `toPass` retry — not a step a human watches; the meaningful readout is the
   * assertion around them.
   */
  private static isLiveStep(step: TestStep): boolean {
    if (!PiwiDashboardReporter.LIVE_STEP_CATEGORIES.has(step.category)) return false;
    if (PiwiDashboardReporter.isOwnStep(step)) return false;
    for (let parent = step.parent; parent; parent = parent.parent) {
      if (parent.category === 'expect' || PiwiDashboardReporter.isOwnStep(parent)) return false;
    }
    return true;
  }

  /** Whether a step is Piwi's own, by core's rule for a stored step. */
  private static isOwnStep(step: TestStep): boolean {
    const at = step.location;
    return isCaptureStep({ title: step.title, location: at ? `${at.file}:${at.line}:${at.column}` : '' });
  }

  /**
   * Say of the first spec file whose test made Playwright calls without the capture fixtures what it misses in this
   * run, which nothing else says: in a run that can stop (breakpoints, or a run channel to an editor or the desktop
   * app, where the stops happen), its tests never stop at a breakpoint nor at Pause; in a CI run whose workers stream
   * to the instance's live view, nobody can watch them. The others are named in one line as the run ends
   * (`noteOtherUncaptured`).
   */
  private noteUncaptured(test: TestCase, result: TestResult): void {
    const missed = this.uncapturedCosts(usesPage(result.steps));
    if (!missed.length) return;
    if (!uncapturedCalls(result.steps)) return;
    const file = testFile(test, this.testPathBase);
    if (this.uncapturedSpecs.has(file)) return;
    this.uncapturedSpecs.add(file);
    if (this.uncapturedSpecs.size > 1) return;
    this.logger.warn(
      `${file} ran without Piwi's capture fixtures, so ${missed.map((cost) => cost.its).join(', and ')}: ` +
        "import `test` from your fixtures file (the one that extends piwiFixtures) instead of '@playwright/test'.",
    );
  }

  /** The spec files past the first that ran without the capture fixtures, in one line (`noteUncaptured`). */
  private noteOtherUncaptured(): void {
    const others = [...this.uncapturedSpecs].slice(1);
    if (!others.length) return;
    const named = others.slice(0, MAX_UNCAPTURED_NAMED).join(', ');
    const more = others.length > MAX_UNCAPTURED_NAMED ? `, and ${others.length - MAX_UNCAPTURED_NAMED} more` : '';
    const missed = this.uncapturedCosts(true).map((cost) => cost.their);
    this.logger.warn(
      `${others.length} more spec file${others.length === 1 ? '' : 's'} ran without Piwi's capture fixtures, ` +
        `so ${missed.join(', and ')}: ${named}${more}.`,
    );
  }

  /**
   * What a spec file that runs without the capture fixtures misses in this run, said of one file and of several: the
   * live view only for a test with a page (`page`).
   */
  private uncapturedCosts(page: boolean): Array<{ its: string; their: string }> {
    const costs: Array<{ its: string; their: string }> = [];
    if (this.mergingReports) return costs;
    if (process.env.PIWI_PAUSE_AT || process.env[RUN_CHANNEL_ENV]) {
      costs.push({
        its: 'its tests never stop at a breakpoint or at Pause',
        their: 'their tests never stop at a breakpoint or at Pause either',
      });
    }
    if (this.liveViewOn && page) {
      costs.push({
        its: 'nobody can watch its tests live on the dashboard',
        their: 'nobody can watch their tests live either',
      });
    }
    return costs;
  }

  /** Playwright reporter hook: called when a step (including hook/fixture) begins */
  onStepBegin(test: TestCase | undefined, _result: TestResult | undefined, step: any): void {
    // Gate on the stream manager *existing*, not on it being live yet: the
    // first fixtures and hooks run while `/start` is still in flight, and
    // `queueEvent` holds the events until the stream opens (same as `onTestBegin`).
    if (!this.enabled || !this.streamManager) return;
    if (!PiwiDashboardReporter.isLiveStep(step)) return;
    const cat = step.category;

    const event: StreamEvent = {
      type: 'step-begin',
      title: hideTypedStepTitle(step.title, cat),
      subtitle: typeof step.subtitle === 'string' && step.subtitle.length > 0 ? step.subtitle : null,
      location: step.location ? `${step.location.file}:${step.location.line}:${step.location.column}` : 'unknown',
      stepCategory: cat,
      parentTitle: test?.title || null,
      workerIndex: workerIndexOf(_result),
      shardIndex: this.shardInfo?.current ?? null,
      startedAt: step.startTime instanceof Date ? step.startTime.getTime() : null,
    };
    this.openSteps.set(step, event);
    this.streamManager?.queueEvent(event);
  }

  /** Playwright reporter hook: called when a step (including hook/fixture) ends */
  onStepEnd(test: TestCase | undefined, _result: TestResult | undefined, step: any): void {
    if (!this.enabled || !this.streamManager) return;
    if (!PiwiDashboardReporter.isLiveStep(step)) return;
    this.openSteps.delete(step);
    const cat = step.category;

    const workerIndex = workerIndexOf(_result);
    const startedAt = step.startTime instanceof Date ? step.startTime.getTime() : null;

    const event: StreamEvent = {
      type: 'step-end',
      title: hideTypedStepTitle(step.title, cat),
      subtitle: typeof step.subtitle === 'string' && step.subtitle.length > 0 ? step.subtitle : null,
      location: step.location ? `${step.location.file}:${step.location.line}:${step.location.column}` : 'unknown',
      status: step.error ? 'failed' : 'passed',
      duration: step.duration || 0,
      stepCategory: cat,
      parentTitle: test?.title || null,
      workerIndex,
      shardIndex: this.shardInfo?.current ?? null,
      startedAt,
    };
    this.streamManager?.queueEvent(event);

    // Track suite-level hooks (beforeAll/afterAll) for the timeline
    if (!test && startedAt && (cat === 'hook' || cat === 'fixture')) {
      this.setupSteps.push({
        title: step.title,
        category: cat,
        startedAt,
        duration: step.duration || 0,
        status: step.error ? 'failed' : 'passed',
        location: step.location ? `${step.location.file}:${step.location.line}:${step.location.column}` : null,
        workerIndex,
      });
    }
  }

  /** Playwright reporter hook: called when an individual test finishes */
  onTestEnd(test: TestCase, result: TestResult): void {
    // The worker noted the end of the test's last stop before the test ended: it goes before the test's end.
    this.stopNotes?.read();
    this.runningTests.delete(test.id);
    this.hubLink?.testEnded(test, result);
    const counted = this.terminalProgress ? countedOutcome(test, result) : null;
    if (counted) this.terminalProgress?.testEnded(test.id, counted === 'failed');
    this.totalTests++;
    // A worker runs one test at a time: a step of its still open once the test ended (a worker that crashed) never ends.
    const worker = workerIndexOf(result);
    for (const [step, event] of this.openSteps) if (event.workerIndex === worker) this.openSteps.delete(step);

    this.reportedTestIds.add(test.id);
    this.noteUncaptured(test, result);

    const { suitePath, suiteConfig } = this.metadataCollector.getSuiteInfo(test);
    const annotations = mergeAnnotations(test, result);
    const status = classifyStatus(result.status, annotations, test.expectedStatus);
    const tags = collectTestTags(test);
    const locks = collectTestLocks(test);

    // Playwright calls onTestEnd once per attempt (result.retry increases), so
    // accumulate the attempt list per test and snapshot it onto every attempt's
    // payload — the final attempt then carries the complete history.
    const attempts = this.attemptsByTest.get(test.id) ?? [];
    attempts.push({
      retry: result.retry,
      status,
      duration: result.duration,
      startedAt: result.startTime ? result.startTime.getTime() : null,
    });
    this.attemptsByTest.set(test.id, attempts);
    if (result.retry >= (test.retries ?? 0) && failedEveryAttempt(attempts)) this.failedTestCount++;

    const testCase: CollectedTestCase = {
      type: 'complete',
      testId: test.id,
      title: test.title,
      location: testLocation(test, this.testPathBase),
      status,
      duration: result.duration,
      // Effective per-test timeout (reflects project config + describe-level
      // overrides). `0` means unbounded; kept as-is so the dashboard can flag it.
      timeout: test.timeout ?? null,
      // A `test.fail()` test that passed is now `failed` with no recorded error;
      // Playwright reports the same line, so synthesize it.
      error:
        expectedFailureError(result.status, annotations, test.expectedStatus) ??
        buildErrorText(result, this.testPathBase),
      retries: result.retry,
      // Each `--repeat-each` repetition is a test of its own, with its own attempts.
      repeatEachIndex: test.repeatEachIndex,
      attempts: attempts.map((a) => ({ ...a })),
      workerIndex: workerIndexOf(result),
      parallelIndex: parallelIndexOf(result),
      shardIndex: this.shardInfo?.current ?? null,
      startedAt: result.startTime ? result.startTime.getTime() : null,
      attachments: result.attachments || [],
      browser: this.metadataCollector.getBrowserConfig(test) || undefined,
      suitePath,
      suiteConfig,
      testAnnotations: annotations.length ? annotations : null,
      tags: tags.length ? tags : null,
      locks: locks.length ? locks : null,
      testMeta: collectTestMetadata(annotations),
      ...this.externalIdFields(test),
      // An annotation-less skip reclassified to `didnotrun` is a serial-group
      // cascade: an earlier test failed and Playwright skipped the rest.
      didNotRunReason: status === 'didnotrun' ? 'previous-failure' : null,
      expectedStatus: test.expectedStatus ?? null,
      // What the attempt printed, which only a run reported to the dashboard reads.
      stdout: this.enabled ? testOutputOf(result.stdout) : null,
      stderr: this.enabled ? testOutputOf(result.stderr) : null,
    };

    if (result.status === 'failed' || result.status === 'timedOut') {
      const failingLine = extractFailingLine(testCase.error, test.location.file, test.location.line, this.testPathBase);
      const snippet = readSourceSnippet(test.location.file, test.location.line, 30, failingLine);
      if (snippet) testCase.testSource = snippet;
      // The call stack's in-project frames (innermost first) — the failing line
      // plus the callers above it, so a failure inside a helper is visible —
      // named relative to the config's folder, as the test's own path is.
      const frames = collectSourceFrames(testCase.error, test.location.file, test.location.line, {
        projectRoot: this.testPathBase,
      });
      if (frames.length) testCase.testSourceFrames = frames;
    }

    if (this.options.collectPerformanceMetrics && result.steps?.length > 0) {
      // The stops at Piwi's pause bar: the steps keep their clock, the statistics leave the stopped time out.
      const pauses = readPauses(findPiwiAttachment(result.attachments, ATTACHMENT_NAMES.pauses)?.body);
      testCase.performanceMetrics = collectStepMetrics(result.steps, result.errors, pauses);
      const stepEvents = extractTestStepEvents(result.steps, result.startTime);
      const waitEvents = extractWaitEvents(result.steps);
      // The stops before the waits, which can be many: the dashboard keeps the first events of a test.
      const allEvents = [...stepEvents, ...pauseStepEvents(pauses), ...waitEvents];
      if (allEvents.length > 0) testCase.stepEvents = allEvents;
    }

    if (this.options.collectPerformanceMetrics && result.attachments) {
      this.fileHandler.parsePerformanceAttachments(testCase, result.attachments);
      this.manifests?.note(testCase.networkRequests);

      // Locator snapshots arrive pre-stamped with their call-site `location`
      // (captured in the fixture at action call time), so they are not
      // correlated with pw:api steps by index.
      const locatorAttachment =
        this.options.captureLocators !== false
          ? findPiwiAttachment(result.attachments, ATTACHMENT_NAMES.locators)
          : undefined;
      if (locatorAttachment?.body) {
        try {
          testCase.locatorSnapshots = JSON.parse((locatorAttachment.body as Buffer).toString());
        } catch {
          /* ignore parse errors */
        }
      }
      // The page each locator call ran on, recorded by the same locator wrapper.
      const pagesAttachment =
        this.options.captureLocators !== false
          ? findPiwiAttachment(result.attachments, ATTACHMENT_NAMES.locatorPages)
          : undefined;
      if (pagesAttachment?.body) {
        try {
          testCase.locatorPages = JSON.parse((pagesAttachment.body as Buffer).toString());
        } catch {
          /* ignore parse errors */
        }
      }
    }
    if (this.enabled && this.options.captureResources !== false) this.collectResources(test, result, testCase);

    // The source files the test executed, when code reach is on.
    const reachAttachment =
      this.coverageSettings.browser !== 'off'
        ? findPiwiAttachment(result.attachments, ATTACHMENT_NAMES.codeReach)
        : undefined;
    if (reachAttachment?.body) {
      try {
        const files = JSON.parse((reachAttachment.body as Buffer).toString());
        if (Array.isArray(files)) testCase.codeReach = files.filter((f): f is string => typeof f === 'string');
      } catch {
        /* ignore parse errors */
      }
    }
    // The test's coverage: set now, or once its server coverage is collected.
    const coverageReady = this.coverage?.apply(testCase, result.attachments) ?? null;

    switch (status) {
      case 'passed':
        this.passedTests++;
        break;
      case 'failed':
        this.failedTests++;
        break;
      case 'skipped':
        this.skippedTests++;
        break;
      case 'didnotrun':
        this.didNotRunTests++;
        break;
      case 'timedOut':
        this.timedOutTests++;
        break;
    }

    this.environments?.noteTestEnd(result.attachments ?? [], testCase.networkRequests);
    this.testCases.push(testCase);
    if (status === 'failed' || status === 'timedOut') this.failedCases.push(testCase);

    // A cascade's blocking failure has already reported (serial execution runs
    // it first), so resolve `blockedBy` now — the streamed event then carries
    // the link even though the whole run isn't collected yet. Only this case is
    // linked, against the failures so far, so a long cascade costs one pass
    // over the failures per test rather than over every case collected.
    if (status === 'didnotrun') linkBlockedTests([...this.failedCases, testCase]);

    // The final attempt of a failing test gets a dashboard link, printed as
    // soon as a run id exists (immediately while streaming, after the submit otherwise).
    // A failed attempt with retries left gets it when the run ends before a retry with a say in the outcome
    // (`finishRun`): Playwright's outcome leaves interrupted attempts, and skips of a test expected to run, out.
    const isFailure = status === 'failed' || status === 'timedOut';
    const failedTest = (): FailedTest => ({
      title: test.title,
      file: testFile(test, this.testPathBase),
      retry: result.retry,
      browser: typeof testCase.browser?.projectName === 'string' ? testCase.browser.projectName : null,
      repeatEachIndex: test.repeatEachIndex,
      headline: failureHeadline(testCase.error, testCase.performanceMetrics?.steps),
    });
    if (decidesOutcome(status)) this.failuresAwaitingRetry.delete(test.id);
    if (isFailure && result.retry >= (test.retries ?? 0)) this.failureLinks.add(failedTest());
    else if (isFailure) this.failuresAwaitingRetry.set(test.id, failedTest);
    const liveRunId = this.streamManager?.runId;
    const livePage = this.streamManager?.runUrl;
    if (liveRunId != null && livePage) this.failureLinks.knowPage(liveRunId, livePage);
    if (liveRunId != null) this.failureLinks.printPending(liveRunId);

    if (this.streamManager) {
      const streamManager = this.streamManager;
      const send = () => {
        streamManager.queueEvent(toWireTestCase(testCase) as StreamEvent);
        if (this.options.liveFileUploads) streamManager.scheduleLiveUpload(testCase);
      };
      // A test waiting for its server coverage streams once it is in.
      if (coverageReady) this.coverageSends.push(coverageReady.then(send));
      else send();
    }

    const willRetry =
      result.status !== 'skipped' &&
      result.status !== 'interrupted' &&
      result.status !== test.expectedStatus &&
      result.retry < (test.retries ?? 0);
    if (this.lastTestWatch?.end(test.id, willRetry)) {
      this.coverage?.lastTestEnded();
      this.environments?.lastTestEnded();
    }
  }

  /**
   * Add up the files a test attached, and keep its resource census; for a test
   * that ran without the capture fixtures, tally the browsers, contexts and
   * pages its steps opened and closed.
   */
  private collectResources(test: TestCase, result: TestResult, testCase: CollectedTestCase): void {
    const artifacts = emptyArtifacts();
    for (const file of result.attachments ?? []) {
      if (!file.path || INTERNAL_ATTACHMENT_NAMES.has(file.name)) continue;
      try {
        const kind = artifactKind(file.name, file.contentType);
        const bytes = fs.statSync(file.path).size;
        artifacts[kind] += bytes;
        this.artifactBytes[kind] += bytes;
      } catch {
        // A file already moved or removed.
      }
    }
    const attachment = findPiwiAttachment(result.attachments, ATTACHMENT_NAMES.resources);
    const census = parseResourceCensus(attachment?.body);
    if (census) {
      this.resourceCensuses.push(census);
      const resources = executionResources(census, artifacts);
      if (resources) testCase.resources = resources;
      const leftIdle = census.closed.some((c) => c.used === false) || census.open.some((o) => o.used === false);
      if (leftIdle) this.fixturesByTest.set(test.id, userFixturesOf(result.steps ?? []));
      return;
    }
    if (!result.steps?.length) return;
    const attempt = {
      file: testFile(test, this.testPathBase),
      test: test.id,
      worker: result.workerIndex,
      failed: result.status !== test.expectedStatus,
    };
    const tally = tallyLifecycleSteps(attempt, result.steps, this.sourceLines);
    if (tally.calls.length > 0) this.lifecycleTallies.push(tally);
  }

  /**
   * Print what the run left open or opened for nothing, from the censuses and
   * the workers' shutdown file, then what the run cost the machine.
   */
  private async reportResources(): Promise<void> {
    if (this.options.captureResources === false) return;
    await this.liveResources?.stop();
    this.liveResources = null;
    const profile = this.sampler ? await this.sampler.stop() : null;
    const samples = this.sampler?.timedSeries() ?? null;
    this.sampler = null;
    const censuses = [...this.resourceCensuses];
    if (this.resourcesFile) {
      try {
        const read = readPrivateFile(this.resourcesFile);
        if (read && 'text' in read) censuses.push(...parseResourceResults(read.text));
        fs.rmSync(this.resourcesFile, { force: true });
      } catch {
        // No worker wrote one: their last tests' censuses stand in.
      }
    }
    const lines: string[] = [];
    try {
      const report =
        censuses.length > 0 || this.lifecycleTallies.length > 0
          ? buildResourceReport({ censuses, fixturesByTest: this.fixturesByTest, tallies: this.lifecycleTallies })
          : null;
      if (report) lines.push(...formatResourceSummary(report, readLeakCheck(this.options.leakCheck)));
      if (profile) {
        lines.push(
          ...formatMachinePanel(profile, { artifacts: this.artifactBytes, workers: workerHealthOf(censuses) }),
        );
      }
      if (report || profile) {
        this.resourceReport = resourceReportWire({
          report,
          profile,
          samples,
          censuses,
          artifacts: this.artifactBytes,
          shardIndex: this.shardInfo?.current ?? null,
        });
      }
    } catch (error) {
      this.logger.debug(`Resource summary skipped: ${errorMessage(error)}`);
    }
    for (const line of lines) this.logger.info(line);
    emitResourceSummary(lines, this.logger);
  }

  /**
   * Synthesize `didnotrun` cases for tests Playwright planned but never reported
   * (no `onTestEnd`) — typically because `maxFailures` cut the run short. These
   * carry no result, so they're emitted with zero duration and no error. In
   * streaming mode they're queued as complete events so the pre-finish drain
   * sends them alongside the rest. The `reason` (global timeout / max failures /
   * interrupted) is resolved once from the overall run status by the caller. A
   * test declared skipped (`test.skip()`, `test.fixme()`, a skipped describe)
   * is sent as `skipped`: it is a skip whether the run reached it or not. A test
   * of a project whose dependency failed is a `dependency-failure`, blocked by
   * that failure (`dependencyBlocker`).
   */
  private materializeUnrunTests(reason: string): void {
    for (const test of this.plannedTests) {
      if (this.reportedTestIds.has(test.id)) continue;

      const { suitePath, suiteConfig } = this.metadataCollector.getSuiteInfo(test);
      const declaredAnnotations = (test.annotations ?? []) as TestAnnotation[];
      const tags = collectTestTags(test);
      const locks = collectTestLocks(test);
      const skipped = test.expectedStatus === 'skipped';
      const blocker = skipped ? null : this.dependencyBlocker(test);
      const testCase: CollectedTestCase = {
        type: 'complete',
        testId: test.id,
        title: test.title,
        location: testLocation(test, this.testPathBase),
        status: skipped ? 'skipped' : 'didnotrun',
        duration: 0,
        timeout: test.timeout ?? null,
        error: null,
        retries: 0,
        repeatEachIndex: test.repeatEachIndex,
        workerIndex: null,
        shardIndex: this.shardInfo?.current ?? null,
        startedAt: null,
        attachments: [],
        browser: this.metadataCollector.getBrowserConfig(test) || undefined,
        suitePath,
        suiteConfig,
        testAnnotations: declaredAnnotations.length ? declaredAnnotations : null,
        tags: tags.length ? tags : null,
        locks: locks.length ? locks : null,
        testMeta: collectTestMetadata(declaredAnnotations),
        ...this.externalIdFields(test),
        didNotRunReason: skipped ? null : blocker ? 'dependency-failure' : reason,
        expectedStatus: test.expectedStatus ?? null,
        ...(blocker ? { blockedBy: blocker.location } : {}),
      };

      this.testCases.push(testCase);
      this.totalTests++;
      if (skipped) this.skippedTests++;
      else this.didNotRunTests++;

      if (this.streamManager) {
        this.streamManager.queueEvent(toWireTestCase(testCase) as StreamEvent);
      }
    }
  }

  /**
   * The failure that kept a test from running when a project its project depends on failed: the first test that failed
   * every attempt with a say in its outcome (`failedEveryAttempt`) in a project of its project's `dependencies`,
   * directly or through another project. Playwright runs no test of a project one of whose dependencies failed. Null
   * for a test whose dependencies had no such failure.
   */
  private dependencyBlocker(test: TestCase): CollectedTestCase | null {
    const project = this.metadataCollector.getBrowserConfig(test)?.projectName;
    if (typeof project !== 'string') return null;
    const dependencies = new Set<string>();
    const pending = [...(this.projectDependencies.get(project) ?? [])];
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      if (dependencies.has(name)) continue;
      dependencies.add(name);
      pending.push(...(this.projectDependencies.get(name) ?? []));
    }
    if (dependencies.size === 0) return null;
    const blocker = this.failedCases.find(
      (c) =>
        dependencies.has(c.browser?.projectName ?? '') &&
        failedEveryAttempt(this.attemptsByTest.get(c.testId ?? '') ?? []),
    );
    return blocker ?? null;
  }

  /**
   * Playwright reporter hook: called when the full test run finishes. Fails the run when two tests share an external
   * ID and `externalId.onDuplicate` is `'fail'`.
   */
  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | void> {
    this.stopNotes?.stop();
    this.stopNotes = null;
    await this.hubLink?.end(result?.status ?? 'other');
    this.terminalProgress?.end();
    this.terminalProgress = null;
    this.noteOtherUncaptured();
    const duplicates = this.externalIds?.duplicates.length ?? 0;
    const failsOnDuplicates =
      duplicates > 0 && resolveOnDuplicate(this.options.externalId?.onDuplicate).onDuplicate === 'fail';
    // The dashboard records the status the run exits with, so its gate and pull-request feedback agree with CI. A
    // run that already failed, timed out or was interrupted keeps its own status.
    const overridden = failsOnDuplicates && result?.status === 'passed';
    await this.finishRun(overridden ? { ...result, status: 'failed' } : result);
    if (failsOnDuplicates) {
      this.logger.error(
        `Failing the run: ${duplicates} external ID${duplicates === 1 ? ' is' : 's are'} declared by more than one test.`,
      );
      return { status: 'failed' };
    }
  }

  /** Every environment snapshot of the run; none when collection is off or reading them failed. */
  private async readEnvironments(): Promise<WireEnvironmentSnapshot[] | undefined> {
    try {
      return await this.environments?.atEnd();
    } catch (error) {
      this.logger.debug(`Environment snapshots skipped: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async finishRun(result: FullResult): Promise<void> {
    if (this.listMode || !this.enabled) return;
    // `onBegin` never ran: the run stopped before its tests (a global setup threw, a spec did not load).
    if (this.startTime === null) {
      this.logger.debug('The run stopped before any test began — nothing to report.');
      // Nothing begins the run the global setup registered: its setup file, this process's alone, goes.
      readSetupInfo(this.options.projectName!);
      return;
    }

    // Every test's coverage first, so each test streams, or is submitted, with it.
    if (this.coverage) {
      await this.coverage.settle();
      await Promise.all(this.coverageSends);
      // Fetched while the run is submitted, sent once its id is known.
      this.coverage.fetchRunCoverage();
    }

    // Tests Playwright never reported were cut off by a run-level condition —
    // the global timeout, the failure budget, or an interruption — or by a
    // failed project they depend on.
    const unrunReason = resolveUnrunReason(result?.status, {
      maxFailures: this.maxFailures,
      failures: this.failedTestCount,
    });
    // Neither throws out of `onEnd`, where Playwright would count the error as a failure of the run: the run is
    // reported with what was collected.
    try {
      // A failed attempt followed by none with a say in the outcome is its test's last failure.
      for (const failedTest of this.failuresAwaitingRetry.values()) this.failureLinks.add(failedTest());
      this.materializeUnrunTests(unrunReason);
    } catch (error) {
      this.logger.error(`Could not add the tests that did not run: ${errorMessage(error)}`);
    }
    try {
      // Printed before the submit, so a slow or failed upload never hides it.
      await this.reportResources();
    } catch (error) {
      this.logger.debug(`Resource summary skipped: ${errorMessage(error)}`);
    }

    try {
      const submitted = await this.submitter.submit(
        {
          options: this.options,
          testCases: this.testCases,
          startTime: this.startTime,
          playwrightVersion: this.playwrightVersion,
          reporterVersion: this.reporterVersion,
          totalTests: this.totalTests,
          passedTests: this.passedTests,
          failedTests: this.failedTests,
          skippedTests: this.skippedTests,
          timedOutTests: this.timedOutTests,
          didNotRunTests: this.didNotRunTests,
          metadata: this.metadata,
          instanceId: this.instanceId,
          shardInfo: this.shardInfo,
          setupSteps: this.setupSteps,
          isFullRun: this.isFullRun,
          filterDetails: this.filterDetails,
          resourceReport: this.resourceReport,
          htmlReport: this.htmlReport,
          runErrors: this.runErrors,
          environments: await this.readEnvironments(),
        },
        result,
      );
      // A requested run's token starts the run alone: coverage and manifests are not taken from it.
      const requested = this.requestedRun.instance !== null;
      if (submitted && this.coverage && !requested) {
        await this.coverage.sendRunCoverage(this.httpClient, submitted.runId, submitted.auth);
      }
      if (submitted && this.manifests && !requested) {
        const branch = resolveScmBranch(process.env) ?? null;
        await this.manifests.upload(this.httpClient, submitted.auth, this.options.projectName, branch);
      }
    } catch (error) {
      // Playwright counts an error thrown by a reporter as a failure of the
      // run: reaching the dashboard never decides whether the tests passed.
      this.logger.error(`Could not report the run to the dashboard: ${errorMessage(error)}`);
    } finally {
      this.coverage?.close();
      // Body-only attachments were staged as temp files for the uploads above.
      this.fileHandler.cleanupBodyAttachments();
    }
  }
}
