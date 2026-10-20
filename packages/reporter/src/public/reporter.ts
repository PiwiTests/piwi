import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FullConfig, Suite, TestCase, TestResult, FullResult, TestStep } from '@playwright/test/reporter';
import {
  resolveOptions,
  usedDesktopDiscovery,
  PIWI_DEFAULTED_CAPTURE_ENV,
  PIWI_ENV_KEYS,
  PIWI_RESOURCES_RESULTS_ENV,
} from '../internal/config/env.js';
import type { PiwiDashboardOptions, ShardInfo } from './options.js';
import { HttpClient } from '../internal/transport/http-client.js';
import { Uploader } from '../internal/submit/uploader.js';
import { StreamBuffer } from '../internal/streaming/stream-buffer.js';
import { CrashRecovery } from '../internal/streaming/crash-recovery.js';
import { FileHandler } from '../internal/files/file-handler.js';
import { ATTACHMENT_NAMES, INTERNAL_ATTACHMENT_NAMES } from '../internal/capture/attachments.js';
import { MetadataCollector, resolveScmBranch } from '../internal/collect/metadata-collector.js';
import { StreamManager } from '../internal/streaming/stream-manager.js';
import { collectStepMetrics, extractTestStepEvents, extractWaitEvents } from '@piwitests/core/step-analysis';
import { computeInstanceId } from '../internal/support/instance-id.js';
import { getReporterVersion } from '../internal/support/reporter-version.js';
import { collectSourceFrames, extractFailingLine, readSourceSnippet } from '../internal/support/source-snippet.js';
import { resolveRunLabel } from '../internal/support/ci.js';
import { workerIndexOf } from '../internal/support/worker-index.js';
import { detectCliFileFilters } from '../internal/support/cli-filters.js';
import { readSelectionStamp } from '../internal/support/selection-env.js';
import { resolveShardInfo } from '../internal/support/shard-info.js';
import { isListMode } from '../internal/support/run-mode.js';
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
import { collectTestLocks, collectTestMetadata, collectTestTags } from '../internal/collect/test-meta.js';
import { formatExternalIdDuplicates, planExternalIds, type ExternalIdPlan } from '../internal/collect/external-ids.js';
import { buildErrorText } from '../internal/collect/error-text.js';
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
import { executionResources, resourceReportWire } from '../internal/collect/resource-wire.js';
import {
  artifactKind,
  emptyArtifacts,
  formatMachinePanel,
  workerHealthOf,
  type ArtifactBytes,
} from '../internal/collect/machine-panel.js';
import { FailureLinks, failureHeadline } from '../internal/support/failure-links.js';
import { coverageSettings, type CoverageSettings } from '../internal/collect/coverage-settings.js';
import { CoverageCollection, LastTestWatch } from '../internal/collect/test-coverage.js';
import { baseUrlsFromConfig, ignoresHttpsErrors } from '../internal/collect/server-coverage.js';
import { backendManifestFetch } from '../internal/manifest/collect.js';
import { configDirFromConfig, relativeTestPath } from '../internal/support/test-paths.js';
import { RunManifests } from '../internal/manifest/run-manifests.js';
import type {
  CollectedTestCase,
  StreamEvent,
  SetupStep,
  FilterDetails,
  TestAnnotation,
  WireResourceReport,
} from '../types.js';

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
  private startTime: string | null = null;
  private playwrightVersion: string | null = null;
  private readonly reporterVersion = getReporterVersion();
  private totalTests = 0;
  private passedTests = 0;
  private failedTests = 0;
  private skippedTests = 0;
  private timedOutTests = 0;
  private didNotRunTests = 0;
  /** Full set of tests Playwright planned to run this shard (captured in `onBegin`). */
  private plannedTests: TestCase[] = [];
  /** Ids of tests that actually reported via `onTestEnd`, to find the ones that never ran. */
  private reportedTestIds = new Set<string>();
  /** Per-test attempt history, keyed by `test.id`; snapshotted onto every attempt's payload. */
  private attemptsByTest = new Map<
    string,
    Array<{ retry: number; status: string; duration: number; startedAt: number | null }>
  >();
  /** The folder test files are named relative to: the Playwright config's, set in `onBegin`. */
  private testPathBase = process.cwd();
  /** Derived in `onBegin`, once the shard is known. */
  private instanceId = '';
  private shardInfo: ShardInfo | null = null;
  private metadata: Record<string, any> = {};
  /** Each planned test's external ID and the IDs two tests share, settled in `onBegin`. */
  private externalIds: ExternalIdPlan | null = null;
  private enabled: boolean;
  /**
   * True under `playwright test --list`, where Playwright still constructs this
   * reporter and fires `onBegin`/`onEnd` but runs no tests. Registering and
   * finalizing a run would create an empty phantom run and upload an empty report.
   */
  private readonly listMode: boolean;
  /** True when the server URL and API key came from the desktop app, not from config. */
  private viaDesktopApp: boolean;
  private isFullRun = true;
  private filterDetails: FilterDetails | null = null;
  /** Configured `maxFailures` (0 = unlimited) — disambiguates an interrupted run's unrun reason. */
  private maxFailures = 0;
  /** The resource censuses the capture fixtures attached, one per test attempt. */
  private resourceCensuses: ResourceCensus[] = [];
  /** Lifecycle steps of the tests that ran without the fixtures. */
  private lifecycleTallies: LifecycleTally[] = [];
  /** The user fixtures set up by the tests that left a page unused, by test id. */
  private fixturesByTest = new Map<string, string[]>();
  /** The file workers append their shutdown census to, set in `onBegin`. */
  private resourcesFile: string | null = null;
  /** Samples the run's processes and the machine from `onBegin` to `onEnd`. */
  private sampler: RunSampler | null = null;
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
  /** Result events that stream once their test's server coverage is in. */
  private coverageSends: Array<Promise<void>> = [];

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
    this.options = resolveOptions(rawOptions);
    this.enabled = this.options.enabled !== false && !!this.options.serverUrl;
    this.listMode = isListMode();
    this.viaDesktopApp = usedDesktopDiscovery();
    this.coverageSettings = coverageSettings(this.options);

    const logger = new Logger(this.options.verbose ?? false);
    this.logger = logger;
    this.httpClient = new HttpClient(this.options.serverUrl ?? 'http://localhost:3000', logger);
    this.fileHandler = new FileHandler(logger);
    this.uploader = new Uploader(this.httpClient, this.fileHandler, logger);
    this.recovery = new CrashRecovery(this.httpClient.baseUrl, this.options.projectName!, logger);
    this.metadataCollector = new MetadataCollector(logger);
    this.failureLinks = new FailureLinks(this.httpClient.baseUrl, logger);

    const streamBuffer = new StreamBuffer(this.options.projectName!);
    streamBuffer.clearStale();

    if (this.options.streaming) {
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
    if (!this.enabled) {
      this.logger.info('Not enabled — set PIWI_DASHBOARD_URL or serverUrl to enable.');
      return;
    }
    // Nothing in the config pointed at a server, so results are going to the
    // desktop app found on this machine — say so rather than uploading silently.
    if (this.viaDesktopApp) {
      this.logger.info(`Using the desktop app running at ${this.options.serverUrl} (no serverUrl configured).`);
    }
    this.startTime = new Date().toISOString();
    this.testPathBase = configDirFromConfig(config);
    this.playwrightVersion = config.version;
    this.maxFailures = config.maxFailures ?? 0;

    // Workers inherit the environment when they start, after this hook: the
    // shutdown census of each one lands in this file, read back in `onEnd`.
    if (this.options.captureResources !== false) {
      this.resourcesFile = path.join(os.tmpdir(), `piwi-resources-${process.pid}-${Date.now()}.jsonl`);
      process.env[PIWI_RESOURCES_RESULTS_ENV] = this.resourcesFile;
      try {
        this.sampler = new RunSampler({ outputDirs: (config.projects ?? []).map((project) => project.outputDir) });
        this.sampler.start();
      } catch (error) {
        this.sampler = null;
        this.logger.debug(`Run sampler not started: ${errorMessage(error)}`);
      }
    }
    this.logger.info(
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
    // Playwright's default grep is /.*/ (matches everything) — only a non-default pattern is a real filter.
    const grep = grepRe && grepRe.source !== '.*' ? grepRe.source : undefined;
    const grepInvert = grepInvertRe?.source;
    // File/path filters come from the CLI invocation, not config.grep.
    const fileFilters = detectCliFileFilters();
    // A run launched by `piwi run <key>` carries the resolved selection's
    // identity in the environment; stamp it so the dashboard can name the
    // subset and a gate can re-resolve the same definition.
    const selection = readSelectionStamp();
    if (grep || grepInvert || fileFilters.length > 0 || selection) {
      this.isFullRun = false;
      this.filterDetails = {
        ...(grep ? { grep } : {}),
        ...(grepInvert ? { grepInvert } : {}),
        ...(fileFilters.length > 0 ? { files: fileFilters } : {}),
        ...(selection ? { selection } : {}),
      };
      this.logger.info(
        selection ? `Selection run detected (${selection.key})` : 'Partial run detected (filter active)',
      );
    }

    this.metadata = this.metadataCollector.collect(config, suite, this.options);

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

    // Detect the shard: Playwright's --shard=1/3, or the one `piwi run --shard` set.
    this.shardInfo = resolveShardInfo(config);
    if (this.shardInfo) {
      this.logger.info(`Shard ${this.shardInfo.current}/${this.shardInfo.total} detected`);
    }
    this.instanceId = computeInstanceId(
      this.options.projectName!,
      resolveRunLabel(this.options.runLabel, this.shardInfo !== null),
    );

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
    if (coverage.server !== 'off') this.lastTestWatch = new LastTestWatch(this.plannedTests.length);
    if (coverage.browser !== 'off' || coverage.server !== 'off') {
      if (coverage.browser !== 'off') process.env[PIWI_ENV_KEYS.coverageBrowser] = coverage.browser;
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
    );
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
    for (const line of formatExternalIdDuplicates(plan.duplicates, options.onDuplicate ?? 'report'))
      this.logger.warn(line);
    if (plan.duplicates.length > 0) this.metadata = { ...this.metadata, externalIdDuplicates: plan.duplicates };
    this.externalIds = plan;
  }

  /** The external ID fields of a test's payload: `null` tells the dashboard the test has none to match on. */
  private externalIdFields(test: TestCase): { externalId?: string | null; displayTitle?: string | null } {
    if (!this.externalIds) return {};
    const id = this.externalIds.byTestId.get(test.id);
    return { externalId: id?.externalId ?? null, displayTitle: id?.displayTitle ?? null };
  }

  /** Playwright reporter hook: called when an individual test begins */
  onTestBegin(test: TestCase, result: TestResult): void {
    this.lastTestWatch?.begin(test.id);
    const { suitePath, suiteConfig } = this.metadataCollector.getSuiteInfo(test);
    const beginEvent: CollectedTestCase = {
      type: 'begin',
      title: test.title,
      location: testLocation(test, this.testPathBase),
      workerIndex: workerIndexOf(result),
      shardIndex: this.shardInfo?.current ?? null,
      browser: this.metadataCollector.getBrowserConfig(test) || undefined,
      suitePath,
      suiteConfig,
    };

    if (this.streamManager) {
      this.streamManager.queueBeginEvent(toWireTestCase(beginEvent) as StreamEvent);
    }
  }

  /** Track suite-level setup steps (beforeAll/afterAll) not tied to any test */
  private setupSteps: SetupStep[] = [];

  /** Step categories streamed live while the run executes. */
  private static readonly LIVE_STEP_CATEGORIES = new Set(['hook', 'fixture', 'pw:api', 'expect']);

  /**
   * Whether a step streams live: its category is in `LIVE_STEP_CATEGORIES`
   * and no ancestor is an `expect` step. The steps inside an assertion are its
   * polling — every `expect.poll` attempt and `toPass` retry — not a step a
   * human watches; the meaningful readout is the assertion around them.
   */
  private static isLiveStep(step: TestStep): boolean {
    if (!PiwiDashboardReporter.LIVE_STEP_CATEGORIES.has(step.category)) return false;
    for (let parent = step.parent; parent; parent = parent.parent) {
      if (parent.category === 'expect') return false;
    }
    return true;
  }

  /** Playwright reporter hook: called when a step (including hook/fixture) begins */
  onStepBegin(test: TestCase | undefined, _result: TestResult | undefined, step: any): void {
    // Gate on the stream manager *existing*, not on it being live yet: the
    // first fixtures and hooks run while `/start` is still in flight, and
    // `queueBeginEvent` buffers until the run id lands (same as `onTestBegin`).
    if (!this.enabled || !this.streamManager) return;
    if (!PiwiDashboardReporter.isLiveStep(step)) return;
    const cat = step.category;

    const event: StreamEvent = {
      type: 'step-begin',
      title: step.title,
      subtitle: typeof step.subtitle === 'string' && step.subtitle.length > 0 ? step.subtitle : null,
      location: step.location ? `${step.location.file}:${step.location.line}:${step.location.column}` : 'unknown',
      stepCategory: cat,
      parentTitle: test?.title || null,
      workerIndex: workerIndexOf(_result),
      startedAt: step.startTime instanceof Date ? step.startTime.getTime() : null,
    };
    this.streamManager?.queueBeginEvent(event);
  }

  /** Playwright reporter hook: called when a step (including hook/fixture) ends */
  onStepEnd(test: TestCase | undefined, _result: TestResult | undefined, step: any): void {
    if (!this.enabled || !this.streamManager) return;
    if (!PiwiDashboardReporter.isLiveStep(step)) return;
    const cat = step.category;

    const workerIndex = workerIndexOf(_result);
    const startedAt = step.startTime instanceof Date ? step.startTime.getTime() : null;

    const event: StreamEvent = {
      type: 'step-end',
      title: step.title,
      subtitle: typeof step.subtitle === 'string' && step.subtitle.length > 0 ? step.subtitle : null,
      location: step.location ? `${step.location.file}:${step.location.line}:${step.location.column}` : 'unknown',
      status: step.error ? 'failed' : 'passed',
      duration: step.duration || 0,
      stepCategory: cat,
      parentTitle: test?.title || null,
      workerIndex,
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
    this.totalTests++;

    this.reportedTestIds.add(test.id);

    const { suitePath, suiteConfig } = this.metadataCollector.getSuiteInfo(test);
    const annotations = mergeAnnotations(test, result);
    const status = classifyStatus(result.status, annotations);
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
      error: expectedFailureError(result.status, annotations) ?? buildErrorText(result, this.testPathBase),
      retries: result.retry,
      attempts: attempts.map((a) => ({ ...a })),
      workerIndex: workerIndexOf(result),
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
    };

    if (result.status === 'failed' || result.status === 'timedOut') {
      const failingLine = extractFailingLine(testCase.error, test.location.file, test.location.line);
      const snippet = readSourceSnippet(test.location.file, test.location.line, 30, failingLine);
      if (snippet) testCase.testSource = snippet;
      // The call stack's in-project frames (innermost first) — the failing line
      // plus the callers above it, so a failure inside a helper is visible.
      const frames = collectSourceFrames(testCase.error, test.location.file, test.location.line);
      if (frames.length) testCase.testSourceFrames = frames;
    }

    if (this.options.collectPerformanceMetrics && result.steps?.length > 0) {
      testCase.performanceMetrics = collectStepMetrics(result.steps, result.errors);
      const stepEvents = extractTestStepEvents(result.steps, result.startTime);
      const waitEvents = extractWaitEvents(result.steps);
      const allEvents = [...stepEvents, ...waitEvents];
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
          ? result.attachments.find((a: any) => a.name === ATTACHMENT_NAMES.locators)
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
          ? result.attachments.find((a: any) => a.name === ATTACHMENT_NAMES.locatorPages)
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
        ? result.attachments.find((a: any) => a.name === ATTACHMENT_NAMES.codeReach)
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

    this.testCases.push(testCase);

    // A cascade's blocking failure has already reported (serial execution runs
    // it first), so resolve `blockedBy` now — the streamed event then carries
    // the link even though the whole run isn't collected yet.
    if (status === 'didnotrun') linkBlockedTests(this.testCases);

    // The final attempt of a failing test gets a dashboard link, printed as
    // soon as a run id exists (immediately while streaming, after the submit otherwise).
    const isFailure = status === 'failed' || status === 'timedOut';
    if (isFailure && result.retry >= (test.retries ?? 0)) {
      this.failureLinks.add({
        title: test.title,
        file: testFile(test, this.testPathBase),
        retry: result.retry,
        browser: typeof testCase.browser?.projectName === 'string' ? testCase.browser.projectName : null,
        headline: failureHeadline(testCase.error, testCase.performanceMetrics?.steps),
      });
    }
    const liveRunId = this.streamManager?.runId;
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
    }
  }

  /**
   * Add up the files a test attached, and keep its resource census; for a test
   * that ran without the capture fixtures, tally the browsers and contexts its
   * steps opened and closed.
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
    const attachment = result.attachments?.find((a) => a.name === ATTACHMENT_NAMES.resources);
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
    const tally = tallyLifecycleSteps(testFile(test, this.testPathBase), result.steps);
    if (tally.opened.length > 0 || tally.closed.context > 0 || tally.closed.browser > 0)
      this.lifecycleTallies.push(tally);
  }

  /**
   * Print what the run left open or opened for nothing, from the censuses and
   * the workers' shutdown file, then what the run cost the machine.
   */
  private async reportResources(): Promise<void> {
    if (this.options.captureResources === false) return;
    const profile = this.sampler ? await this.sampler.stop() : null;
    const samples = this.sampler?.timedSeries() ?? null;
    this.sampler = null;
    const censuses = [...this.resourceCensuses];
    if (this.resourcesFile) {
      try {
        censuses.push(...parseResourceResults(fs.readFileSync(this.resourcesFile, 'utf8')));
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
   * interrupted) is resolved once from the overall run status by the caller.
   */
  private materializeUnrunTests(reason: string): void {
    for (const test of this.plannedTests) {
      if (this.reportedTestIds.has(test.id)) continue;

      const { suitePath, suiteConfig } = this.metadataCollector.getSuiteInfo(test);
      const declaredAnnotations = (test.annotations ?? []) as TestAnnotation[];
      const tags = collectTestTags(test);
      const locks = collectTestLocks(test);
      const testCase: CollectedTestCase = {
        type: 'complete',
        testId: test.id,
        title: test.title,
        location: testLocation(test, this.testPathBase),
        status: 'didnotrun',
        duration: 0,
        timeout: test.timeout ?? null,
        error: null,
        retries: 0,
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
        didNotRunReason: reason,
        expectedStatus: test.expectedStatus ?? null,
      };

      this.testCases.push(testCase);
      this.totalTests++;
      this.didNotRunTests++;

      if (this.streamManager) {
        this.streamManager.queueEvent(toWireTestCase(testCase) as StreamEvent);
      }
    }
  }

  /**
   * Playwright reporter hook: called when the full test run finishes. Fails the run when two tests share an external
   * ID and `externalId.onDuplicate` is `'fail'`.
   */
  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | void> {
    await this.finishRun(result);
    const duplicates = this.externalIds?.duplicates.length ?? 0;
    if (duplicates > 0 && this.options.externalId?.onDuplicate === 'fail') {
      this.logger.error(
        `Failing the run: ${duplicates} external ID${duplicates === 1 ? ' is' : 's are'} declared by more than one test.`,
      );
      return { status: 'failed' };
    }
  }

  private async finishRun(result: FullResult): Promise<void> {
    if (this.listMode || !this.enabled) return;
    // `onBegin` never ran: the run stopped before its tests (a global setup threw, a spec did not load).
    if (this.startTime === null) {
      this.logger.debug('The run stopped before any test began — nothing to report.');
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
    // the global timeout, the failure budget, or an interruption.
    const unrunReason = resolveUnrunReason(result?.status, {
      maxFailures: this.maxFailures,
      failures: this.failedTests + this.timedOutTests,
    });
    this.materializeUnrunTests(unrunReason);
    // Printed before the submit, so a slow or failed upload never hides it.
    await this.reportResources();

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
        },
        result,
      );
      if (submitted && this.coverage) {
        await this.coverage.sendRunCoverage(this.httpClient, submitted.runId, submitted.auth);
      }
      if (submitted && this.manifests) {
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
