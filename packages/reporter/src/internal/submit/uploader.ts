import * as fs from 'node:fs';
import * as path from 'node:path';
import FormData from 'form-data';
import type { HttpClient } from '../transport/http-client.js';
import { HttpError } from '../transport/http-client.js';
import type { FileHandler } from '../files/file-handler.js';
import { Logger } from '../support/logger.js';
import { serializeRun, toWireTestCase } from './serializer.js';
import type { CollectedTestCase, TraceHashInfo, FilterDetails, WireResourceReport } from '../../types.js';

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
  /**
   * Generated once per run (per shard) and sent with every attempt to deliver it, so the dashboard
   * stores a delivery it already took once: a slow upload the reporter gave up on, then sent again.
   */
  deliveryKey?: string;
}

/** Options controlling which report files and traces to upload */
export interface ReportOptions {
  /** Upload trace files. Defaults to `true`. */
  uploadTraces?: boolean;
  /** Upload the Playwright HTML report. Defaults to `true`. */
  uploadReport?: boolean;
  /** Additional report types to discover and upload */
  reports?: Array<{ type: string; dir?: string; label?: string }>;
}

/**
 * Handles all upload strategies: plain JSON, multipart (with reports and
 * traces), per-test-case file uploads for streaming runs, and report-only
 * uploads for already-submitted streaming runs.
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

  /** Submit test results as a plain JSON payload (no file attachments) */
  async uploadJSON(payload: RunPayload, auth: string | null): Promise<any> {
    const response = await this.httpClient.postJSON(
      '/api/test-runs/submit',
      serializeRun(payload, { includeTestCases: true }),
      auth,
    );

    this.logger.info(`Successfully uploaded test results`);
    if (response.runId) {
      this.logger.info(`Test Run ID: ${response.runId}, Project ID: ${response.projectId}`);
    }
    return response;
  }

  /** Submit test results as a multipart form with trace files and compressed report directories */
  async uploadWithFiles(payload: RunPayload, reportOptions: ReportOptions, auth: string | null): Promise<any> {
    const form = new FormData();
    form.append('projectName', payload.projectName);
    form.append('testRun', JSON.stringify(serializeRun(payload, { includeTestCases: false })));
    form.append('testCases', JSON.stringify(payload.testCases.map((tc) => toWireTestCase(tc))));

    await this.appendReportsToForm(form, reportOptions.reports, reportOptions.uploadReport);
    await this.appendFilesToForm(form, payload.testCases, reportOptions.uploadTraces);

    const response = await this.httpClient.postFormData('/api/test-runs/upload', form, auth);
    this.logger.info(`Successfully uploaded test results with files`);
    if (response.runId) {
      this.logger.info(`Test Run ID: ${response.runId}, Project ID: ${response.projectId}`);
    }
    if (response.reports) {
      for (const r of response.reports) this.logger.info(`${r.label}: ${r.path}`);
    }
    return response;
  }

  /** Upload report files for an already-submitted streaming run */
  async uploadReportsForStreamingRun(
    projectName: string,
    runId: number,
    reportOptions: ReportOptions,
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

    await this.appendReportsToForm(form, reportOptions.reports, reportOptions.uploadReport);

    const response = await this.httpClient.postFormData('/api/test-runs/upload', form, auth);
    this.logger.info(`Successfully uploaded reports for streaming run #${runId}`);
    if (response.reports) {
      for (const r of response.reports) this.logger.info(`${r.label}: ${r.path}`);
    }
  }

  /**
   * Upload one test case's trace and attachments for a streaming run.
   * The matching `complete` event must have been flushed to the server first.
   * Returns `false` when the case has no files to upload.
   */
  async uploadCaseFiles(
    projectName: string,
    runId: number,
    streamToken: string,
    testCase: CollectedTestCase,
    uploadTraces: boolean | undefined,
    auth: string | null,
  ): Promise<boolean> {
    const attachments = this.fileHandler.findAllAttachments(testCase);

    let traceInfo: TraceHashInfo | null = null;
    if (uploadTraces) {
      traceInfo = await this.fileHandler.computeSingleTraceHash(testCase);
    }

    if (!traceInfo && attachments.length === 0) return false;

    // Skip the trace body when the server already has this blob
    let missingHashes: Set<string> | null = null;
    if (traceInfo) {
      missingHashes = await this.fileHandler.checkMissingTraces(
        this.httpClient,
        projectName,
        new Map([[0, traceInfo]]),
        auth,
      );
    }

    const buildForm = (includeTraceFile: boolean): FormData => {
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
        }),
      );
      if (traceInfo) {
        form.append('trace_hash', traceInfo.hash);
        if (includeTraceFile) {
          form.append('trace', fs.createReadStream(traceInfo.tracePath), {
            filename: path.basename(traceInfo.tracePath),
          });
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
    };

    const includeTraceFile = !traceInfo || !missingHashes || missingHashes.has(traceInfo.hash);
    try {
      await this.httpClient.postFormData(`/api/test-runs/${runId}/case-files`, buildForm(includeTraceFile), auth);
    } catch (error) {
      // 422: the server doesn't have the blob after all — resend with the file
      if (traceInfo && !includeTraceFile && error instanceof HttpError && error.status === 422) {
        await this.httpClient.postFormData(`/api/test-runs/${runId}/case-files`, buildForm(true), auth);
      } else {
        throw error;
      }
    }

    this.logger.debug(
      `Uploaded files for "${testCase.title}" (trace: ${traceInfo ? 'yes' : 'no'}, attachments: ${attachments.length})`,
    );
    return true;
  }

  private async appendReportsToForm(
    form: FormData,
    reports?: Array<{ type: string; dir?: string; label?: string }>,
    uploadReport?: boolean,
  ): Promise<void> {
    const list: Array<{ type: string; dir?: string; label?: string }> = reports ? [...reports] : [];
    if (uploadReport && !list.some((r) => r.type === 'html')) list.push({ type: 'html' });

    for (const cfg of list) {
      const defaultDir = this.fileHandler.getDefaultReportDirs()[cfg.type] || cfg.type + '-report';
      const reportDir = cfg.dir
        ? this.fileHandler.findReportDirectory(cfg.dir)
        : cfg.type === 'html'
          ? this.fileHandler.findHTMLReportDirectory()
          : this.fileHandler.findReportDirectory(defaultDir);

      if (!reportDir) {
        this.logger.debug(`No report directory found for type '${cfg.type}'`);
        continue;
      }

      const compressed = await this.fileHandler.compressReportDirectory(reportDir);
      if (compressed) {
        form.append(`report_${cfg.type}`, compressed, { filename: `${cfg.type}-report.gz` });
        if (cfg.label) form.append(`report_label_${cfg.type}`, cfg.label);
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
    this.logger.info(`Found ${traceCount} trace files`);
  }
}
