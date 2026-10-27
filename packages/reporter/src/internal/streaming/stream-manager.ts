import * as fs from 'node:fs';
import { errorMessage } from '../support/errors.js';
import type { PiwiDashboardOptions, ShardInfo } from '../../public/options.js';
import type { HttpClient } from '../transport/http-client.js';
import { HttpError } from '../transport/http-client.js';
import type { StreamBuffer } from './stream-buffer.js';
import { BoundedEventQueue } from './bounded-queue.js';
import type { CrashRecovery } from './crash-recovery.js';
import type { Uploader } from '../submit/uploader.js';
import type { FileHandler } from '../files/file-handler.js';
import { Logger } from '../support/logger.js';
import { createLimiter } from '../support/limiter.js';
import { readSetupInfo } from '../support/setup-file.js';
import { runUrl } from '../support/run-url.js';
import type { CollectedTestCase, StreamEvent, FilterDetails } from '../../types.js';

/**
 * Largest `/events` request body the dashboard accepts (`MAX_EVENT_BATCH_BYTES`
 * in its events route); a larger one is refused with 413.
 */
const SERVER_MAX_EVENT_BATCH_BYTES = 10 * 1024 * 1024;
/** Room kept for the request envelope (`streamToken`, the `testCases` array) around the events. */
const EVENT_ENVELOPE_BYTES = 1024;
/** Byte budget for the events of one `/events` request, well under the server's limit. */
const MAX_EVENT_REQUEST_BYTES = 4 * 1024 * 1024;
/** Uploads in a row without any response after which `uploadRemaining` gives up. */
const MAX_UPLOAD_CONNECTION_FAILURES = 3;

/**
 * Manages the streaming protocol: queues events (begin / complete), flushes
 * them in batches, schedules retries on failure, and handles per-test-case
 * live file uploads.
 */
export class StreamManager {
  /**
   * Bounded queue of events waiting to reach the server. Capped at
   * `options.maxStreamBufferBytes` so a stalled server or an oversized suite
   * cannot grow the reporter's memory without bound; the queue sheds live
   * progress before it ever sheds a test result (see `BoundedEventQueue`).
   */
  private readonly pendingEvents: BoundedEventQueue;
  /** Begin events buffered before the stream opens; capped the same way. */
  private readonly pendingBeginEvents: BoundedEventQueue;
  /** Guards `reportBufferPressure` so its summary is logged at most once. */
  private bufferPressureReported = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromises: Array<Promise<boolean>> = [];
  private liveUploadPromises: Array<Promise<void>> = [];
  private readonly limitLiveUpload = createLimiter(2);
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxRetryDelay = 30000;
  /**
   * Idle heartbeat: while the run is open but no events are flowing (e.g. a single
   * long test, or `beforeAll` setup), a periodic ping keeps the server's activity
   * timestamp fresh so the stale-run reaper can tell a live run from a crashed one.
   * The interval must stay well below the server's stale timeout.
   */
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatStopped = false;
  private lastActivityAt = 0;
  private readonly heartbeatInterval = 15000;
  /**
   * The heartbeat interval while nobody watches the run: during a long test no
   * other request goes out, so the heartbeat's answer is how the reporter learns
   * that someone opened the run.
   */
  private readonly unwatchedHeartbeatInterval = 5000;
  /**
   * Whether anyone has the run open live on the dashboard, from the `watched`
   * flag of the last answer to an events or heartbeat request; `null` until the
   * dashboard says, and for a dashboard that does not. Step events are live
   * progress only (each `complete` event carries its test's steps), so none are
   * queued while it is `false`.
   */
  private watched: boolean | null = null;
  /** Tracks cases whose files have already been uploaded live, so `uploadRemaining` can skip them. */
  private readonly uploadedCaseFiles = new WeakSet<CollectedTestCase>();
  /** Set when a test-result event left the live stream undelivered: too large to send, or still queued when the drain gave up. */
  private resultsUndelivered = false;

  private _enabled = false;
  private _runId: number | null = null;
  private _token: string | null = null;
  private _auth: string | null = null;
  private _startPromise: Promise<void> | null = null;

