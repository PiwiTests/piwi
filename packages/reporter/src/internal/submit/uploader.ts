import * as fs from 'node:fs';
import * as path from 'node:path';
import FormData from 'form-data';
import type { HttpClient } from '../transport/http-client.js';
import { HttpError, deliveredRunId } from '../transport/http-client.js';
import type { FileHandler, UploadableAttachment } from '../files/file-handler.js';
import type { ArchiveFile } from '../files/compression.js';
import { errorMessage } from '../support/errors.js';
import { Logger } from '../support/logger.js';
import { serializeRun, toWireTestCase } from './serializer.js';
import type { CollectedTestCase, TraceHashInfo, FilterDetails, WireResourceReport, SetupStep } from '../../types.js';

/** Payload for a batch test-run submission */
export interface RunPayload {
  /** Name of the project the run belongs to */
  projectName: string;
  /** Optional project description */
  projectDescription?: string;
  /** Overall run status: `"passed"` or `"failed"` */
  status: string;
  /** ISO-8601 timestamp when the run started */
  startTime: string | null;
  /** Total wall-clock duration of the run in ms */
  duration: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  timedOutTests?: number;
  skippedTests: number;
  /** Tests that never executed (cut short by `maxFailures` or a serial-group failure) */
  didNotRunTests?: number;
  /** Deployment environment label (e.g. `"staging"`, `"production"`) */
  environment?: string;
  /** Optional display label for the test run (e.g. "v2.3.1 release") */
  label?: string | null;
  /** Keep the run forever: the dashboard's retention never deletes it */
  keep?: boolean;
  /** Arbitrary metadata collected from the environment, CI, and Playwright config */
  metadata: Record<string, any>;
  /** Unique instance identifier for deduplication */
  instanceId: string;
  /** Test case results in their collected form (with attachments). Projected to the wire shape by `serializeRun`/`toWireTestCase` at the JSON boundary. */
  testCases: CollectedTestCase[];
  /** Playwright framework version used for this run */
  playwrightVersion?: string;
  /** Piwi reporter package version that produced this run */
  reporterVersion?: string;
  /** 1-based shard index (e.g. 1, 2, 3) */
  shardIndex?: number;
  /** Total number of shards (e.g. 3) */
  shardTotal?: number;
  /** Whether this run represents the full test suite (true) or a filtered subset (false) */
  isFullRun?: boolean;
  /** Filter details when isFullRun is false */
  filterDetails?: FilterDetails | null;
  /** The run's resource findings and what it cost its machine, when the reporter measured them */
  resourceReport?: WireResourceReport | null;
  /** Suite-level hook and fixture steps (`beforeAll`/`afterAll`) for the run timeline, as `/finish` takes them */
  setupSteps?: SetupStep[];
  /**
   * Generated once per run (per shard) and sent with every attempt to deliver it, so the dashboard
   * stores a delivery it already took once: a slow upload the reporter gave up on, then sent again.
   */
  deliveryKey?: string;
}

/** Options controlling which reports to upload */
export interface ReportOptions {
  /** Upload the Playwright HTML report. Defaults to `true`. */
  uploadReport?: boolean;
  /** Additional report types to discover and upload */
  reports?: Array<{ type: string; dir?: string; label?: string }>;
  /**
   * The HTML report the run's html reporter writes: its folder, and when the run began (ms), since an `index.html`
   * written before that is an earlier run's. Null when the run has no html reporter, and so no HTML report of its own.
   */
  htmlReport?: { folder: string; since: number } | null;
}

/** A report found on disk, to upload with the run: its type, its folder, its files and its label. */
export interface FoundReport {
  type: string;
  dir: string;
  files: ArchiveFile[];
  label?: string;
}

/** A run the dashboard created from its results alone, held until its files are in, and the token they go with. */
export interface HeldRun {
  runId: number;
  projectId?: number;
  streamToken: string;
}

/** Uploads in a row without any response after which `uploadCaseFilesInTurn` gives up. */
const MAX_UPLOAD_CONNECTION_FAILURES = 3;

/** Some of one test's files, as one `/case-files` request carries them: its trace, its attachments, or both. */
interface CaseFiles {
  trace: TraceHashInfo | null;
  attachments: UploadableAttachment[];
}

