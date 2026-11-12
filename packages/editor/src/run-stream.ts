/**
 * Server-sent events from a Piwi instance, read over `fetch`: the instance's run events (`GET /api/stream`), on one
 * connection per instance and key whatever the number of contexts that read it, and one run's events
 * (`GET /api/test-runs/:id/stream`) while the editor follows that run, on one connection whatever follows it
 * (`RunStreams`). A connection that drops is opened again after a second, then twice as long each time up to a minute;
 * an instance without the route is asked again every five minutes, and one that refuses the key is not asked again
 * until the credentials change.
 */
import type { PiwiConnection } from '@piwitests/core/dotenv';
import { PiwiClient } from './piwi-client.js';

/** The first wait before a connection is opened again; it doubles with each failed attempt, up to `MAX_RETRY_MS`. */
const RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** The wait before an instance that answered 404 is asked again: it has no such route. */
const NOT_FOUND_RETRY_MS = 5 * 60_000;
/** A connection that brings nothing for this long is opened again: the instance sends a heartbeat every 15 s. */
const IDLE_MS = 45_000;

/**
 * A run's lifecycle event on the instance's stream, or its tally while it runs (`run-progress`, at most every two
 * seconds a run, from an instance that sends it: its counts, each result counted as it is reported).
 */
export interface InstanceEvent {
  type:
    | 'run-started'
    | 'run-initializing'
    | 'run-finalizing'
    | 'run-finished'
    | 'run-submitted'
    | 'run-cancelled'
    | 'rollup-updated'
    | 'run-progress';
  runId: number;
  projectId: number;
  status?: string;
  totalTests?: number;
  passedTests?: number;
  failedTests?: number;
  skippedTests?: number;
  didNotRunTests?: number;
}

/**
 * An event of one run's stream: `init` (its counts), `test-begin`, `test-completed`, `run-progress` (its counts),
 * `run-finalizing`, `run-finished` (its final status and counts).
 */
export interface RunEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface EventStreamOptions {
  /** The first wait before a connection is opened again, in ms; it doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** The wait after the instance answered 404; null closes the stream then. */
  notFoundRetryMs?: number | null;
  /** How long a connection may bring nothing before it is opened again. */
  idleMs?: number;
}

/**
 * The `data` of each event of a server-sent events body, chunk by chunk: an event's `data:` lines joined with a line
 * break. Comments, such as the instance's heartbeat, and the other fields are skipped; an event without data is none.
 */
export class EventParser {
  private rest = '';
  private data: string[] = [];

  /** The events this chunk completes. */
  push(chunk: string): string[] {
    let text = this.rest + chunk;
    // A carriage return at the end may be the first half of a CRLF: it waits for the next chunk.
    const held = text.endsWith('\r') ? '\r' : '';
    if (held) text = text.slice(0, -1);
    const lines = text.split(/\r\n|\r|\n/);
    this.rest = lines.pop()! + held;
    const events: string[] = [];
    for (const line of lines) {
      if (line === '') {
        if (this.data.length) events.push(this.data.join('\n'));
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      if ((colon < 0 ? line : line.slice(0, colon)) !== 'data') continue;
      const value = colon < 0 ? '' : line.slice(colon + 1);
      this.data.push(value.startsWith(' ') ? value.slice(1) : value);
    }
    return events;
  }
}

/** Opens the response whose body is the stream, aborted through `signal`. */
export type OpenEvents = (signal: AbortSignal) => Promise<Response>;

/**
 * One server-sent events stream, opened again whenever it drops, until `close`. It is `connected` once the instance
 * sent something on the connection, an event or its heartbeat, which also brings the wait before the next attempt
 * back to its first value. Each event's data reaches `onData` parsed from JSON; data that is not JSON is skipped.
 */
export class EventStream {
  connected = false;
  /** The instance refused the key (401 or 403): the stream is not opened again until `retry`. */
  refused = false;
  private closed = false;
  /** `reopen` asked for a new connection while one was open: it opens at once once that one ends. */
  private again = false;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wait: number;

  constructor(
    private readonly open: OpenEvents,
    private readonly onData: (data: unknown) => void,
    private readonly onState: (connected: boolean) => void = () => {},
    private readonly options: EventStreamOptions = {},
  ) {
    this.wait = options.retryMs ?? RETRY_MS;
    void this.connect();
  }

  /** Open it again at once, unless it is open: the credentials it was refused with may be accepted this time. */
  retry(): void {
    if (this.closed || this.abort) return;
    this.refused = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wait = this.options.retryMs ?? RETRY_MS;
    void this.connect();
  }

