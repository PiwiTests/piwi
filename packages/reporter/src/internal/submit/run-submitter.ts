import { randomUUID } from 'node:crypto';
import type { FullResult } from '@playwright/test/reporter';
import type { PiwiDashboardOptions, ShardInfo } from '../../public/options.js';
import { errorMessage } from '../support/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import { HttpError, runTokenHeaders } from '../transport/http-client.js';
import { heldRepeat, uploadCaseFilesInTurn } from './uploader.js';
import type { Uploader, RunPayload, ReportOptions, FoundReport, HeldRun } from './uploader.js';
import type { CrashRecovery } from '../streaming/crash-recovery.js';
import type { StreamManager } from '../streaming/stream-manager.js';
import { Logger } from '../support/logger.js';
import { computePerformanceSummary } from '@piwitests/core/step-analysis';
import { computeDistinctRunCounts, resolveOverallStatus, serializeRun } from './serializer.js';
import { answeredRunUrl } from '../support/run-url.js';
import { requestedRunTarget } from '../config/env.js';
import { emitRunOutputs, ciBuildUrlFromMetadata, type RunOutput } from '../support/ci-output.js';
import type { FailureLinks } from '../support/failure-links.js';
import type { CollectedTestCase, SetupStep, FilterDetails, WireResourceReport, WireRunError } from '../../types.js';
import type { WireEnvironmentSnapshot } from '../../types/wire.js';

/** Longest delay `setTimeout` supports; a larger one fires at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * The waits before sending `/finish`, or the results of a run uploaded in parts, again when its answer was lost: three
 * tries in all.
 */
const RETRY_DELAYS_MS = [1000, 2000];

/**
 * The part of the end-of-run budget the test files leave to what follows them: `/finish` and its repeats, or the
 * reports of a run uploaded in parts, which settle it. A minute, or a quarter of a shorter budget.
 */
const FINISH_RESERVE_MS = 60_000;

/**
 * Whether a failed request may have reached the dashboard with its answer lost on the way back: no answer came, or a
 * server error, a timeout (408) or a rate limit (429) did.
 */
function answerMayBeLost(error: unknown): boolean {
  return !(error instanceof HttpError) || error.status >= 500 || error.status === 408 || error.status === 429;
}

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
  /** The folder the run's html reporter writes its report to; null when the run has none. */
  htmlReport?: string | null;
  /** The errors Playwright reported outside any test (`onError`), as the run keeps them. */
  runErrors?: WireRunError[];
  /** The run's environment snapshots: the runner's, each project's browser and each server under test. */
  environments?: WireEnvironmentSnapshot[];
}

/** The run the dashboard took, and the credential that reached it. */
export interface SubmittedRun {
  runId: number | string;
  auth: string | null;
}

/**
 * Why the reporter left the rung it would normally deliver a run through. `run-ended`: the dashboard ended the run
 * while it streamed, as it does once another run with the same run label started.
 */
