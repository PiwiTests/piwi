import type { H3Event } from 'h3';
import {
  LIVE_HEARTBEAT,
  LIVE_STREAM_TYPE,
  encodeLiveViewerMessage,
  type LiveViewerMessage,
} from '@piwitests/core/live-view';

/** Every how many milliseconds an open stream gets a comment, so a proxy keeps it and a gone client is noticed. */
const HEARTBEAT_MS = 15_000;
/** How many bytes may wait in a stream's socket before it counts as backed up. */
const BACKLOG_BYTES = 256 * 1024;

/** A stream written straight to the response, so a writer can tell when its reader falls behind. */
export interface EventStreamSink {
  /** Write one message: an event whose data is `message` as JSON, or a live message. Nothing once closed. */
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

/** How a stream writes: its media type, what it opens with, its heartbeat, and each message. */
interface StreamFormat {
  type: string;
  opening: string | Uint8Array;
  heartbeat: string | Uint8Array;
  encode(message: unknown): string | Uint8Array;
}

/**
 * Answer `event` with a stream the handler writes to as it pleases, with a heartbeat every `HEARTBEAT_MS`. The handler
 * returns nothing after it: the response is the stream's.
 */
function openStream(event: H3Event, format: StreamFormat): EventStreamSink {
  const { req, res } = event.node;
  const closers: Array<() => void> = [];
  let closed = false;
  res.writeHead(200, {
    'Content-Type': format.type,
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(format.opening);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(format.heartbeat);
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
  // A client that left while the handler awaited its checks fired `close` before these listeners existed.
  if (req.destroyed || res.closed) onGone();
  return {
    send(message) {
      if (closed) return;
      res.write(format.encode(message));
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

/**
 * Answer `event` with a server-sent event stream, each message an event whose data is the message as JSON, opened by a
 * comment and with a heartbeat comment every `HEARTBEAT_MS`.
 */
export function openEventStream(event: H3Event): EventStreamSink {
  return openStream(event, {
    type: 'text/event-stream',
    opening: ': open\n\n',
    heartbeat: ': heartbeat\n\n',
    encode: (message) => `data: ${JSON.stringify(message)}\n\n`,
  });
}

/**
 * Answer `event` with a stream of live messages (`LIVE_STREAM_TYPE`, `@piwitests/core/live-view`): each message a
 * viewer's (`LiveViewerMessage`), a frame's image as its data, opened by a heartbeat and with one every
 * `HEARTBEAT_MS`, which a reader passes over.
 */
export function openLiveStream(event: H3Event): EventStreamSink {
  return openStream(event, {
    type: LIVE_STREAM_TYPE,
    opening: LIVE_HEARTBEAT,
    heartbeat: LIVE_HEARTBEAT,
    encode: (message) => encodeLiveViewerMessage(message as LiveViewerMessage),
  });
}
