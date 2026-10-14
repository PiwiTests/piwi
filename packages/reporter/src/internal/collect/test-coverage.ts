import { mergeCoverage, reduceCoverage, sanitizeCoverage, type CoverageCapture } from '@piwitests/core/coverage';
import { ATTACHMENT_NAMES } from '../capture/attachments.js';
import { repositoryRoot } from '../capture/code-reach.js';
import { Logger } from '../support/logger.js';
import { errorMessage } from '../support/errors.js';
import type { HttpClient } from '../transport/http-client.js';
import type { CollectedTestCase } from '../../types/collected.js';
import { BlobIds } from './blob-ids.js';
import type { CoverageSettings } from './coverage-settings.js';
import {
  ServerCoverageCollector,
  parseServerCoverageRequests,
  type RunCoverageFile,
  type ServerCoverage,
  type ServerCoverageCollectorOptions,
} from './server-coverage.js';

/**
 * A test's coverage, in the reporter process: its browser files (code reach)
 * and the server coverage collected from the backend, merged, cut down to the
 * configured granularity per runtime, and sanitized with the core caps. A
 * test whose responses named server coverage waits for it, within a bound;
 * the run-level coverage of each backend goes to the dashboard once the run
 * id is known.
 */

/** How long a test waits for its server coverage at most, in ms. */
export const TEST_COVERAGE_WAIT_MS = 30_000;

/** How long the end of the run waits for the tests still waiting, in ms. */
export const SETTLE_WAIT_MS = 15_000;

/** Files per run coverage request at most, well under the dashboard's limit. */
const RUN_COVERAGE_FILES_PER_REQUEST = 5000;

/** JSON bytes per run coverage request at most, well under the dashboard's limit. */
const RUN_COVERAGE_BYTES_PER_REQUEST = 8 * 1024 * 1024;

const INCOMPLETE: ServerCoverage = { files: [], incomplete: true };

/**
 * A test's coverage from its parts: the server coverage, when server
 * coverage is on, at its granularity, and the browser files, when browser
 * coverage is on, as paths. Null when no file remains.
 */
export function composeTestCoverage(
  server: ServerCoverage | null,
  browserFiles: string[] | null | undefined,
  settings: CoverageSettings,
): CoverageCapture | null {
  const serverCapture: CoverageCapture | null =
    settings.server !== 'off' && server
      ? reduceCoverage(
          {
            v: 1,
            files: server.files.filter((file) => file.runtime === 'server'),
            ...(server.incomplete ? { incomplete: true } : {}),
          },
          settings.server,
        )
      : null;
  const browserCapture: CoverageCapture | null =
    settings.browser === 'files' && browserFiles?.length
      ? reduceCoverage({ v: 1, files: browserFiles.map((path) => ({ path, runtime: 'browser' })) }, 'files')
      : null;
  const merged = mergeCoverage(serverCapture, browserCapture);
  return merged ? sanitizeCoverage(merged) : null;
}

