import type { H3Event } from 'h3';

/** Every how many milliseconds an open stream gets a comment, so a proxy keeps it and a gone client is noticed. */
const HEARTBEAT_MS = 15_000;
/** How many bytes may wait in a stream's socket before it counts as backed up. */
const BACKLOG_BYTES = 256 * 1024;

/** A server-sent event stream written straight to the response, so a writer can tell when its reader falls behind. */
export interface EventStreamSink {
  /** Write one event whose data is `message` as JSON. Nothing once closed. */
  send(message: unknown): void;
  /** Whether more than `BACKLOG_BYTES` wait to be read: the writer holds back what can wait. */
  backedUp(): boolean;
  /** Called each time what waited was read. */
  onDrain(listener: () => void): void;
  /** Called once, as the stream closes, from either side. */
  onClose(listener: () => void): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Answer `event` with an event stream the handler writes to as it pleases, with a heartbeat comment every
 * `HEARTBEAT_MS`. The handler returns nothing after it: the response is the stream's.
 */
export function openEventStream(event: H3Event): EventStreamSink {
  const { req, res } = event.node;
  const closers: Array<() => void> = [];
  let closed = false;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const onGone = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const close of closers.splice(0)) close();
  };
  req.on('close', onGone);
  res.on('close', onGone);
  res.on('error', onGone);
  return {
    send(message) {
      if (closed) return;
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    },
    backedUp: () => res.writableLength > BACKLOG_BYTES,
    onDrain(listener) {
      res.on('drain', listener);
    },
    onClose(listener) {
      if (closed) listener();
      else closers.push(listener);
    },
    close() {
      if (closed) return;
      res.end();
      onGone();
    },
    get closed() {
      return closed;
    },
  };
}
