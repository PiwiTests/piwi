import * as fs from 'node:fs';
import { parseLiveAsk, type LiveAsk, type LiveAskAnswer } from '@piwitests/core/live-view';
import { errorMessage } from '../support/errors.js';
import type { PiwiDashboardOptions, ShardInfo } from '../../public/options.js';
import type { HttpClient } from '../transport/http-client.js';
import { DesktopNotProvenError, HttpError, runTokenHeaders } from '../transport/http-client.js';
import type { StreamBuffer } from './stream-buffer.js';
import { BoundedEventQueue } from './bounded-queue.js';
import type { CrashRecovery } from './crash-recovery.js';
import { uploadCaseFilesInTurn, type Uploader } from '../submit/uploader.js';
import type { FileHandler } from '../files/file-handler.js';
import { Logger } from '../support/logger.js';
import { createLimiter } from '../support/limiter.js';
import { readSetupInfo, type SetupInfo } from '../support/setup-file.js';
import { answeredRunUrl } from '../support/run-url.js';
import { requestedRunTarget } from '../config/env.js';
import { formatDuration } from '../flake/lab.js';
import type { CollectedTestCase, StreamEvent, FilterDetails } from '../../types.js';
import type { WireEnvironmentSnapshot } from '../../types/wire.js';

/**
 * Largest `/events` request body the dashboard accepts (`MAX_EVENT_BATCH_BYTES`
 * in its `server/utils/body-limit.ts`); a larger one is refused with 413.
 */
const SERVER_MAX_EVENT_BATCH_BYTES = 10 * 1024 * 1024;
/** Room kept for the request envelope (`streamToken`, the `testCases` array) around the events. */
const EVENT_ENVELOPE_BYTES = 1024;
/** Byte budget for the events of one `/events` request, well under the server's limit. */
const MAX_EVENT_REQUEST_BYTES = 4 * 1024 * 1024;
/**
 * How long the request of the oldest events may keep failing, for want of an answer or with a server error, from its
 * first failure, before they are set aside so the later ones flow: two and a half minutes, about ten retries of the
 * back-off. An outage shorter than that sets nothing aside, however many sends fail in it.
 */
const EVENT_FAILURE_GRACE_MS = 150_000;
/** The first wait before a failed `/begin` or `/start` is asked again: each next one doubles, up to `maxRetryDelay`. */
const START_RETRY_DELAY_MS = 1000;
/** The least a heartbeat waits once activity put it off: pending events flush first. */
const MIN_HEARTBEAT_WAIT_MS = 250;
/** Longest delay `setTimeout` supports; a larger one fires at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** What the run's `/begin` or `/start` says of it. */
interface RunStart {
  startTime: string;
  metadata: Record<string, any>;
  instanceId: string;
  playwrightVersion?: string | null;
  reporterVersion?: string | null;
  shardInfo?: ShardInfo | null;
  isFullRun?: boolean;
  filterDetails?: FilterDetails | null;
  plannedTotal?: number;
  /** The runner's environment snapshot, sent as the stream opens. */
  environments?: WireEnvironmentSnapshot[];
}

/**
 * An event only someone watching the run reads: a step's. Nobody watching, it is not sent. A test's stops always are:
 * the instance's stuck check reads them, whoever watches.
 */
function liveOnly(event: StreamEvent): boolean {
  return event.type === 'step-begin' || event.type === 'step-end';
}

/**
 * Manages the streaming protocol: opens the run's stream, asked again while the dashboard does not answer, queues
 * events (begin / complete), flushes them in batches, schedules retries on failure, and handles per-test-case live
 * file uploads.
 */