/** Run coverage files in requests the dashboard takes. */
export function chunkRunCoverage(files: RunCoverageFile[]): RunCoverageFile[][] {
  const chunks: RunCoverageFile[][] = [];
  let chunk: RunCoverageFile[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(JSON.stringify(file)) + 1;
    if (
      chunk.length > 0 &&
      (chunk.length >= RUN_COVERAGE_FILES_PER_REQUEST || bytes + size > RUN_COVERAGE_BYTES_PER_REQUEST)
    ) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(file);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/**
 * Tells when the run's last test ended: every planned test reported, none
 * running, none waiting for a retry.
 */
export class LastTestWatch {
  private running = 0;
  private readonly reported = new Set<string>();
  private readonly retrying = new Set<string>();

  constructor(private readonly planned: number) {}

  /** A test attempt began. */
  begin(testId: string): void {
    this.running++;
    this.retrying.delete(testId);
  }

  /** A test attempt ended; true when it was the run's last. */
  end(testId: string, willRetry: boolean): boolean {
    this.running = Math.max(0, this.running - 1);
    this.reported.add(testId);
    if (willRetry) this.retrying.add(testId);
    else this.retrying.delete(testId);
    return this.running === 0 && this.retrying.size === 0 && this.reported.size >= this.planned;
  }
}

/** A test waiting for its server coverage. */
interface PendingTest {
  finish: (server: ServerCoverage) => void;
  done: Promise<void>;
}

export interface CoverageCollectionOptions {
  settings: CoverageSettings;
  /** The configured base URLs, for the backend's path base. */
  baseUrls: string[];
  /** Where the repository root is looked up from, for blob ids. */
  configDir: string;
  logger?: Logger;
  /** How long a test waits for its server coverage at most, in ms. */
  waitMs?: number;
  /** Accept any certificate from an https backend, as the run's browsers do with `ignoreHTTPSErrors`. */
  ignoreHttpsErrors?: boolean;
  /** Collection bounds a test overrides. */
  limits?: ServerCoverageCollectorOptions['limits'];
}

export class CoverageCollection {
  private readonly logger: Logger;
  private readonly collector: ServerCoverageCollector | null;
  private readonly waitMs: number;
  private readonly pending = new Set<PendingTest>();
  private readonly runFiles = new Map<string, Promise<RunCoverageFile[] | null>>();

  constructor(private readonly options: CoverageCollectionOptions) {
    this.logger = options.logger ?? new Logger();
    this.waitMs = options.waitMs ?? TEST_COVERAGE_WAIT_MS;
    const granularity = options.settings.server;
    this.collector =
      granularity === 'off'
        ? null
        : new ServerCoverageCollector({
            granularity,
            baseUrls: options.baseUrls,
            // Line numbers refer to a file version: name it by its blob id in the checkout.
            blobs: granularity === 'files' ? null : new BlobIds(() => repositoryRoot(options.configDir)),
            ignoreHttpsErrors: options.ignoreHttpsErrors,
            logger: this.logger,
            limits: options.limits,
          });
  }

  /**
   * Set a test's coverage from its attachments. Null when it is set now;
   * otherwise the test waits for its server coverage, and the promise
   * resolves once it is set, within the wait bound. Never rejects.
   */
  apply(
    testCase: CollectedTestCase,
    attachments: ReadonlyArray<{ name: string; body?: Buffer }> | undefined,
  ): Promise<void> | null {
    const browserFiles = this.options.settings.browser === 'files' ? testCase.codeReach : undefined;
    const attachment = this.collector
      ? attachments?.find((a) => a.name === ATTACHMENT_NAMES.serverCoverageRequests)
      : undefined;
    const requests = attachment?.body ? parseServerCoverageRequests(attachment.body) : null;
    if (!this.collector || !requests) {
      this.assign(testCase, composeTestCoverage(null, browserFiles, this.options.settings));
      return null;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish!: (server: ServerCoverage) => void;
    const done = new Promise<void>((resolve) => {
      let settled = false;
      finish = (server) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(entry);
        this.assign(testCase, composeTestCoverage(server, browserFiles, this.options.settings));
        resolve();
      };
    });
    const entry: PendingTest = { finish, done };
    this.pending.add(entry);
    timer = setTimeout(() => finish(INCOMPLETE), this.waitMs);
    this.collector.collect(requests).then(finish, () => finish(INCOMPLETE));
    return done;
  }

  /**
   * The run's last test ended: collect what is queued now, and fetch the
   * run-level coverage while the backend still runs (Playwright stops a
   * `webServer` before the reporter's `onEnd`).
   */
  lastTestEnded(): void {
    this.collector?.flush();
    this.fetchRunCoverage();
  }

  /**
   * Collect what is queued and wait for the tests still waiting, at most
   * `boundMs`; a test still waiting then goes without its server coverage,
   * marked incomplete.
   */
  async settle(boundMs = SETTLE_WAIT_MS): Promise<void> {
    this.collector?.flush();
    if (this.pending.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...this.pending].map((entry) => entry.done)),
        new Promise((resolve) => {
          timer = setTimeout(resolve, boundMs);
        }),
      ]);
      clearTimeout(timer);
    }
    for (const entry of this.pending) entry.finish(INCOMPLETE);
  }

  /** Start fetching the run-level coverage of each origin that named request ids, once per origin. */
  fetchRunCoverage(): void {
    if (!this.collector) return;
    for (const origin of this.collector.origins) {
      if (!this.runFiles.has(origin)) {
        this.runFiles.set(
          origin,
          this.collector.fetchRun(origin).catch(() => null),
        );
      }
    }
  }

  /**
   * Send the run-level coverage of every origin to the dashboard run, in
   * requests within its limits. A failure is logged once, never thrown.
   */
  async sendRunCoverage(httpClient: HttpClient, runId: number | string, auth: string | null): Promise<void> {
    if (!this.collector) return;
    this.fetchRunCoverage();
    const files: RunCoverageFile[] = (await Promise.all(this.runFiles.values())).flatMap((result) => result ?? []);
    for (const chunk of chunkRunCoverage(files)) {
      try {
        await httpClient.putJSON(`/api/test-runs/${runId}/coverage`, { v: 1, files: chunk }, auth);
      } catch (error) {
        this.logger.warn(`Could not send the run's server coverage to the dashboard: ${errorMessage(error)}`);
        return;
      }
    }
  }

  /** Stop every call to the backends still in flight. */
  close(): void {
    this.collector?.close();
  }

  private assign(testCase: CollectedTestCase, coverage: CoverageCapture | null): void {
    if (coverage) testCase.coverage = coverage;
  }
}