/**
 * Handles all upload strategies: plain JSON, multipart (with reports and
 * traces), a run's results ahead of its files, per-test-case file uploads for
 * streaming runs and runs uploaded in parts, and report-only uploads for a run
 * the dashboard already holds.
 */
export class Uploader {
  /**
   * @param httpClient  HTTP client for server communication.
   * @param fileHandler File discovery and compression helper.
   * @param logger      Prefixed logger.
   */
  constructor(
    private readonly httpClient: HttpClient,
    private readonly fileHandler: FileHandler,
    private readonly logger: Logger = new Logger(),
  ) {}

  /** Submit test results as a plain JSON payload (no file attachments); fails unless the answer names the run */
  async uploadJSON(payload: RunPayload, auth: string | null): Promise<any> {
    const response = await this.httpClient.postJSON(
      '/api/test-runs/submit',
      serializeRun(payload, { includeTestCases: true }),
      auth,
    );
    const runId = deliveredRunId(response, '/api/test-runs/submit');

    this.logger.info(`Successfully uploaded test results`);
    this.logger.info(`Test Run ID: ${runId}, Project ID: ${response.projectId}`);
    return response;
  }

  /**
   * Submit test results as a multipart form with `reports` compressed, each test's attachments and, with
   * `uploadTraces`, its traces; fails unless the answer names the run
   */
  async uploadWithFiles(
    payload: RunPayload,
    reports: FoundReport[],
    uploadTraces: boolean | undefined,
    auth: string | null,
  ): Promise<any> {
    const form = new FormData();
    form.append('projectName', payload.projectName);
    form.append('testRun', JSON.stringify(serializeRun(payload, { includeTestCases: false })));
    form.append('testCases', JSON.stringify(payload.testCases.map((tc) => toWireTestCase(tc))));

    await this.appendReportsToForm(form, reports);
    await this.appendFilesToForm(form, payload.testCases, uploadTraces);

    const response = await this.httpClient.postFormData('/api/test-runs/upload', form, auth);
    const runId = deliveredRunId(response, '/api/test-runs/upload');
    this.logger.debug(`Successfully uploaded test results with files`);
    this.logger.debug(`Test Run ID: ${runId}, Project ID: ${response.projectId}`);
    if (response.reports) {
      for (const r of response.reports) this.logger.debug(`${r.label}: ${r.path}`);
    }
    return response;
  }

  /**
   * Send the run with its results and no file (`/api/test-runs/upload/results`), for the dashboard to hold it until
   * its files follow. Returns the run and the token its files go with, or null when the dashboard took no run that
   * way: an older one, which has no such route, or a request that failed, both of which then get the run in one
   * upload (`uploadWithFiles`) under the same delivery key. A 401 is thrown: no upload goes without a credential.
   */
  async uploadResults(payload: RunPayload, auth: string | null): Promise<HeldRun | null> {
    let response: any;
    try {
      response = await this.httpClient.postJSON(
        '/api/test-runs/upload/results',
        serializeRun(payload, { includeTestCases: true }),
        auth,
        undefined,
        { upload: true },
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) throw error;
      this.logger.debug(`The dashboard took no results ahead of the files (${errorMessage(error)}).`);
      return null;
    }
    const runId = response?.runId;
    const streamToken = response?.streamToken;
    if (typeof runId !== 'number' || typeof streamToken !== 'string' || !streamToken) return null;
    this.logger.info(`Uploaded the test results: Test Run ID ${runId}, Project ID ${response.projectId}`);
    return { runId, projectId: response.projectId, streamToken };
  }

  /**
   * Upload each of `reports` to run `runId` in a request of its own, so a report the dashboard refuses (over its
   * upload limit, say) leaves out that one alone. Any such upload settles a run the dashboard holds `finalizing`
   * until its files are in, and so does the one carrying no report that follows when none went through. Never
   * throws: the dashboard settles a run no upload settled ten minutes after its last file.
   */
  async uploadReportsAndSettle(
    projectName: string,
    runId: number,
    reports: FoundReport[],
    startTime: string | null,
    auth: string | null,
  ): Promise<void> {
    let settled = false;
    for (const report of reports) {
      if (this.httpClient.closed) return;
      try {
        await this.uploadReportsForStreamingRun(projectName, runId, [report], startTime, auth);
        settled = true;
      } catch (error) {
        this.logger.warn(`Could not upload the ${report.type} report of run #${runId}: ${errorMessage(error)}`);
      }
    }
    if (settled || this.httpClient.closed) return;
    try {
      await this.uploadReportsForStreamingRun(projectName, runId, [], startTime, auth);
    } catch (error) {
      this.logger.debug(`Could not settle run #${runId} without its reports: ${errorMessage(error)}`);
    }
  }

