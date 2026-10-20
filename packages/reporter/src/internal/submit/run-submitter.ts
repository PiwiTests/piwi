import { randomUUID } from 'node:crypto';
import type { FullResult } from '@playwright/test/reporter';
import type { PiwiDashboardOptions, ShardInfo } from '../../public/options.js';
import { errorMessage } from '../support/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import { HttpError } from '../transport/http-client.js';
import type { Uploader, RunPayload, ReportOptions } from './uploader.js';
import type { CrashRecovery } from '../streaming/crash-recovery.js';
import type { StreamManager } from '../streaming/stream-manager.js';
import { Logger } from '../support/logger.js';
import { computePerformanceSummary } from '@piwitests/core/step-analysis';
import { computeDistinctRunCounts, resolveOverallStatus, serializeRun } from './serializer.js';
import { runUrl } from '../support/run-url.js';
import { emitRunOutputs, ciBuildUrlFromMetadata, type RunOutput } from '../support/ci-output.js';
import type { FailureLinks } from '../support/failure-links.js';
import type { CollectedTestCase, SetupStep, FilterDetails, WireResourceReport } from '../../types.js';

/** Longest delay `setTimeout` supports; a larger one fires at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Result of one rung of the submit ladder. `done` stops the ladder (the run
 * landed, or the last rung was reached); `output` carries the run identity to
 * surface to CI, and is `null` when a rung failed or the server returned no run
 * id.
 */
interface SubmitOutcome {
  done: boolean;
  output: RunOutput | null;
}

/**
 * Snapshot of everything the reporter has collected by `onEnd`, handed off to
 * the `RunSubmitter` so the reporter itself stays a thin collect-and-hand-off
 * shell.
 */
export interface CollectedRun {
  options: PiwiDashboardOptions;
  testCases: CollectedTestCase[];
  startTime: string | null;
  playwrightVersion: string | null;
  reporterVersion: string | null;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  timedOutTests: number;
  didNotRunTests: number;
  metadata: Record<string, any>;
  instanceId: string;
  shardInfo: ShardInfo | null;
  setupSteps: SetupStep[];
  isFullRun: boolean;
  filterDetails: FilterDetails | null;
  /** The run's resource findings and machine profile, from `onEnd`; null when not measured. */
  resourceReport?: WireResourceReport | null;
}

/** The run the dashboard took, and the credential that reached it. */
export interface SubmittedRun {
  runId: number | string;
  auth: string | null;
}

/** Why the reporter left the rung it would normally deliver a run through. */
type SubmitFallbackReason = 'results-lost' | 'finish-failed' | 'upload-failed';

/**
 * Name the fallback rung in the run's `metadata.ingestHealth`, where the
 * dashboard shows how the run was delivered.
 */
function markSubmitFallback(run: CollectedRun, path: 'upload' | 'submit', reason: SubmitFallbackReason): void {
  run.metadata.ingestHealth = { submitFallback: { path, reason } };
}

/**
 * Owns the three-tier submit/fallback ladder:
 *
 *   1. finalize the streaming run (`/finish`) when streaming is active,
 *   2. fall back to multipart upload (`/upload`) when there are reports or
 *      traces to attach,
 *   3. fall back to plain JSON (`/submit`) as the last resort, persisting a
 *      recovery payload on total failure.
 */
export class RunSubmitter {
  /** The key every batch delivery of this run carries, so the dashboard stores the run once. */
  private readonly deliveryKey = randomUUID();

  /**
   * @param httpClient    HTTP client for auth resolution and the finish call.
   * @param uploader      Upload strategies (multipart + JSON).
   * @param recovery      Crash-recovery persistence.
   * @param streamManager Streaming session (may be `null` when streaming is disabled).
   * @param logger        Prefixed logger.
   * @param failureLinks  Failed tests collected during the run, for the per-failure links.
   */
  constructor(
    private readonly httpClient: HttpClient,
    private readonly uploader: Uploader,
    private readonly recovery: CrashRecovery,
    private readonly streamManager: StreamManager | null,
    private readonly logger: Logger = new Logger(),
    private readonly failureLinks: FailureLinks | null = null,
  ) {}