  /** Whether the streaming session is active */
  get enabled(): boolean {
    return this._enabled;
  }
  /** Server-assigned run ID (`null` until the stream opens) */
  get runId(): number | null {
    return this._runId;
  }
  /** Stream authentication token (`null` until the stream opens) */
  get token(): string | null {
    return this._token;
  }
  /** Resolved auth string (API key or session cookie) used in stream requests */
  get auth(): string | null {
    return this._auth;
  }
  /** Promise that resolves when the stream has been fully initialised */
  get startPromise(): Promise<void> | null {
    return this._startPromise;
  }
  /** Whether anyone has the run open live, as the dashboard last said; `null` until it says. */
  get isWatched(): boolean | null {
    return this.watched;
  }
  /** Called when the dashboard says someone opened the run. */
  onWatched: (() => void) | null = null;

  /**
   * @param httpClient  HTTP client for server communication.
   * @param streamBuffer On-disk buffer for the run's undelivered events.
   * @param recovery    Crash-recovery handler for uploading stale payloads on startup.
   * @param uploader    Uploader for per-test-case file uploads.
   * @param fileHandler File-discovery helper for finding traces and attachments.
   * @param options     Piwi Dashboard reporter options.
   * @param logger      Prefixed logger.
   */
  constructor(
    private readonly httpClient: HttpClient,
    private readonly streamBuffer: StreamBuffer,
    private readonly recovery: CrashRecovery,
    private readonly uploader: Uploader,
    private readonly fileHandler: FileHandler,
    private readonly options: PiwiDashboardOptions,
    private readonly logger: Logger = new Logger(),
  ) {
    const maxBytes = this.options.maxStreamBufferBytes ?? 0;
    this.pendingEvents = new BoundedEventQueue(maxBytes);
    this.pendingBeginEvents = new BoundedEventQueue(maxBytes);
  }

  /**
   * Whether a test-result (`complete`) event never reached the server through
   * the live stream: shed under buffer pressure, too large for any request the
   * server accepts, or still undelivered when the drain gave up. When true the
   * submitter finalizes via the end-of-run batch (which re-sends the full run
   * from the reporter's own memory) instead of `/finish`, so the missing
   * results are not lost.
   */
  get lostResults(): boolean {
    return this.resultsUndelivered || this.pendingEvents.lostResults || this.pendingBeginEvents.lostResults;
  }

  /** Begin the streaming session after `onBegin` fires. Non-blocking — the actual handshake runs asynchronously. */
  start(
    startTime: string,
    metadata: Record<string, any>,
    instanceId: string,
    playwrightVersion?: string | null,
    reporterVersion?: string | null,
    shardInfo?: ShardInfo | null,
    isFullRun?: boolean,
    filterDetails?: FilterDetails | null,
    plannedTotal?: number,
  ): void {
    this._startPromise = this._doStart(
      startTime,
      metadata,
      instanceId,
      playwrightVersion,
      reporterVersion,
      shardInfo,
      isFullRun,
      filterDetails,
      plannedTotal,
    );
  }