type SubmitFallbackReason = 'results-lost' | 'finish-failed' | 'upload-failed' | 'run-ended';

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
 *   2. fall back to the batch upload when reports or traces are asked for and
 *      the run has a file to attach: in parts (`/upload/results`, then each
 *      test's files and each report), or in one multipart `/upload` for a
 *      shard or a dashboard that takes no results ahead of the files,
 *   3. fall back to plain JSON (`/submit`) as the last resort, persisting a
 *      recovery payload on total failure.
 */
export class RunSubmitter {
  /** The key every batch delivery of this run carries, so the dashboard stores the run once. */
  private readonly deliveryKey = randomUUID();
  /** The run's `submitTimeout` budget, and when it runs out (ms since the epoch); null without one. */
  private budget: { ms: number; end: number } | null = null;

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
   * `submitTimeout` budget. A streamed run's file uploads stop in time to leave
   * its `/finish` a share of the budget (`FINISH_RESERVE_MS`). When the budget
   * runs out, every request in flight and every later one fails, so the ladder
   * falls through to saving the recovery copy. Returns the run the dashboard
   * took, or null when none did or it named no run id.
   */
  async submit(run: CollectedRun, result: FullResult): Promise<SubmittedRun | null> {
    const budgetMs = run.options.submitTimeout ?? 0;
    const bounded = budgetMs > 0 && Number.isFinite(budgetMs);
    this.budget = bounded ? { ms: budgetMs, end: Date.now() + budgetMs } : null;
    const timer = bounded
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

    // The drain settles a stream that has not opened yet first: it is tried once more, or given up for the batch.
    const sm = this.streamManager;
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
    const requested = requestedRunTarget() !== null;
    if (!sm && !requested) await this.recovery.tryUpload(this.httpClient, auth);

    // The reports on disk that go with the run, found once for every rung.
    const reports = this.uploader.findReports(this.reportOptions(run));

    let outcome: SubmitOutcome = { done: false, output: null };
    // Why the run is not delivered by the rung it would normally take, once a rung failed.
    let fallbackReason: SubmitFallbackReason | null = null;

    // When test-result events never reached the server through the live stream,
    // the server is missing that detail; finalizing with `/finish` would lock it
    // in. Fall through to the batch upload, which re-sends the full run from the
    // reporter's own in-memory collection, so the missing detail is recovered. A
    // run the dashboard ended while it streamed takes nothing more, so it goes
    // whole in the batch upload too. A requested run has no batch upload, so it finishes with what reached the
    // instance.
    if (sm?.runEnded) {
      fallbackReason = 'run-ended';
    } else if (sm?.enabled && sm?.runId != null) {
      if (sm.lostResults && !requested) fallbackReason = 'results-lost';
      else {
        outcome = await this.tryFinishStreaming(run, overallStatus, duration, auth, counts.flakyTests, reports);
        if (!outcome.done) fallbackReason = 'finish-failed';
      }
    }

    // A request token starts one streamed run: the batch upload and the recovery copy cannot deliver its run.
    if (!outcome.done && requested) {
      this.logger.warn(
        fallbackReason
          ? `The run was not finished on the instance that asked for it (${fallbackReason}).`
          : 'The instance that asked for the run did not take it.',
      );
      return null;
    }

    // The multipart upload runs only with a file to carry. Once the time budget
    // closed the client, it is skipped: the JSON rung below fails at once and
    // saves the recovery copy.
    if (
      !outcome.done &&
      !this.httpClient.closed &&
      (this.hasReports(run) || run.options.uploadTraces) &&
      this.uploader.hasFiles(run.testCases, reports, run.options.uploadTraces)
    ) {
      if (fallbackReason) markSubmitFallback(run, 'upload', fallbackReason);
      outcome = await this.tryUploadWithFiles(run, overallStatus, duration, auth, reports);
      if (!outcome.done) fallbackReason = 'upload-failed';
    }

    if (!outcome.done) {
      if (fallbackReason) markSubmitFallback(run, 'submit', fallbackReason);
      outcome = await this.tryUploadJSON(run, overallStatus, duration, auth, reports);
    }

    if (!outcome.output) return null;
    // Failures that had no run id yet (batch mode, or a stream that never
    // opened) get their link lines now, ahead of the run URL.
    this.failureLinks?.knowPage(outcome.output.runId, outcome.output.runUrl);
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
    answer?: unknown,
  ): RunOutput | null {
    if (runId == null) return null;
    return {
      runUrl: answeredRunUrl(answer, this.httpClient.baseUrl, runId),
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
      uploadReport: run.options.uploadReport,
      reports: run.options.reports,
      htmlReport: run.htmlReport && run.startTime ? { folder: run.htmlReport, since: Date.parse(run.startTime) } : null,
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
      setupSteps: run.setupSteps,
      runErrors: run.runErrors,
      environments: run.environments,
      deliveryKey: this.deliveryKey,
      replacesRun: this.streamedRun(run),
    };
  }

  /**
   * The run this reporter streamed, which a batch delivery of the run replaces: its id and stream token. Undefined
   * without one, and for a shard, whose run the other shards share.
   */
  private streamedRun(run: CollectedRun): RunPayload['replacesRun'] {
    const sm = this.streamManager;
    if (sm?.runId == null || !sm.token || (run.shardInfo && run.shardInfo.total > 1)) return undefined;
    return { runId: sm.runId, streamToken: sm.token };
  }

  private async tryFinishStreaming(
    run: CollectedRun,
    overallStatus: string,
    duration: number,
    auth: string | null,
    flakyTests: number,
    reports: FoundReport[],
  ): Promise<SubmitOutcome> {
    const sm = this.streamManager!;
    try {
      const durations = run.testCases.filter((tc) => tc.duration != null).map((tc) => tc.duration as number);

      await sm.uploadRemaining(run.testCases, this.filesDeadline());

      const finishBody: Record<string, unknown> = {
        streamToken: sm.token,
        status: overallStatus,
        // With `duration`, the span the run of a shard covers in its sharded run.
        startTime: run.startTime ?? undefined,
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
        hasPendingUploads: reports.length > 0,
        playwrightVersion: run.playwrightVersion ?? undefined,
        reporterVersion: run.reporterVersion ?? undefined,
        setupSteps: run.setupSteps.length > 0 ? run.setupSteps : undefined,
        isFullRun: run.isFullRun,
        filterDetails: run.filterDetails ?? null,
      };
      if (run.resourceReport) finishBody.resourceReport = run.resourceReport;
      if (run.runErrors?.length) finishBody.runErrors = run.runErrors;
      if (run.environments?.length) finishBody.environments = run.environments;
      if (run.shardInfo) {
        finishBody.shardIndex = run.shardInfo.current;
        finishBody.shardTotal = run.shardInfo.total;
      }

      await this.postFinish(sm.runId!, finishBody, auth);

      this.logger.debug(`Successfully finalized streaming run #${sm.runId}`);
      this.dropLocalCopies();

      if (reports.length > 0) {
        await this.uploader.uploadReportsAndSettle(run.options.projectName!, sm.runId!, reports, run.startTime, auth);
      }
      return { done: true, output: this.buildOutput(sm.runId!, undefined, run, overallStatus, { runUrl: sm.runUrl }) };
    } catch (error) {
      this.logger.warn(`Failed to finalize streaming run: ${errorMessage(error)}`);
      this.logger.info('Falling back to batch upload...');
      return { done: false, output: null };
    }
  }

  /**
   * When the test files stop (ms since the epoch), so what follows them keeps its share of the budget
   * (`FINISH_RESERVE_MS`); null without a budget.
   */
  private filesDeadline(): number | null {
    return this.budget && this.budget.end - Math.min(FINISH_RESERVE_MS, this.budget.ms / 4);
  }

  /**
   * Post the run's `/finish`, asked again when its answer may have been lost, since the dashboard may have finished
   * the run already: then it refuses the request again as the run's stream is closed (409) or its token spent (403),
   * which means the earlier request finished it. Throws when the run was not finished.
   */
  private async postFinish(runId: number, body: Record<string, unknown>, auth: string | null): Promise<void> {
    await this.askAgainWhenLost("The run's /finish", async (attempt) => {
      try {
        await this.httpClient.postJSON(`/api/test-runs/${runId}/finish`, body, auth, undefined, {
          headers: runTokenHeaders(typeof body.streamToken === 'string' ? body.streamToken : null),
        });
      } catch (error) {
        if (attempt > 0 && error instanceof HttpError && (error.status === 409 || error.status === 403)) {
          this.logger.debug(`Run #${runId} was finished by an earlier /finish whose answer was lost.`);
          return;
        }
        throw error;
      }
    });
  }

  /**
   * Make `request`, and make it again after each of `RETRY_DELAYS_MS` while its answer may have been lost
   * (`answerMayBeLost`), the waits ending with the budget. `request` gets the number of the try, from 0. Throws the
   * last failure.
   */
  private async askAgainWhenLost<T>(what: string, request: (attempt: number) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(attempt);
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || this.httpClient.closed || !answerMayBeLost(error)) throw error;
        this.logger.warn(`${what} failed (${errorMessage(error)}), perhaps after the dashboard took it: asking again.`);
        // The wait ends with the budget: a request after it fails at once.
        const wait = this.budget ? Math.min(delay, Math.max(this.budget.end - Date.now(), 0)) : delay;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  private async tryUploadWithFiles(
    run: CollectedRun,
    overallStatus: string,
    duration: number,
    auth: string | null,
    reports: FoundReport[],
  ): Promise<SubmitOutcome> {
    const payload = this.buildRunPayload(run, overallStatus, duration);
    try {
      const response =
        (await this.uploadInParts(run, payload, reports, auth)) ??
        (await this.uploadInOne(run, payload, reports, auth));
      this.dropLocalCopies();
      return {
        done: true,
        output: this.buildOutput(response?.runId, response?.projectId, run, overallStatus, response),
      };
    } catch (error) {
      if (error instanceof HttpError && error.status === 401 && !auth) return this.stopForMissingAuth(run, payload);
      this.logger.warn(`Could not upload the run's files (${errorMessage(error)}): sending its results alone.`);
      return { done: false, output: null };
    }
  }

  /**
   * Deliver the run in parts, as a streamed run's files go: its results first, which the dashboard holds `finalizing`;
   * then each test's files, with the token its answer carries; then its reports, which settle the run (an upload
   * carrying none does when none went through). Each goes in a request of its own, so one the dashboard refuses as
   * too large is left out alone. The results go again, under the same delivery key, when their answer may have been
   * lost: the dashboard answers a repeat of a run it holds with a new token. Null for a shard, whose run settles with
   * its last shard, when the dashboard took no results ahead of the files (an older one), and when every try at them
   * failed with no answer or a server error: these get the run in one upload (`uploadInOne`).
   */
  private async uploadInParts(
    run: CollectedRun,
    payload: RunPayload,
    reports: FoundReport[],
    auth: string | null,
  ): Promise<HeldRun | null> {
    if (run.shardInfo && run.shardInfo.total > 1) return null;
    let held: HeldRun | null;
    try {
      held = await this.askAgainWhenLost("The upload of the run's results", () =>
        this.uploader.uploadResults(payload, auth),
      );
    } catch (error) {
      if (this.httpClient.closed || !answerMayBeLost(error)) throw error;
      this.logger.warn(
        `The dashboard did not take the run's results (${errorMessage(error)}): sending the run in one upload.`,
      );
      return null;
    }
    if (!held) return null;
    await this.sendFilesAndSettle(run, held, reports, auth);
    return held;
  }

  /**
   * Deliver the run in one multipart upload, under the delivery key its results went with, and send the files of a
   * run the dashboard answers it as a repeat of (`sendFilesOfHeldRepeat`). Any other answer is returned as it came.
   */
  private async uploadInOne(
    run: CollectedRun,
    payload: RunPayload,
    reports: FoundReport[],
    auth: string | null,
  ): Promise<any> {
    const response = await this.uploader.uploadWithFiles(payload, reports, run.options.uploadTraces, auth);
    return (await this.sendFilesOfHeldRepeat(run, response, reports, auth)) ?? response;
  }

  /**
   * When `response` answers a batch delivery as a repeat of the run the dashboard holds from its results (their
   * answers were lost), with a new token, send that run's files and reports as `uploadInParts` does: the repeat left
   * its own unread. Returns the held run, or null for any other answer, which needs nothing more.
   */
  private async sendFilesOfHeldRepeat(
    run: CollectedRun,
    response: unknown,
    reports: FoundReport[],
    auth: string | null,
  ): Promise<HeldRun | null> {
    const held = heldRepeat(response);
    if (!held) return null;
    this.logger.info(`The dashboard holds run #${held.runId} from its results: sending its files.`);
    await this.sendFilesAndSettle(run, held, reports, auth);
    return held;
  }

  /**
   * Send each test's files to the run the dashboard holds `finalizing`, with its token, then its reports, which settle
   * it (an upload carrying none does when none went through).
   */
  private async sendFilesAndSettle(
    run: CollectedRun,
    held: HeldRun,
    reports: FoundReport[],
    auth: string | null,
  ): Promise<void> {
    // The test files stop in time to leave the reports, and the settle, their share of the budget.
    const files = new AbortController();
    const deadline = this.filesDeadline();
    const stop =
      deadline === null
        ? null
        : setTimeout(
            () => files.abort(new Error('The end-of-run time budget is kept for settling the run')),
            Math.min(Math.max(deadline - Date.now(), 0), MAX_TIMER_DELAY_MS),
          );
    try {
      await uploadCaseFilesInTurn(
        this.uploader,
        this.logger,
        {
          projectName: run.options.projectName!,
          runId: held.runId,
          streamToken: held.streamToken,
          uploadTraces: run.options.uploadTraces,
          auth,
        },
        run.testCases,
        files.signal,
      );
    } finally {
      if (stop) clearTimeout(stop);
    }
    await this.uploader.uploadReportsAndSettle(run.options.projectName!, held.runId, reports, run.startTime, auth);
  }

  /**
   * Send the run's results as JSON, the last rung, and the files of a run the dashboard answers them as a repeat of
   * (`sendFilesOfHeldRepeat`). Saves the recovery copy when the dashboard does not take them.
   */
  private async tryUploadJSON(
    run: CollectedRun,
    overallStatus: string,
    duration: number,
    auth: string | null,
    reports: FoundReport[],
  ): Promise<SubmitOutcome> {
    const payload = this.buildRunPayload(run, overallStatus, duration);
    try {
      const response = await this.uploader.uploadJSON(payload, auth);
      this.dropLocalCopies();
      await this.sendFilesOfHeldRepeat(run, response, reports, auth);
      return {
        done: true,
        output: this.buildOutput(response?.runId, response?.projectId, run, overallStatus, response),
      };
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
        `Create an API key (Settings → Users on the dashboard) and set the reporter's \`apiKey\` option, ` +
        `or PIWI_API_KEY in the environment or in the .env file next to the Playwright config.`,
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