  /**
   * Run the fallback ladder for a completed test run, within the
   * `submitTimeout` budget. When the budget runs out, every request in flight
   * and every later one fails, so the ladder falls through to saving the
   * recovery copy. Returns the run the dashboard took, or null when none did
   * or it named no run id.
   */
  async submit(run: CollectedRun, result: FullResult): Promise<SubmittedRun | null> {
    const budgetMs = run.options.submitTimeout ?? 0;
    const timer =
      budgetMs > 0 && Number.isFinite(budgetMs)
        ? setTimeout(() => this.expireBudget(budgetMs), Math.min(budgetMs, MAX_TIMER_DELAY_MS))
        : null;
    try {
      return await this.submitRun(run, result);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private expireBudget(budgetMs: number): void {
    this.logger.warn(
      `The dashboard did not take the run within ${Math.round(budgetMs / 1000)}s (submitTimeout) — stopping the upload and saving the results locally.`,
    );
    this.httpClient.close(`the end-of-run time budget (submitTimeout: ${budgetMs} ms) ran out`);
  }

  private async submitRun(run: CollectedRun, result: FullResult): Promise<SubmittedRun | null> {
    const endTime = new Date().toISOString();
    const duration = new Date(endTime).getTime() - new Date(run.startTime!).getTime();

    // Playwright reports each attempt through `onTestEnd`, so the collected
    // counters tally attempts. Collapse them to distinct-test counts before
    // anything reads them, so the submitted summary (and every fallback rung)
    // counts tests, not attempts, and a retried-then-passed test is a pass.
    const counts = computeDistinctRunCounts(run.testCases);
    run.totalTests = counts.totalTests;
    run.passedTests = counts.passedTests;
    run.failedTests = counts.failedTests;
    run.timedOutTests = counts.timedOutTests;
    run.skippedTests = counts.skippedTests;
    run.didNotRunTests = counts.didNotRunTests;

    const overallStatus = resolveOverallStatus(result, {
      failedTests: run.failedTests,
      timedOutTests: run.timedOutTests,
      totalTests: run.totalTests,
    });

    this.logger.info(
      `Test run completed. Status: ${overallStatus} (Playwright result.status: ${result?.status || 'undefined'})`,
    );
    this.logger.info(
      `Total: ${run.totalTests}, Passed: ${run.passedTests}, Failed: ${run.failedTests}, Skipped: ${run.skippedTests}, TimedOut: ${run.timedOutTests}, DidNotRun: ${run.didNotRunTests}`,
    );

    if (run.options.collectPerformanceMetrics) {
      run.metadata.performance = computePerformanceSummary(run.testCases);
    }

    const sm = this.streamManager;
    if (sm?.startPromise) await sm.startPromise;
    await sm?.drain();

    let auth: string | null;
    try {
      auth = sm?.auth ?? (await this.httpClient.resolveAuth(run.options));
    } catch (error) {
      this.logger.error(`Authentication failed: ${errorMessage(error)}`);
      this.logRecoverySaved();
      this.saveRecovery(this.buildRunPayload(run, overallStatus, duration));
      return null;
    }

    // A streaming session retries the recovery file when it opens; without one,
    // retry it here so a saved payload still reaches the server.
    if (!sm) await this.recovery.tryUpload(this.httpClient, auth);

    let outcome: SubmitOutcome = { done: false, output: null };
    // Why the run is not delivered by the rung it would normally take, once a rung failed.
    let fallbackReason: SubmitFallbackReason | null = null;

    // When test-result events never reached the server through the live stream,
    // the server is missing that detail; finalizing with `/finish` would lock it
    // in. Fall through to the batch upload, which re-sends the full run from the
    // reporter's own in-memory collection, so the missing detail is recovered.
    if (sm?.enabled && sm?.runId != null) {
      if (sm.lostResults) fallbackReason = 'results-lost';
      else {
        outcome = await this.tryFinishStreaming(run, overallStatus, duration, auth);
        if (!outcome.done) fallbackReason = 'finish-failed';
      }
    }

    // Once the time budget closed the client, the multipart upload is skipped:
    // the JSON rung below fails at once and saves the recovery copy.
    if (!outcome.done && !this.httpClient.closed && (this.hasReports(run) || run.options.uploadTraces)) {
      if (fallbackReason) markSubmitFallback(run, 'upload', fallbackReason);
      outcome = await this.tryUploadWithFiles(run, overallStatus, duration, auth);
      if (!outcome.done) fallbackReason = 'upload-failed';
    }

    if (!outcome.done) {
      if (fallbackReason) markSubmitFallback(run, 'submit', fallbackReason);
      outcome = await this.tryUploadJSON(run, overallStatus, duration, auth);
    }

    if (!outcome.output) return null;
    // Failures that had no run id yet (batch mode, or a stream that never
    // opened) get their link lines now, ahead of the run URL.
    this.failureLinks?.printPending(outcome.output.runId);
    emitRunOutputs(outcome.output, this.logger, run.options.outputFile);
    return { runId: outcome.output.runId, auth };
  }

  /** Assemble a CI-facing run output, or `null` when the server returned no run id. */
  private buildOutput(
    runId: number | string | undefined,
    projectId: number | string | undefined,
    run: CollectedRun,
    status: string,
  ): RunOutput | null {
    if (runId == null) return null;
    return {
      runUrl: runUrl(this.httpClient.baseUrl, runId),
      runId,
      projectId,
      projectName: run.options.projectName!,
      status,
      ciBuildUrl: ciBuildUrlFromMetadata(run.metadata),
      failures: this.failureLinks?.resolve(runId) ?? [],
    };
  }

  private hasReports(run: CollectedRun): boolean {
    return !!run.options.uploadReport || (run.options.reports?.length ?? 0) > 0;
  }

  private reportOptions(run: CollectedRun): ReportOptions {
    return {
      uploadTraces: run.options.uploadTraces,
      uploadReport: run.options.uploadReport,
      reports: run.options.reports,
    };
  }

  private buildRunPayload(run: CollectedRun, status: string, duration: number): RunPayload {
    return {
      projectName: run.options.projectName!,
      projectDescription: run.options.projectDescription,
      status,
      startTime: run.startTime,
      duration,
      totalTests: run.totalTests,
      passedTests: run.passedTests,
      failedTests: run.failedTests,
      timedOutTests: run.timedOutTests,
      skippedTests: run.skippedTests,
      didNotRunTests: run.didNotRunTests,
      environment: run.options.environment,
      label: run.options.label || null,
      keep: run.options.keep === true,
      metadata: run.metadata,
      instanceId: run.instanceId,
      playwrightVersion: run.playwrightVersion ?? undefined,
      reporterVersion: run.reporterVersion ?? undefined,
      testCases: run.testCases,
      shardIndex: run.shardInfo?.current,
      shardTotal: run.shardInfo?.total,
      isFullRun: run.isFullRun,
      filterDetails: run.filterDetails,
      resourceReport: run.resourceReport ?? null,
      deliveryKey: this.deliveryKey,
    };
  }

  private async tryFinishStreaming(
    run: CollectedRun,
    overallStatus: string,
    duration: number,
    auth: string | null,
  ): Promise<SubmitOutcome> {
    const sm = this.streamManager!;
    try {
      const flakyTests = run.testCases.filter((tc) => tc.status === 'passed' && (tc.retries || 0) > 0).length;
      const durations = run.testCases.filter((tc) => tc.duration != null).map((tc) => tc.duration as number);

      await sm.uploadRemaining(run.testCases);

      const finishBody: Record<string, unknown> = {
        streamToken: sm.token,
        status: overallStatus,
        duration,
        totalTests: run.totalTests,
        passedTests: run.passedTests,
        failedTests: run.failedTests,
        timedOutTests: run.timedOutTests,
        skippedTests: run.skippedTests,
        didNotRunTests: run.didNotRunTests,
        flakyTests,
        durations,
        label: run.options.label || null,
        keep: run.options.keep === true,
        metadata: run.metadata,
        hasPendingUploads: this.hasReports(run),
        playwrightVersion: run.playwrightVersion ?? undefined,
        reporterVersion: run.reporterVersion ?? undefined,
        setupSteps: run.setupSteps.length > 0 ? run.setupSteps : undefined,
        isFullRun: run.isFullRun,
        filterDetails: run.filterDetails ?? null,
      };
      if (run.resourceReport) finishBody.resourceReport = run.resourceReport;
      if (run.shardInfo) {
        finishBody.shardIndex = run.shardInfo.current;
        finishBody.shardTotal = run.shardInfo.total;
      }

      await this.httpClient.postJSON(`/api/test-runs/${sm.runId}/finish`, finishBody, auth);

      this.logger.info(`Successfully finalized streaming run #${sm.runId}`);
      this.dropLocalCopies();

      if (this.hasReports(run)) {
        try {
          await this.uploader.uploadReportsForStreamingRun(
            run.options.projectName!,
            sm.runId!,
            this.reportOptions(run),
            run.startTime,
            auth,
          );
        } catch (error) {
          this.logger.warn(`Failed to upload reports for streaming run: ${errorMessage(error)}`);
        }
      }
      return { done: true, output: this.buildOutput(sm.runId!, undefined, run, overallStatus) };
    } catch (error) {
      this.logger.warn(`Failed to finalize streaming run: ${errorMessage(error)}`);
      this.logger.info('Falling back to batch upload...');
      return { done: false, output: null };
    }
  }

  private async tryUploadWithFiles(
    run: CollectedRun,
    overallStatus: string,
    duration: number,
    auth: string | null,
  ): Promise<SubmitOutcome> {
    const payload = this.buildRunPayload(run, overallStatus, duration);
    try {
      const response = await this.uploader.uploadWithFiles(payload, this.reportOptions(run), auth);
      this.dropLocalCopies();
      return { done: true, output: this.buildOutput(response?.runId, response?.projectId, run, overallStatus) };
    } catch (error) {
      if (error instanceof HttpError && error.status === 401 && !auth) return this.stopForMissingAuth(run, payload);
      this.logger.warn(`Failed to upload with files: ${errorMessage(error)}`);
      this.logger.info('Falling back to JSON upload...');
      return { done: false, output: null };
    }
  }

  private async tryUploadJSON(
    run: CollectedRun,
    overallStatus: string,
    duration: number,
    auth: string | null,
  ): Promise<SubmitOutcome> {
    const payload = this.buildRunPayload(run, overallStatus, duration);
    try {
      const response = await this.uploader.uploadJSON(payload, auth);
      this.dropLocalCopies();
      return { done: true, output: this.buildOutput(response?.runId, response?.projectId, run, overallStatus) };
    } catch (error) {
      if (error instanceof HttpError && error.status === 401 && !auth) return this.stopForMissingAuth(run, payload);
      this.logger.error(`All upload methods failed: ${errorMessage(error)}`);
      this.logRecoverySaved(
        `If this keeps happening, check that serverUrl (${run.options.serverUrl ?? 'not set'}) is correct and reachable.`,
      );
      this.saveRecovery(payload);
      // The ladder is exhausted; nothing to surface to CI.
      return { done: true, output: null };
    }
  }

  /**
   * The run reached the server: drop its buffered live events. A recovery file
   * on disk is an earlier run's, deleted only once its own replay succeeds.
   */
  private dropLocalCopies(): void {
    this.streamManager?.discardBuffered();
  }

  /**
   * Persist the wire-serialized payload (no raw attachments / internal fields)
   * so a later run can retry the submit.
   */
  private saveRecovery(payload: RunPayload): void {
    this.recovery.save(serializeRun(payload, { includeTestCases: true }));
  }

  /**
   * The dashboard asked for a credential the reporter has none of: no other
   * rung can succeed, so the ladder stops with the run saved for the next one.
   * The test run's own result stays what Playwright made it.
   */
  private stopForMissingAuth(run: CollectedRun, payload: RunPayload): SubmitOutcome {
    this.logger.error(
      `Authentication is required by ${run.options.serverUrl ?? 'the dashboard'} but no credentials were configured. ` +
        `Create an API key (Settings → Users on the dashboard) and set the reporter's \`apiKey\` option ` +
        `or the PIWI_API_KEY environment variable.`,
    );
    this.logRecoverySaved();
    this.saveRecovery(payload);
    return { done: true, output: null };
  }

  /** Say where the run went when the dashboard did not take it, with an optional hint. */
  private logRecoverySaved(hint?: string): void {
    this.logger.info(
      `Saved a local recovery copy — it will be uploaded automatically on your next test run.${hint ? ` ${hint}` : ''}`,
    );
  }
}