export class StreamManager {
  /**
   * Bounded queue of events waiting to reach the server, those queued before the stream opens included. Capped at
   * `options.maxStreamBufferBytes` so a stalled server, a stream that opens late or an oversized suite cannot grow the
   * reporter's memory without bound; the queue sheds live progress before it ever sheds a test result (see
   * `BoundedEventQueue`).
   */
  private readonly pendingEvents: BoundedEventQueue;
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
   * When the request of the oldest events first failed since the dashboard last took one (ms since the epoch), the
   * start of `EVENT_FAILURE_GRACE_MS`; null while none failed.
   */
  private headFailingSince: number | null = null;
  /** Whether events were set aside yet: the first time warns, the later ones are logged at debug level. */
  private setAsideWarned = false;
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
  /** Ends every file upload, live or not, in flight or still to start: aborted at `uploadRemaining`'s deadline. */
  private readonly fileUploads = new AbortController();
  /** Set when a test-result event left the live stream undelivered: too large to send, or still queued when the drain gave up. */
  private resultsUndelivered = false;
  /** Set when the dashboard refused the run's events or heartbeat as the run is no longer running (`endRun`). */
  private ended = false;

  private _enabled = false;
  private _runId: number | null = null;
  /** The run's page, as the instance named it once the stream opened (`answeredRunUrl`). */
  private _runUrl: string | null = null;
  private _token: string | null = null;
  private _auth: string | null = null;
  private _startPromise: Promise<void> | null = null;
  /** The run the global setup registered, which the stream begins; null without one, and once it cannot begin. */
  private setupInfo: SetupInfo | null = null;
  /** When `start` was called (ms since the epoch), from which a stream that opens after a failed try is late. */
  private startedAt = 0;
  /** Set as the run ends: a stream not open yet is tried once more at once, and given up when that fails too. */
  private startEnding = false;
  /** Which request the latest try to open the stream made: `/begin` of the registered run, or `/start`. */
  private asked: 'begin' | 'start' | null = null;
  /** Set once the stream will never open: the dashboard refused it, or the run ended first. Nothing is queued then. */
  private startGivenUp = false;
  /** Ends the wait before the next try at opening the stream, while one waits. */
  private wakeStart: (() => void) | null = null;

  /** Whether the streaming session is active */
  get enabled(): boolean {
    return this._enabled;
  }
  /** The run's page once the stream opened: the one the instance named, else under the reporter's address. */
  get runUrl(): string | null {
    return this._runUrl;
  }

