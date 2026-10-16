import {
  mergeCoverage,
  reduceCoverage,
  sanitizeCoverage,
  type CoverageCapture,
  type CoverageFile,
} from '@piwitests/core/coverage';
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
 * coverage is on: paths, or files with the lines of their functions at
 * `functions`. Null when no file remains.
 */
export function composeTestCoverage(
  server: ServerCoverage | null,
  browserFiles: ReadonlyArray<string | CoverageFile> | null | undefined,
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
    settings.browser !== 'off' && browserFiles?.length
      ? reduceCoverage(
          {
            v: 1,
            files: browserFiles.map((file) =>
              typeof file === 'string' ? { path: file, runtime: 'browser' } : { ...file, runtime: 'browser' },
            ),
          },
          settings.browser,
        )
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
  /** The blob ids of the browser files, which name line numbers at `functions` granularity. */
  private readonly browserBlobs: BlobIds | null;
  /** The tests whose browser files are getting their blob ids, so the end of the run waits for them. */
  private readonly browserPending = new Set<Promise<void>>();

  constructor(private readonly options: CoverageCollectionOptions) {
    this.logger = options.logger ?? new Logger();
    this.waitMs = options.waitMs ?? TEST_COVERAGE_WAIT_MS;
    this.browserBlobs =
      options.settings.browser === 'functions' ? new BlobIds(() => repositoryRoot(options.configDir)) : null;
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
   * The browser side of a test's coverage: its code reach paths, or, at
   * `functions` granularity, the files of its `piwi-browser-coverage` attachment
   * with their blob ids, once read. Never rejects.
   */
  private browserCoverage(
    testCase: CollectedTestCase,
    attachments: ReadonlyArray<{ name: string; body?: Buffer }> | undefined,
  ): ReadonlyArray<string | CoverageFile> | undefined | Promise<ReadonlyArray<string | CoverageFile> | undefined> {
    if (this.options.settings.browser === 'off') return undefined;
    const paths = testCase.codeReach;
    const attachment = this.browserBlobs
      ? attachments?.find((a) => a.name === ATTACHMENT_NAMES.browserCoverage)
      : undefined;
    if (!this.browserBlobs || !attachment?.body) return paths;
    let files: CoverageFile[] = [];
    try {
      files = sanitizeCoverage(JSON.parse(attachment.body.toString('utf8')))?.files ?? [];
    } catch {
      return paths;
    }
    const browser = files.filter((file) => file.runtime === 'browser');
    if (browser.length === 0) return paths;
    return this.browserBlobs.withBlobs(browser).catch(() => browser);
  }

  /**
   * Set a test's coverage from its attachments. Null when it is set now;
   * otherwise the test waits for its server coverage, or for the blob ids of
   * its browser files, and the promise resolves once it is set, within the wait
   * bound. Never rejects.
   */
  apply(
    testCase: CollectedTestCase,
    attachments: ReadonlyArray<{ name: string; body?: Buffer }> | undefined,
  ): Promise<void> | null {
    const browser = this.browserCoverage(testCase, attachments);
    const attachment = this.collector
      ? attachments?.find((a) => a.name === ATTACHMENT_NAMES.serverCoverageRequests)
      : undefined;
    const requests = attachment?.body ? parseServerCoverageRequests(attachment.body) : null;
    if (!this.collector || !requests) {
      if (!(browser instanceof Promise)) {
        this.assign(testCase, composeTestCoverage(null, browser, this.options.settings));
        return null;
      }
      const ready = browser.then((files) =>
        this.assign(testCase, composeTestCoverage(null, files, this.options.settings)),
      );
      this.browserPending.add(ready);
      return ready.finally(() => this.browserPending.delete(ready));
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
        void Promise.resolve(browser).then((files) => {
          this.assign(testCase, composeTestCoverage(server, files, this.options.settings));
          resolve();
        });
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
   * Collect what is queued and wait for the tests still waiting, for their
   * server coverage or the blob ids of their browser files, at most `boundMs`;
   * a test still waiting for its server coverage then goes without it, marked
   * incomplete, and one still waiting for blob ids goes without its browser files.
   */
  async settle(boundMs = SETTLE_WAIT_MS): Promise<void> {
    this.collector?.flush();
    const waiting = [...this.browserPending, ...[...this.pending].map((entry) => entry.done)];
    if (waiting.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(waiting),
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