  /**
   * Upload `reports` for a run the dashboard already holds: a streamed run, or one uploaded in parts. Any such upload,
   * one with no report too, settles a run the dashboard keeps `finalizing` until its files arrive.
   */
  async uploadReportsForStreamingRun(
    projectName: string,
    runId: number,
    reports: FoundReport[],
    startTime: string | null,
    auth: string | null,
  ): Promise<void> {
    const form = new FormData();
    form.append('runId', String(runId));
    form.append('projectName', projectName);
    form.append(
      'testRun',
      JSON.stringify({
        status: 'already-submitted',
        startTime,
        duration: 0,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        metadata: {},
      }),
    );
    form.append('testCases', JSON.stringify([]));

    await this.appendReportsToForm(form, reports);

    const response = await this.httpClient.postFormData('/api/test-runs/upload', form, auth);
    this.logger.debug(`Successfully uploaded ${reports.length} report(s) for run #${runId}`);
    if (response.reports) {
      for (const r of response.reports) this.logger.debug(`${r.label}: ${r.path}`);
    }
  }

  /**
   * Upload one test case's trace and attachments to a run that takes them with `streamToken`: a streaming run, or a
   * run uploaded in parts. A streamed case's `complete` event must have been flushed to the server first. Returns
   * `false` when the case has no files to upload. Files the dashboard refuses together as too large (413) go again in
   * a request each, its attachments of one name together, and one it still refuses is left out alone. `signal` ends
   * the upload, its trace check included, or fails it before it starts.
   */
  async uploadCaseFiles(
    projectName: string,
    runId: number,
    streamToken: string,
    testCase: CollectedTestCase,
    uploadTraces: boolean | undefined,
    auth: string | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const attachments = this.fileHandler.findAllAttachments(testCase);
    const trace = uploadTraces ? await this.fileHandler.computeSingleTraceHash(testCase) : null;
    if (!trace && attachments.length === 0) return false;

    // Skip the trace body when the server already has this blob
    let missingHashes: Set<string> | null = null;
    if (trace) {
      missingHashes = await this.fileHandler.checkMissingTraces(
        this.httpClient,
        projectName,
        new Map([[0, trace]]),
        auth,
        signal,
      );
    }
    const includeTraceFile = !!trace && (!missingHashes || missingHashes.has(trace.hash));
    const send = (files: CaseFiles) =>
      this.postCaseFiles(runId, streamToken, testCase, files, includeTraceFile, auth, signal);

    const whole: CaseFiles = { trace, attachments };
    try {
      await send(whole);
    } catch (error) {
      const parts = splitCaseFiles(whole);
      if (!isTooLarge(error) || parts.length < 2) throw error;
      for (const part of parts) {
        try {
          await send(part);
        } catch (partError) {
          if (!isTooLarge(partError)) throw partError;
          this.logger.warn(
            `Left out ${describeCaseFiles(part)} of "${testCase.title}": the dashboard refused it as too large (${errorMessage(partError)}).`,
          );
        }
      }
    }

    this.logger.debug(
      `Uploaded files for "${testCase.title}" (trace: ${trace ? 'yes' : 'no'}, attachments: ${attachments.length})`,
    );
    return true;
  }

  /** Post some of a test's files; a trace sent by its hash alone goes again with its file when the dashboard lacks it. */
  private async postCaseFiles(
    runId: number,
    streamToken: string,
    testCase: CollectedTestCase,
    files: CaseFiles,
    includeTraceFile: boolean,
    auth: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `/api/test-runs/${runId}/case-files`;
    try {
      await this.httpClient.postFormData(
        url,
        caseFilesForm(streamToken, testCase, files, includeTraceFile),
        auth,
        signal,
      );
    } catch (error) {
      // 422: the server doesn't have the blob after all — resend with the file
      if (files.trace && !includeTraceFile && error instanceof HttpError && error.status === 422) {
        await this.httpClient.postFormData(url, caseFilesForm(streamToken, testCase, files, true), auth, signal);
      } else {
        throw error;
      }
    }
  }