  /** Server-assigned run ID (`null` until the stream opens, and once the dashboard ended the run) */
  get runId(): number | null {
    return this.ended ? null : this._runId;
  }
  /**
   * Whether the dashboard ended the run while it streamed: it refused an events or heartbeat request with 409, as it
   * does once another run with the same run label started. Nothing more is streamed, and the run goes whole in the
   * end-of-run batch upload, which re-sends it from the reporter's own collection.
   */
  get runEnded(): boolean {
    return this.ended;
  }
  /** Stream authentication token (`null` until the stream opens) */
  get token(): string | null {
    return this._token;
  }
  /** Resolved auth string (API key or session cookie) used in stream requests */
  get auth(): string | null {
    return this._auth;
  }
  /** Promise that resolves once the stream opened, or will never open: `drain` settles it as the run ends. */
  get startPromise(): Promise<void> | null {
    return this._startPromise;
  }
  /** Whether anyone has the run open live, as the dashboard last said; `null` until it says. */
  get isWatched(): boolean | null {
    return this.watched;
  }
  /** Called when the dashboard says someone opened the run. */
  onWatched: (() => void) | null = null;
  /** Called once for each teammate's ask to watch the run the dashboard hands over (`ask` of its answers). */
  onAsk: ((ask: LiveAsk) => void) | null = null;
  /** The asks handed over, by id, the latest 20: one the dashboard hands over again is not told again. */
  private readonly asksHeard = new Set<string>();
  /** The developer's answers to asks, sent one per request of the stream (`askAnswer`) until the dashboard took it. */
  private readonly askAnswers: LiveAskAnswer[] = [];
  /** Called once the run's stream opened, with the run's id and its page. */
  onOpened: ((runId: number, runUrl: string) => void) | null = null;

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
    this.pendingEvents = new BoundedEventQueue(this.options.maxStreamBufferBytes ?? 0);
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
    return this.resultsUndelivered || this.pendingEvents.lostResults;
  }

  /**
   * Begin the streaming session after `onBegin` fires. Non-blocking: the stream opens in the background, asked again
   * with a growing wait while the dashboard does not answer, until the run ends (`drain`). Events queue meanwhile,
   * within `maxStreamBufferBytes`, and go once it opens.
   */
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
    environments?: WireEnvironmentSnapshot[],
  ): void {
    this.startedAt = Date.now();
    this._startPromise = this._doStart({
      startTime,
      metadata,
      instanceId,
      playwrightVersion,
      reporterVersion,
      shardInfo,
      isFullRun,
      filterDetails,
      plannedTotal,
      environments,
    });
  }

  // Open the stream, asking again after a failure a later try may not meet (no answer, a server error, a timeout or
  // a rate limit) until the run ends. A refusal that stays (another client error) gives it up at once.
  private async _doStart(run: RunStart): Promise<void> {
    this.setupInfo = readSetupInfo(this.options.projectName!);
    let authResolved = false;
    let failures = 0;
    for (;;) {
      try {
        if (!authResolved) {
          this._auth = await this.httpClient.resolveAuth(this.options);
          authResolved = true;
          // A request token starts this run alone: a run saved earlier is sent with another run's credentials.
          if (!requestedRunTarget()) await this.recovery.tryUpload(this.httpClient, this._auth);
        }
        const response = await this.openRun(run);
        if (!response?.runId || !response?.streamToken) {
          this.giveUpStart(new Error('the answer names no run'));
          return;
        }
        this.streamOpened(response.runId, response.streamToken, failures > 0, response);
        return;
      } catch (error) {
        // A `/start` the instance may have taken creates a run each time it is asked again.
        const unsure = this.asked === 'start' && !notTaken(error);
        if (refuses(error) || unsure || this.startEnding || this.httpClient.closed) {
          this.giveUpStart(
            failures > 0 && this.asked === 'begin' && isStatus(error, 403) ? new Error(SPENT_SETUP) : error,
          );
          return;
        }
        failures++;
        if (failures === 1) {
          this.logger.warn(
            `Live streaming could not start (${errorMessage(error)}) — asking again while the run goes on, its events kept until the dashboard answers.`,
          );
        } else {
          this.logger.debug(`Live streaming could not start yet (try ${failures}): ${errorMessage(error)}`);
        }
        await this.waitToStartAgain(Math.min(START_RETRY_DELAY_MS * 2 ** (failures - 1), this.maxRetryDelay));
      }
    }
  }

  /**
   * Ask the dashboard for the run's stream: `/begin` the run the global setup registered, else `/start` one. A run
   * the dashboard no longer begins (409: it was cancelled, e.g. by a crash-recovery submit) is set aside for a fresh
   * one.
   */
  private async openRun(run: RunStart): Promise<{ runId?: number; streamToken?: string; runUrl?: unknown } | null> {
    const shardIndex = run.shardInfo?.current;
    const shardTotal = run.shardInfo?.total;
    const setup = this.setupInfo;
    if (setup) {
      this.asked = 'begin';
      try {
        return await this.httpClient.postJSON(
          `/api/test-runs/${setup.runId}/begin`,
          {
            setupToken: setup.setupToken,
            totalTests: run.plannedTotal ?? 0,
            metadata: run.metadata,
            playwrightVersion: run.playwrightVersion,
            reporterVersion: run.reporterVersion,
            shardIndex,
            shardTotal,
            isFullRun: run.isFullRun,
            filterDetails: run.filterDetails,
            ...(run.environments?.length ? { environments: run.environments } : {}),
          },
          this._auth,
          undefined,
          { headers: runTokenHeaders(setup.setupToken) },
        );
      } catch (error) {
        // A requested run's `/setup` spent its request token, so no `/start` follows it.
        if (!(error instanceof HttpError && error.status === 409) || requestedRunTarget()) throw error;
        this.logger.debug(`Setup info expired, creating fresh run...`);
        this.setupInfo = null;
      }
    }
    this.asked = 'start';
    return this.httpClient.postJSON(
      '/api/test-runs/start',
      {
        projectName: this.options.projectName,
        projectDescription: this.options.projectDescription,
        startTime: run.startTime,
        environment: this.options.environment || null,
        label: this.options.label || null,
        keep: this.options.keep === true,
        metadata: run.metadata,
        instanceId: run.instanceId,
        playwrightVersion: run.playwrightVersion,
        reporterVersion: run.reporterVersion,
        shardIndex,
        shardTotal,
        isFullRun: run.isFullRun,
        filterDetails: run.filterDetails,
        totalTests: run.plannedTotal ?? 0,
        ...(run.environments?.length ? { environments: run.environments } : {}),
      },
      this._auth,
    );
  }

  // The stream is open: send what queued while it opened, and say so, with how late when a try failed first.
  private streamOpened(runId: number, token: string, late: boolean, answer: unknown): void {
    const shown = this.setupInfo?.runId === runId ? this.setupInfo.runUrl : undefined;
    this._runUrl = answeredRunUrl(answer, this.options.serverUrl ?? this.httpClient.baseUrl, runId);
    this._runId = runId;
    this._token = token;
    this._enabled = true;
    this.streamBuffer.bindRun(runId);
    // A stream that opened late says so; one on time is plumbing.
    if (late) {
      this.logger.info(
        `Streaming started ${formatDuration(Date.now() - this.startedAt)} late, once the dashboard answered. Run ID: ${runId}`,
      );
    } else this.logger.debug(`Streaming enabled. Run ID: ${runId}`);
    // The global setup printed it already for the run it registered.
    if (this._runUrl !== shown) this.logger.info(`View live progress: ${this._runUrl}`);
    this.onOpened?.(runId, this._runUrl);
    this.lastActivityAt = Date.now();
    this.scheduleHeartbeat();
    // Whatever queued while the stream opened goes now, not at the next event or the finalize.
    if (this.pendingEvents.length > 0) this.flush();
  }

  // The stream will never open: say why, and keep no event for it. The end-of-run batch carries the whole run.
  private giveUpStart(error: unknown): void {
    const requested = requestedRunTarget();
    if (requested) {
      // A requested run starts with its request token alone and has no batch upload to fall back to.
      this.logger.warn(
        `The run could not start on ${requested}, which asked for it (${errorMessage(error)}): ` +
          `nothing is sent. The request may have ended, or its token expired.`,
      );
    } else if (error instanceof HttpError && error.status === 401) {
      this.logger.warn(
        `Live streaming could not start: the dashboard at ${this.options.serverUrl} requires authentication. ` +
          `Set the reporter's \`apiKey\` option, or PIWI_API_KEY in the environment or in the .env file next to ` +
          `the Playwright config — create a key under Settings → Users on the dashboard. ` +
          `Falling back to batch upload at the end of the run.`,
      );
    } else if (this.startEnding && !refuses(error)) {
      this.logger.warn(
        `Live streaming did not start before the run ended (${errorMessage(error)}) — results are submitted in one batch.`,
      );
    } else {
      this.logger.warn(
        `Live streaming is unavailable (${errorMessage(error)}) — results will be submitted in one batch when the run finishes.`,
      );
    }
    this._enabled = false;
    this.startGivenUp = true;
    this.pendingEvents.clear();
  }

  // Wait `ms` before the next try at opening the stream, or less when the run ends meanwhile (`settleStart`).
  private waitToStartAgain(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = () => {
        if (timer) clearTimeout(timer);
        this.wakeStart = null;
        resolve();
      };
      this.wakeStart = wake;
      timer = setTimeout(wake, ms);
      // The wait never keeps the process alive: the run's end wakes it.
      timer.unref?.();
    });
  }

  /** As the run ends: a stream not open yet is tried once more at once, then given up. Resolves once it settled. */
  private async settleStart(): Promise<void> {
    this.startEnding = true;
    this.wakeStart?.();
    await this._startPromise;
  }

  /**
   * Queue a test-case event, held until the stream opens. Triggers an immediate flush when the batch size is
   * reached, otherwise schedules a timer-based flush. A step event is dropped while nobody watches the run
   * (`liveOnly`), and every event once the dashboard ended it or the stream will never open.
   */
  queueEvent(event: StreamEvent): void {
    if (this.ended || this.startGivenUp) return;
    if (this.watched === false && liveOnly(event)) return;
    this.pendingEvents.enqueue(event);

    if (this.pendingEvents.length >= this.options.streamingBatchSize!) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.options.streamingBatchDelay!);
    }
  }

  /**
   * Queue several events and send them at once, in one flush: none of them triggers a batch-size flush of its own, so
   * within that flush they go out in order, in requests sent one after the other. Step and stop events are dropped as
   * `queueEvent` drops them.
   */
  queueEventsNow(events: StreamEvent[]): void {
    if (this.ended || this.startGivenUp) return;
    for (const event of events) {
      if (this.watched === false && liveOnly(event)) continue;
      this.pendingEvents.enqueue(event);
    }
    void this.flush();
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
  // a single event it still refuses leaves the live stream. A request it refuses
  // as the run is no longer running (409) ends the stream (`endRun`). A request
  // it refuses with another client error (except 408 and 429), or one still
  // failing `EVENT_FAILURE_GRACE_MS` after its first failure, is set aside so the
  // later ones flow. On any other failure the unsent events go back to the head
  // of the queue and a retry is scheduled.
  private async sendEvents(events: StreamEvent[]): Promise<boolean> {
    const chunks = this.chunkEvents(events);
    while (chunks.length > 0) {
      const chunk = chunks.shift()!;
      const carried = this.askAnswers[0];
      try {
        const response = await this.httpClient.postJSON(
          `/api/test-runs/${this._runId}/events`,
          { streamToken: this._token, testCases: chunk, ...(carried ? { askAnswer: carried } : {}) },
          this._auth,
          undefined,
          { headers: runTokenHeaders(this._token) },
        );
        this.noteWatched(response);
        this.askAnswerTaken(carried);
        this.retryCount = 0;
        this.headFailingSince = null;
        this.lastActivityAt = Date.now();
      } catch (error) {
        if (endsRun(error)) {
          this.endRun(error);
          return false;
        }
        if (error instanceof HttpError && error.status === 413) {
          if (chunk.length > 1) {
            const half = Math.ceil(chunk.length / 2);
            chunks.unshift(chunk.slice(0, half), chunk.slice(half));
          } else {
            this.dropOversized(chunk[0]);
          }
          continue;
        }
        // Once the time budget closed the client, the drain stops: no failure counts.
        if (refuses(error) || (!this.httpClient.closed && this.failingPastGrace())) {
          this.setAside(chunk, error);
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

  // Whether the request of the oldest events, failing now, has kept failing for
  // `EVENT_FAILURE_GRACE_MS` since its first failure.
  private failingPastGrace(): boolean {
    const now = Date.now();
    this.headFailingSince ??= now;
    return now - this.headFailingSince >= EVENT_FAILURE_GRACE_MS;
  }

  // Leave events the dashboard did not take out of the live stream, so the later
  // ones flow. A test result among them sends the run through the end-of-run
  // batch upload, which carries the full run (see `lostResults`).
  private setAside(events: StreamEvent[], error: unknown): void {
    this.headFailingSince = null;
    const results = events.some((event) => event.type === 'complete');
    if (results) this.resultsUndelivered = true;
    const message =
      `The dashboard did not take ${events.length} live event(s) (${errorMessage(error)}): they are left out of the live view` +
      (results ? `, and the end-of-run upload carries their results.` : '.');
    if (this.setAsideWarned) {
      this.logger.debug(message);
    } else {
      this.setAsideWarned = true;
      this.logger.warn(message);
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
    const ask = parseLiveAsk((response as { ask?: unknown } | null | undefined)?.ask);
    if (ask && !this.asksHeard.has(ask.id)) {
      this.asksHeard.add(ask.id);
      for (const oldest of this.asksHeard) {
        if (this.asksHeard.size <= 20) break;
        this.asksHeard.delete(oldest);
      }
      this.onAsk?.(ask);
    }
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
    const unwatched = next === false && this.watched !== false;
    this.watched = next;
    if (opened) this.onWatched?.();
    // The next heartbeat was set for a watched run's interval: it comes at the shorter one, so the run learns within
    // that one that someone opened it.
    if (unwatched && this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.scheduleHeartbeat();
    }
  }

  /**
   * The developer answered a teammate's ask to watch the run with `not-now`: it goes to the dashboard with the next
   * request of the stream, a heartbeat at once when none is about to go.
   */
  answerAsk(answer: LiveAskAnswer): void {
    if (this.askAnswers.some((pending) => pending.id === answer.id)) return;
    this.askAnswers.push(answer);
    if (this.heartbeatStopped || !this._runId) return;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.scheduleHeartbeat(MIN_HEARTBEAT_WAIT_MS);
  }

  /** The dashboard answered a request that carried `answer`: it took it. */
  private askAnswerTaken(answer: LiveAskAnswer | undefined): void {
    const at = answer ? this.askAnswers.indexOf(answer) : -1;
    if (at >= 0) this.askAnswers.splice(at, 1);
  }

  // Idle time after which a heartbeat goes out.
  private heartbeatDelay(): number {
    return this.watched === false ? this.unwatchedHeartbeatInterval : this.heartbeatInterval;
  }

  // Schedule the next idle heartbeat. Self-rescheduling; cleared by stopHeartbeat.
  private scheduleHeartbeat(delay: number = this.heartbeatDelay()): void {
    if (this.heartbeatStopped || this.heartbeatTimer) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.sendHeartbeat();
    }, delay);
  }

  // Ping the server only when the run has actually been idle. Real event traffic
  // already bumps the server's activity timestamp, so a recent flush (or pending
  // events about to flush) makes the ping redundant — skip it and reschedule.
  private async sendHeartbeat(): Promise<void> {
    if (this.heartbeatStopped || !this._enabled || !this._runId || !this._token) return;

    // Activity within the period: the heartbeat waits for the rest of it only, so a run nobody watched learns that
    // someone opened it within one period. An answer to an ask goes at once.
    const idleFor = Date.now() - this.lastActivityAt;
    if (!this.askAnswers.length && (idleFor < this.heartbeatDelay() || this.pendingEvents.length > 0)) {
      this.scheduleHeartbeat(Math.max(this.heartbeatDelay() - idleFor, MIN_HEARTBEAT_WAIT_MS));
      return;
    }

    const carried = this.askAnswers[0];
    try {
      const response = await this.httpClient.postJSON(
        `/api/test-runs/${this._runId}/heartbeat`,
        { streamToken: this._token, ...(carried ? { askAnswer: carried } : {}) },
        this._auth,
      );
      this.noteWatched(response);
      this.askAnswerTaken(carried);
      this.lastActivityAt = Date.now();
    } catch (error) {
      if (endsRun(error)) {
        this.endRun(error);
        return;
      }
      this.logger.debug(`Heartbeat failed: ${errorMessage(error)}`);
    }
    this.scheduleHeartbeat();
  }

  /**
   * The dashboard refused the run's events or heartbeat as the run is no longer running, as it does once another run
   * with the same run label started. Nothing more is streamed to it, its queued and buffered events are dropped, and
   * the submitter delivers the run whole with the end-of-run batch upload (`runEnded`).
   */
  private endRun(error: unknown): void {
    if (this.ended) return;
    this.logger.warn(
      `The dashboard ended live run #${this._runId} (${errorMessage(error)}), as it does once another run with the ` +
        `same run label starts: give each parallel job its own runLabel. The results are sent in one batch at the end.`,
    );
    this.ended = true;
    this._enabled = false;
    this.stopHeartbeat();
    this.clearRetryTimer();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingEvents.clear();
    this.streamBuffer.clear();
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

  /**
   * Drain all pending and buffered events before the run finishes, once the stream opened or was given up
   * (`settleStart`). Retries up to 10 times with exponential back-off, until the HTTP client is closed.
   */
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
    await this.settleStart();
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
    const dropped = this.pendingEvents.droppedCount;
    if (dropped === 0) return;
    this.bufferPressureReported = true;

    const byType = this.pendingEvents.droppedByType;
    const count = (type: StreamEvent['type']): number => byType[type] ?? 0;
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
              this.fileUploads.signal,
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
   * that weren't uploaded live (`uploadCaseFilesInTurn`). Stops at `deadline`
   * (ms since the epoch), which also ends the uploads in flight, live ones
   * included.
   */
  async uploadRemaining(testCases: CollectedTestCase[], deadline: number | null = null): Promise<void> {
    let stop: ReturnType<typeof setTimeout> | null = null;
    if (deadline !== null) {
      const wait = deadline - Date.now();
      if (wait <= 0) this.stopFileUploads();
      else stop = setTimeout(() => this.stopFileUploads(), Math.min(wait, MAX_TIMER_DELAY_MS));
    }
    try {
      await this.uploadRemainingFiles(testCases);
    } finally {
      if (stop) clearTimeout(stop);
    }
  }

  private async uploadRemainingFiles(testCases: CollectedTestCase[]): Promise<void> {
    if (this.liveUploadPromises.length > 0) {
      await Promise.allSettled(this.liveUploadPromises);
      this.liveUploadPromises = [];
    }
    if (!this._enabled || !this._runId || !this._token) return;

    await uploadCaseFilesInTurn(
      this.uploader,
      this.logger,
      {
        projectName: this.options.projectName!,
        runId: this._runId,
        streamToken: this._token,
        uploadTraces: this.options.uploadTraces,
        auth: this._auth,
      },
      testCases,
      this.fileUploads.signal,
      { skip: (tc) => this.uploadedCaseFiles.has(tc), uploaded: (tc) => this.uploadedCaseFiles.add(tc) },
    );
  }

  /** End every file upload, in flight or still to start, so the run's `/finish` keeps its share of the budget. */
  private stopFileUploads(): void {
    this.fileUploads.abort(new Error('The end-of-run time budget is kept for finishing the run'));
  }
}

/** The dashboard's answer for a run that is no longer running: it was cancelled, or it ended otherwise. */
function endsRun(error: unknown): boolean {
  return error instanceof HttpError && error.status === 409;
}

/** Node's codes for a connection that never opened: the request reached no instance. */
const NOT_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT']);

/** Why a `/begin` asked again is refused: an earlier try, whose answer was lost, began the run. */
const SPENT_SETUP =
  'the dashboard began the run on an earlier try whose answer was lost; the run is sent whole at its end';

/**
 * Whether a failed request certainly took no effect: no connection opened, or the instance or its proxy answered
 * that it took nothing (408, 429, 502, 503). A timeout, a gateway timeout or a connection closed before the answer
 * may follow a request the instance took.
 */
function notTaken(error: unknown): boolean {
  if (error instanceof HttpError) return [408, 429, 502, 503].includes(error.status);
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && NOT_CONNECTED.has(code);
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof HttpError && error.status === status;
}

/**
 * A refusal of a stream's request that no retry changes: a client error other than a timeout (408) or a rate limit
 * (429), or a server that did not prove it holds the desktop token (one that did not answer is asked again).
 */
function refuses(error: unknown): boolean {
  if (error instanceof DesktopNotProvenError) return error.code === undefined;
  return error instanceof HttpError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
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