  /**
   * Open it again at once, open or not: a reader that joins it reads the catch-up the instance sends a new connection.
   * Its readers read that catch-up again, as after a connection that dropped.
   */
  reopen(): void {
    if (this.closed) return;
    this.refused = false;
    if (this.abort) {
      this.again = true;
      this.abort.abort();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wait = this.options.retryMs ?? RETRY_MS;
    void this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.connected = false;
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const abort = new AbortController();
    this.abort = abort;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(), this.options.idleMs ?? IDLE_MS);
      idle.unref?.();
    };
    /** When to try again; null: not again. */
    let retryIn: number | null = null;
    try {
      alive();
      const response = await this.open(abort.signal);
      if (response.ok && response.body) {
        await this.read(response.body, alive, abort.signal);
        retryIn = this.backoff();
      } else {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) this.refused = true;
        else if (response.status === 404) {
          retryIn = this.options.notFoundRetryMs === undefined ? NOT_FOUND_RETRY_MS : this.options.notFoundRetryMs;
        } else retryIn = this.backoff();
      }
    } catch {
      retryIn = this.backoff();
    } finally {
      clearTimeout(idle);
      this.abort = null;
      if (this.connected) {
        this.connected = false;
        if (!this.closed) this.onState(false);
      }
    }
    if (this.again) {
      this.again = false;
      this.wait = this.options.retryMs ?? RETRY_MS;
      retryIn = 0;
    }
    if (this.closed || retryIn === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, retryIn);
    this.timer.unref?.();
  }

  /** The wait before the next attempt; the one after it is twice as long. */
  private backoff(): number {
    const wait = this.wait;
    this.wait = Math.min(wait * 2, this.options.maxRetryMs ?? MAX_RETRY_MS);
    return wait;
  }

  /** Read the body's events until it ends, or `signal` aborts it, whatever the body does with the signal. */
  private async read(body: ReadableStream<Uint8Array>, alive: () => void, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new EventParser();
    const cancel = () => void reader.cancel().catch(() => {});
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.closed) return;
        alive();
        if (!this.connected) {
          this.connected = true;
          this.wait = this.options.retryMs ?? RETRY_MS;
          this.onState(true);
        }
        for (const data of parser.push(decoder.decode(value, { stream: true }))) {
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }
          this.onData(event);
        }
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
    }
  }
}

function isInstanceEvent(data: unknown): data is InstanceEvent {
  const event = data as Partial<InstanceEvent> | null;
  return typeof event?.type === 'string' && typeof event.runId === 'number' && typeof event.projectId === 'number';
}

/** Whether a run stream's data is an event of the run. */
export function isRunEvent(data: unknown): data is RunEvent {
  const event = data as Partial<RunEvent> | null;
  return typeof event?.type === 'string' && !!event.data && typeof event.data === 'object';
}

/**
 * The run events of one instance, read with one key: one connection, shared by every context that reads that instance
 * with that key.
 */
export class InstanceStream extends EventStream {
  constructor(
    readonly connection: PiwiConnection,
    onEvent: (event: InstanceEvent) => void,
    onState?: (connected: boolean) => void,
    options?: EventStreamOptions,
  ) {
    super(
      (signal) => new PiwiClient(connection).events(signal),
      (data) => {
        if (isInstanceEvent(data)) onEvent(data);
      },
      onState,
      options,
    );
  }
}

/**
 * One run's stream per instance, key and run, whoever follows the run: the context's run in progress and the CI
 * sessions read one connection. A follower that joins a stream open already has it opened again, so its catch-up
 * reaches every follower; the stream closes with its last follower. An instance without the run's stream (404) is not
 * asked again.
 */
export class RunStreams {
  private readonly streams = new Map<string, { stream: EventStream; listeners: Set<(event: RunEvent) => void> }>();

  constructor(private readonly options: EventStreamOptions = {}) {}

  /** Follow the events of run `runId` of `client`'s instance; the function returned stops following them. */
  follow(client: PiwiClient, runId: number, listener: (event: RunEvent) => void): () => void {
    const key = `${client.connection.serverUrl}\n${client.connection.apiKey ?? ''}\n${runId}`;
    const open = this.streams.get(key);
    if (open) {
      open.listeners.add(listener);
      open.stream.reopen();
    } else {
      const listeners = new Set([listener]);
      const stream = new EventStream(
        (signal) => client.runEvents(runId, signal),
        (data) => {
          if (isRunEvent(data)) for (const each of Array.from(listeners)) each(data);
        },
        undefined,
        { ...this.options, notFoundRetryMs: null },
      );
      this.streams.set(key, { stream, listeners });
    }
    let followed = true;
    return () => {
      if (!followed) return;
      followed = false;
      const current = this.streams.get(key);
      if (!current?.listeners.delete(listener) || current.listeners.size) return;
      current.stream.close();
      this.streams.delete(key);
    };
  }

  /** How many runs' streams are open: one per instance, key and run. */
  get size(): number {
    return this.streams.size;
  }

  dispose(): void {
    for (const { stream } of this.streams.values()) stream.close();
    this.streams.clear();
  }
}