  /** The reports the options ask for that are on disk. */
  findReports(reportOptions: ReportOptions): FoundReport[] {
    const list: Array<{ type: string; dir?: string; label?: string }> = reportOptions.reports
      ? [...reportOptions.reports]
      : [];
    if (reportOptions.uploadReport && !list.some((r) => r.type === 'html')) list.push({ type: 'html' });

    const found: FoundReport[] = [];
    for (const cfg of list) {
      const defaultDir = this.fileHandler.getDefaultReportDirs()[cfg.type] || cfg.type + '-report';
      const reportDir = cfg.dir
        ? this.fileHandler.findReportDirectory(cfg.dir)
        : cfg.type === 'html'
          ? this.fileHandler.findHTMLReport(reportOptions.htmlReport)
          : this.fileHandler.findReportDirectory(defaultDir);

      if (!reportDir) {
        this.logger.debug(`No report directory found for type '${cfg.type}'`);
        continue;
      }
      const files = this.fileHandler.listReport(reportDir);
      if (files) found.push({ type: cfg.type, dir: reportDir, files, ...(cfg.label ? { label: cfg.label } : {}) });
    }
    return found;
  }

  /**
   * Whether a multipart upload of the run would carry a file: one of `reports`, a test's attachment, or, with
   * `uploadTraces`, a trace on disk.
   */
  hasFiles(testCases: CollectedTestCase[], reports: FoundReport[], uploadTraces: boolean | undefined): boolean {
    if (reports.length > 0) return true;
    return testCases.some(
      (tc) =>
        this.fileHandler.findAllAttachments(tc).length > 0 ||
        (!!uploadTraces && this.fileHandler.findTraceFiles(tc).some((tracePath) => fs.existsSync(tracePath))),
    );
  }

  private async appendReportsToForm(form: FormData, reports: FoundReport[]): Promise<void> {
    for (const report of reports) {
      const archive = await this.fileHandler.compressReport(report.dir, report.files);
      if (archive) {
        form.append(`report_${report.type}`, fs.createReadStream(archive), { filename: `${report.type}-report.gz` });
        if (report.label) form.append(`report_label_${report.type}`, report.label);
      }
    }
  }

  private async appendFilesToForm(
    form: FormData,
    testCases: CollectedTestCase[],
    uploadTraces?: boolean,
  ): Promise<void> {
    let attachmentCount = 0;
    for (const [i, tc] of testCases.entries()) {
      const attachments = this.fileHandler.findAllAttachments(tc);
      if (attachments.length === 0) continue;

      form.append(
        `attach_meta_${i}`,
        JSON.stringify(
          attachments.map((a) => ({
            name: a.name,
            contentType: a.contentType,
            originalName: a.originalName,
          })),
        ),
      );

      for (const a of attachments) {
        form.append(`attach_file_${i}`, fs.createReadStream(a.path), { filename: a.originalName });
        attachmentCount++;
      }
    }
    if (attachmentCount > 0) this.logger.info(`Uploading ${attachmentCount} non-trace attachments`);

    if (!uploadTraces) return;

    let traceCount = 0;
    for (const [i, tc] of testCases.entries()) {
      for (const tp of this.fileHandler.findTraceFiles(tc)) {
        if (fs.existsSync(tp)) {
          form.append(`trace_${i}`, fs.createReadStream(tp), { filename: path.basename(tp) });
          traceCount++;
        }
      }
    }
    this.logger.debug(`Found ${traceCount} trace files`);
  }
}