  private async _doStart(
    startTime: string,
    metadata: Record<string, any>,
    instanceId: string,
    playwrightVersion?: string | null,
    reporterVersion?: string | null,
    shardInfo?: ShardInfo | null,
    isFullRun?: boolean,
    filterDetails?: FilterDetails | null,
    plannedTotal?: number,
  ): Promise<void> {
    const setupInfo = readSetupInfo(this.options.projectName!);

    try {
      this._auth = await this.httpClient.resolveAuth(this.options);
      await this.recovery.tryUpload(this.httpClient, this._auth);

      let response: any;
      const shardIndex = shardInfo?.current;
      const shardTotal = shardInfo?.total;

      if (setupInfo) {
        try {
          response = await this.httpClient.postJSON(
            `/api/test-runs/${setupInfo.runId}/begin`,
            {
              setupToken: setupInfo.setupToken,
              totalTests: plannedTotal ?? 0,
              metadata,
              playwrightVersion,
              reporterVersion,
              shardIndex,
              shardTotal,
              isFullRun,
              filterDetails,
            },
            this._auth,
          );
        } catch (error) {
          // Stale setupInfo — the run was cancelled (e.g. by crash recovery submit).
          // Fall back to creating a fresh run instead of silently disabling streaming.
          if (!(error instanceof HttpError && error.status === 409)) throw error;
          this.logger.debug(`Setup info expired, creating fresh run...`);
          response = await this.httpClient.postJSON(
            '/api/test-runs/start',
            {
              projectName: this.options.projectName,
              projectDescription: this.options.projectDescription,
              startTime,
              environment: this.options.environment || null,
              label: this.options.label || null,
              keep: this.options.keep === true,
              metadata,
              instanceId,
              playwrightVersion,
              reporterVersion,
              shardIndex,
              shardTotal,
              isFullRun,
              filterDetails,
              totalTests: plannedTotal ?? 0,
            },
            this._auth,
          );
        }
      } else {
        response = await this.httpClient.postJSON(
          '/api/test-runs/start',
          {
            projectName: this.options.projectName,
            projectDescription: this.options.projectDescription,
            startTime,
            environment: this.options.environment || null,
            label: this.options.label || null,
            keep: this.options.keep === true,
            metadata,
            instanceId,
            playwrightVersion,
            reporterVersion,
            shardIndex,
            shardTotal,
            isFullRun,
            filterDetails,
            totalTests: plannedTotal ?? 0,
          },
          this._auth,
        );
      }

      if (response?.runId && response?.streamToken) {
        this._runId = response.runId;
        this._token = response.streamToken;
        this._enabled = true;
        this.streamBuffer.bindRun(response.runId);
        this.logger.info(`Streaming enabled. Run ID: ${response.runId}`);
        if (this.options.serverUrl) {
          this.logger.info(`Watch live: ${runUrl(this.options.serverUrl, response.runId)}`);
        }
        this.lastActivityAt = Date.now();
        this.scheduleHeartbeat();

        if (this.pendingBeginEvents.length > 0) {
          this.pendingEvents.prepend(this.pendingBeginEvents.takeAll());
        }
        // Flush whatever queued while `/start` was in flight — step-end events
        // land in `pendingEvents` directly, so keying this off begin events
        // alone would leave them sitting until the next event or the finalize.
        if (this.pendingEvents.length > 0) this.flush();
      }
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        this.logger.warn(
          `Live streaming could not start: the dashboard at ${this.options.serverUrl} requires authentication. ` +
            `Set the reporter's \`apiKey\` option, or PIWI_API_KEY in the environment or in the .env file next to ` +
            `the Playwright config — create a key under Settings → Users on the dashboard. ` +
            `Falling back to batch upload at the end of the run.`,
        );
      } else {
        this.logger.warn(
          `Live streaming is unavailable (${errorMessage(error)}) — results will be submitted in one batch when the run finishes.`,
        );
      }
      this._enabled = false;
    }
  }

  // Queues a begin event; held in a pre-start buffer until the stream is open,
  // then prepended to the main queue so it arrives before the matching complete event.
  /** Queue a test-case `begin` event. Held in a pre-start buffer if the stream is not yet open, then prepended so it arrives before the matching `complete` event. */
  queueBeginEvent(event: StreamEvent): void {
    if (this._enabled && this._runId) {
      this.queueEvent(event);
    } else {
      this.pendingBeginEvents.enqueue(event);
    }
  }

  /**
   * Queue a test-case event. Triggers an immediate flush when the batch size is
   * reached, otherwise schedules a timer-based flush. A step event is dropped
   * while nobody watches the run.
   */
  queueEvent(event: StreamEvent): void {
    if (this.watched === false && (event.type === 'step-begin' || event.type === 'step-end')) return;
    this.pendingEvents.enqueue(event);

    if (this.pendingEvents.length >= this.options.streamingBatchSize!) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.options.streamingBatchDelay!);
    }
  }

  /** Flush all pending events to the server. Returns a promise that resolves to `true` on success or `false` on failure (events are re-queued for retry). */
  flush(): Promise<boolean> | null {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingEvents.isEmpty || !this._enabled || !this._runId) return null;

    // Never rejects: failed events are re-queued so the retry timer or the
    // end-of-run drain can resend them (the server deduplicates).
    const promise = this.sendEvents(this.pendingEvents.takeAll());
    this.flushPromises.push(promise);
    return promise;
  }

  // Post the events in order, in requests of at most `MAX_EVENT_REQUEST_BYTES`.
  // A request the server refuses as too large (413) is split in half and resent;
  // a single event it still refuses leaves the live stream. On any other failure
  // the unsent events go back to the head of the queue and a retry is scheduled.
  private async sendEvents(events: StreamEvent[]): Promise<boolean> {
    const chunks = this.chunkEvents(events);
    while (chunks.length > 0) {
      const chunk = chunks.shift()!;
      try {
        const response = await this.httpClient.postJSON(
          `/api/test-runs/${this._runId}/events`,
          { streamToken: this._token, testCases: chunk },
          this._auth,
        );
        this.noteWatched(response);
        this.retryCount = 0;
        this.lastActivityAt = Date.now();
      } catch (error) {
        if (error instanceof HttpError && error.status === 413) {
          if (chunk.length > 1) {
            const half = Math.ceil(chunk.length / 2);
            chunks.unshift(chunk.slice(0, half), chunk.slice(half));
          } else {
            this.dropOversized(chunk[0]);
          }
          continue;
        }
        this.pendingEvents.prepend(chunk.concat(...chunks));
        this.scheduleRetry(errorMessage(error));
        return false;
      }
    }
    return true;
  }

  // Group events into request-sized chunks, keeping their order. An event
  // larger than any request the server accepts is dropped here.
  private chunkEvents(events: StreamEvent[]): StreamEvent[][] {
    const chunks: StreamEvent[][] = [];
    let chunk: StreamEvent[] = [];
    let chunkBytes = 0;
    for (const event of events) {
      const bytes = serializedBytes(event);
      if (bytes > SERVER_MAX_EVENT_BATCH_BYTES - EVENT_ENVELOPE_BYTES) {
        this.dropOversized(event);
        continue;
      }
      if (chunk.length > 0 && chunkBytes + bytes > MAX_EVENT_REQUEST_BYTES) {
        chunks.push(chunk);
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(event);
      chunkBytes += bytes;
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
  }

  // Leave an event the server will not accept out of the live stream. A test
  // result dropped this way sends the run through the end-of-run batch upload,
  // which carries the full run (see `lostResults`).
  private dropOversized(event: StreamEvent): void {
    if (event.type === 'complete') {
      this.resultsUndelivered = true;
      this.logger.warn(
        `The live result of "${event.title}" is too large for the dashboard's event stream — it is sent with the end-of-run upload instead.`,
      );
    } else {
      this.logger.debug(`Dropped a ${event.type} event for "${event.title}" that is too large to stream.`);
    }
  }

  private scheduleRetry(reason: string): void {
    if (this.retryTimer) return;
    this.retryCount++;
    if (this.retryCount === 1) {
      this.logger.warn(`Streaming to the dashboard was interrupted (${reason}) — events are buffered and retried.`);
    }
    const delay = Math.min(1000 * Math.pow(2, this.retryCount - 1), this.maxRetryDelay);
    this.logger.debug(`Will retry streaming flush in ${delay}ms (attempt ${this.retryCount})`);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const buffered = this.streamBuffer.load();
      if (buffered.length > 0) {
        this.streamBuffer.clear();
        this.pendingEvents.prepend(buffered);
      }
      if (this.pendingEvents.length > 0) this.flush();
    }, delay);
  }

  /**
   * Take the dashboard's answer on whether anyone watches the run, from any
   * request of the stream. An answer without the flag (an older dashboard)
   * keeps step events flowing.
   */
  noteWatched(response: unknown): void {
    const watched = (response as { watched?: unknown } | null | undefined)?.watched;
    const next = typeof watched === 'boolean' ? watched : null;
    if (next !== null && next !== this.watched) {
      this.logger.debug(
        next
          ? 'The run is open on the dashboard: streaming live steps.'
          : 'Nobody is watching the run: live steps are not sent.',
      );
    }
    const opened = next === true && this.watched !== true;
    this.watched = next;
    if (opened) this.onWatched?.();
  }

  // Idle time after which a heartbeat goes out.
  private heartbeatDelay(): number {
    return this.watched === false ? this.unwatchedHeartbeatInterval : this.heartbeatInterval;
  }

  // Schedule the next idle heartbeat. Self-rescheduling; cleared by stopHeartbeat.
  private scheduleHeartbeat(): void {
    if (this.heartbeatStopped || this.heartbeatTimer) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.sendHeartbeat();
    }, this.heartbeatDelay());
  }

  // Ping the server only when the run has actually been idle. Real event traffic
  // already bumps the server's activity timestamp, so a recent flush (or pending
  // events about to flush) makes the ping redundant — skip it and reschedule.
  private async sendHeartbeat(): Promise<void> {
    if (this.heartbeatStopped || !this._enabled || !this._runId || !this._token) return;

    const idleFor = Date.now() - this.lastActivityAt;
    if (idleFor < this.heartbeatDelay() || this.pendingEvents.length > 0) {
      this.scheduleHeartbeat();
      return;
    }

    try {
      const response = await this.httpClient.postJSON(
        `/api/test-runs/${this._runId}/heartbeat`,
        { streamToken: this._token },
        this._auth,
      );
      this.noteWatched(response);
      this.lastActivityAt = Date.now();
    } catch (error) {
      this.logger.debug(`Heartbeat failed: ${errorMessage(error)}`);
    }
    this.scheduleHeartbeat();
  }

  /** Stop the idle heartbeat permanently (called when the run is wrapping up). */
  private stopHeartbeat(): void {
    this.heartbeatStopped = true;
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Clear a scheduled flush retry so its timer cannot fire after the run wraps up. */
  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Drain all pending and buffered events before the run finishes. Retries up to 10 times with exponential back-off, until the HTTP client is closed. */
  async drain(): Promise<void> {
    try {
      await this._drain();
    } finally {
      // Report any buffer pressure exactly once, whichever exit the drain took.
      this.reportBufferPressure();
    }
  }

  private async _drain(): Promise<void> {
    this.stopHeartbeat();
    this.clearRetryTimer();
    if (!this._enabled) {
      this.pendingEvents.clear();
      this.flushPromises = [];
      return;
    }

    try {
      const MAX_ATTEMPTS = 10;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (this._enabled && !this.pendingEvents.isEmpty) this.flush();
        if (this.flushPromises.length > 0) {
          await Promise.allSettled(this.flushPromises);
          this.flushPromises = [];
        }
        if (this.pendingEvents.isEmpty) {
          const buffered = this.streamBuffer.load();
          if (buffered.length > 0) {
            this.streamBuffer.clear();
            this.pendingEvents.prepend(buffered);
            continue;
          }
          return;
        }
        if (this.httpClient.closed) break;
        if (attempt === 0) {
          this.logger.warn(
            `The dashboard has not accepted ${this.pendingEvents.length} live event(s) yet — retrying delivery before the final submit (this can take a few minutes)...`,
          );
        }
        this.logger.debugError(
          `${this.pendingEvents.length} events pending, retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`,
        );
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 10000)));
      }

      if (!this.pendingEvents.isEmpty) {
        const remaining = this.pendingEvents.takeAll();
        if (remaining.some((event) => event.type === 'complete')) this.resultsUndelivered = true;
        this.logger.warn(
          `Could not deliver ${remaining.length} live event(s) to the dashboard — continuing with the end-of-run submit.`,
        );
        this.streamBuffer.append(remaining);
      }
    } finally {
      // Flush failures inside the loop re-arm the retry timer; the drain is the
      // last delivery attempt, so nothing may stay scheduled past it.
      this.clearRetryTimer();
    }
  }

  /** Delete the run's on-disk event buffer. Called once the run's results reached the server. */
  discardBuffered(): void {
    this.streamBuffer.clear();
  }

  // Emit a single summary when buffer pressure shed events, so a full disk or a
  // stalled server does not silently swallow data. Reported once per drain.
  private reportBufferPressure(): void {
    if (this.bufferPressureReported) return;
    const dropped = this.pendingEvents.droppedCount + this.pendingBeginEvents.droppedCount;
    if (dropped === 0) return;
    this.bufferPressureReported = true;

    const byType = this.pendingEvents.droppedByType;
    const beginByType = this.pendingBeginEvents.droppedByType;
    const count = (type: StreamEvent['type']): number => (byType[type] ?? 0) + (beginByType[type] ?? 0);
    const steps = count('step-begin') + count('step-end');
    const begins = count('begin');
    const results = count('complete');
    const limitMb = ((this.options.maxStreamBufferBytes ?? 0) / (1024 * 1024)).toFixed(0);

    if (results > 0) {
      this.logger.warn(
        `Stream buffer hit its ${limitMb} MB limit — dropped ${dropped} live event(s), including ${results} test result(s) ` +
          `that will not show live on the dashboard (the run's final counts stay accurate, and the end-of-run submit still carries the full run). ` +
          `Raise \`maxStreamBufferBytes\` or check the dashboard connection.`,
      );
    } else {
      this.logger.warn(
        `Stream buffer hit its ${limitMb} MB limit — dropped ${dropped} live progress event(s) ` +
          `(${steps} step, ${begins} begin) to stay within budget. No test results were lost.`,
      );
    }
  }

  /** Schedule a live upload of trace and attachment files for a test case. Skips cases with no files. Concurrency is limited to 2 simultaneous uploads. */
  scheduleLiveUpload(tc: CollectedTestCase): void {
    const hasTrace = !!this.options.uploadTraces && this.fileHandler.findTraceFiles(tc).some((p) => fs.existsSync(p));
    const hasAttachments = this.fileHandler.findAllAttachments(tc).length > 0;
    if (!hasTrace && !hasAttachments) return;

    const promise = (async () => {
      if (this._startPromise) await this._startPromise;
      if (!this._enabled || !this._runId || !this._token) return;

      // The complete event must reach the server before it can link files.
      // queueEvent may have already triggered a batch-size flush that took all
      // pending events, making our flush() return null.  Wait for any in-flight
      // flush promises first, then try to flush remaining events.
      if (this.flushPromises.length > 0) {
        await Promise.allSettled(this.flushPromises);
      }
      const flush = this.flush();
      if (flush) await flush;

      // Retry on 404: the events batch carrying this case may still be in flight
      const delays = [0, 1000, 3000];
      for (let attempt = 0; attempt < delays.length; attempt++) {
        if (delays[attempt]) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        try {
          await this.limitLiveUpload(() =>
            this.uploader.uploadCaseFiles(
              this.options.projectName!,
              this._runId!,
              this._token!,
              tc,
              this.options.uploadTraces,
              this._auth,
            ),
          );
          this.uploadedCaseFiles.add(tc);
          return;
        } catch (error) {
          const retryable = error instanceof HttpError && error.status === 404;
          if (!retryable || attempt === delays.length - 1) {
            this.logger.debug(`Live file upload failed for "${tc.title}": ${errorMessage(error)}`);
            return; // The end-of-run pass retries cases that failed here
          }
        }
      }
    })();

    this.liveUploadPromises.push(promise);
  }

  /**
   * Wait for all live uploads to settle, then upload files for any test cases
   * that weren't uploaded live. Stops after `MAX_UPLOAD_CONNECTION_FAILURES`
   * uploads in a row got no response at all.
   */
  async uploadRemaining(testCases: CollectedTestCase[]): Promise<void> {
    if (this.liveUploadPromises.length > 0) {
      await Promise.allSettled(this.liveUploadPromises);
      this.liveUploadPromises = [];
    }
    if (!this._enabled || !this._runId || !this._token) return;

    let connectionFailures = 0;
    for (const tc of testCases) {
      if (this.uploadedCaseFiles.has(tc)) continue;
      try {
        const uploaded = await this.uploader.uploadCaseFiles(
          this.options.projectName!,
          this._runId,
          this._token,
          tc,
          this.options.uploadTraces,
          this._auth,
        );
        if (uploaded) this.uploadedCaseFiles.add(tc);
        connectionFailures = 0;
      } catch (error) {
        this.logger.warn(`Failed to upload files for "${tc.title}": ${errorMessage(error)}`);
        // Any HTTP status means the dashboard answered; only a request that got
        // no response (refused, reset, timed out) counts toward giving up.
        connectionFailures = error instanceof HttpError ? 0 : connectionFailures + 1;
        if (connectionFailures >= MAX_UPLOAD_CONNECTION_FAILURES) {
          this.logger.warn(`The dashboard stopped responding — skipping the file uploads of the remaining tests.`);
          return;
        }
      }
    }
  }
}

// UTF-8 size of the event's JSON, the unit the server's limit counts, plus one
// byte for the separating comma.
function serializedBytes(event: StreamEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event)) + 1;
  } catch {
    return 0;
  }
}