/** The `/case-files` form of some of a test's files, its trace's body included or named by its hash alone. */
function caseFilesForm(
  streamToken: string,
  testCase: CollectedTestCase,
  { trace, attachments }: CaseFiles,
  includeTraceFile: boolean,
): FormData {
  const form = new FormData();
  form.append('streamToken', streamToken);
  form.append(
    'testCase',
    JSON.stringify({
      title: testCase.title,
      location: testCase.location,
      retries: testCase.retries ?? 0,
      repeatEachIndex: testCase.repeatEachIndex ?? 0,
      suitePath: testCase.suitePath ?? null,
      // The execution's Playwright project, the case payload's `browser.projectName`.
      projectName: testCase.browser?.projectName ?? null,
    }),
  );
  if (trace) {
    form.append('trace_hash', trace.hash);
    if (includeTraceFile) {
      form.append('trace', fs.createReadStream(trace.tracePath), { filename: path.basename(trace.tracePath) });
    }
  }
  if (attachments.length > 0) {
    form.append(
      'attach_meta',
      JSON.stringify(
        attachments.map((a) => ({ name: a.name, contentType: a.contentType, originalName: a.originalName })),
      ),
    );
    for (const a of attachments) {
      form.append('attach_file', fs.createReadStream(a.path), { filename: a.originalName });
    }
  }
  return form;
}

/**
 * A test's files, one request each: its trace, then its attachments, those of one name together, since the dashboard
 * names each by its place among the attachments of its name that one request carries.
 */
function splitCaseFiles({ trace, attachments }: CaseFiles): CaseFiles[] {
  const byName = new Map<string, UploadableAttachment[]>();
  for (const a of attachments) byName.set(a.originalName, [...(byName.get(a.originalName) ?? []), a]);
  return [
    ...(trace ? [{ trace, attachments: [] }] : []),
    ...[...byName.values()].map((group) => ({ trace: null, attachments: group })),
  ];
}

function describeCaseFiles({ trace, attachments }: CaseFiles): string {
  return trace ? 'its trace' : attachments.map((a) => `"${a.originalName}"`).join(', ');
}

/** Whether the dashboard, or a proxy in front of it, refused a request as too large. */
function isTooLarge(error: unknown): boolean {
  return error instanceof HttpError && error.status === 413;
}

/**
 * Upload the files of each of `testCases` in turn to run `runId`, which takes them with `streamToken`
 * (`Uploader.uploadCaseFiles`), skipping those `skip` names, and calling `uploaded` for each test whose files went.
 * A test whose files fail is logged and the next one goes; the uploads stop after
 * `MAX_UPLOAD_CONNECTION_FAILURES` of them in a row got no answer at all, once the dashboard answers that the run
 * takes no more files (409: it ended), and once `signal` is aborted.
 */
export async function uploadCaseFilesInTurn(
  uploader: Pick<Uploader, 'uploadCaseFiles'>,
  logger: Logger,
  run: {
    projectName: string;
    runId: number;
    streamToken: string;
    uploadTraces: boolean | undefined;
    auth: string | null;
  },
  testCases: CollectedTestCase[],
  signal: AbortSignal,
  { skip, uploaded }: { skip?: (tc: CollectedTestCase) => boolean; uploaded?: (tc: CollectedTestCase) => void } = {},
): Promise<void> {
  let connectionFailures = 0;
  for (const tc of testCases) {
    if (skip?.(tc)) continue;
    if (signal.aborted) {
      logger.warn(
        `The end-of-run time budget (submitTimeout) leaves no more time for file uploads: skipping the files of the remaining tests so the run can be finished.`,
      );
      return;
    }
    try {
      const sent = await uploader.uploadCaseFiles(
        run.projectName,
        run.runId,
        run.streamToken,
        tc,
        run.uploadTraces,
        run.auth,
        signal,
      );
      if (sent) uploaded?.(tc);
      connectionFailures = 0;
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        logger.warn(
          `Run #${run.runId} takes no more files (${errorMessage(error)}): skipping those of the remaining tests.`,
        );
        return;
      }
      logger.warn(`Failed to upload files for "${tc.title}": ${errorMessage(error)}`);
      // Any HTTP status means the dashboard answered; only a request that got
      // no response (refused, reset, timed out) counts toward giving up.
      connectionFailures = error instanceof HttpError ? 0 : connectionFailures + 1;
      if (connectionFailures >= MAX_UPLOAD_CONNECTION_FAILURES) {
        logger.warn(`The dashboard stopped responding — skipping the file uploads of the remaining tests.`);
        return;
      }
    }
  }
}
