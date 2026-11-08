/**
 * The two event streams of a run target, framework-neutral: the window's (`/api/desktop/events`, what the window
 * shows of the connection and the requests it asks about) and the shell's (`/api/desktop/notifications`, the stop the
 * shell must pass on to a run it started). A host adapts them to its framework (the desktop app's Nitro routes,
 * `./run-target-http.ts`) after its guard took the access token; this module decides what each stream says and when a
 * reader that falls behind is held back or cut.
 */
import { pathnameOf } from './run-target-routes';
import {
  runTargetConnection,
  subscribeRunTargetShell,
  subscribeRunTargetWindow,
  waitingRunRequests,
  type ShellRunTargetCommand,
} from './run-target';
import type { RunTargetMessage } from './run-target-view';

/** The window's stream. */
export const WINDOW_STREAM_PATH = '/api/desktop/events';

/** The shell's stream. */
export const SHELL_STREAM_PATH = '/api/desktop/notifications';

/** What a stream's reader may leave unread before a message waits for it, in bytes. */
export const STREAM_HOLD_BYTES = 1024 * 1024;

/** What a stream's reader may leave unread before the stream is cut, in bytes. */
export const STREAM_CUT_BYTES = 32 * 1024 * 1024;

/**
 * Where a stream writes. A sink that can count what its reader has not read gives `buffered` and `onDrain` together;
 * one that cannot gives neither.
 */
export type StreamSink = {
  /** Write one event whose data is `message` as JSON. */
  send(message: unknown): void;
  /** End the stream: cut it when anything unread is left, else end it. */
  close(): void;
} & (
  | {
      /** What the reader has not read yet, in bytes. */
      buffered(): number;
      /** Called each time what waited was read. */
      onDrain(listener: () => void): void;
    }
  | { buffered?: undefined; onDrain?: undefined }
);

/**
 * A `send` onto `sink` that counts what the reader has not read: past `STREAM_HOLD_BYTES` a message waits, in order,
 * until the reader catches up; past `STREAM_CUT_BYTES`, counting what waits, the stream is cut. Without a count the
 * messages go straight out.
 */
export function limitedSend<T>(sink: StreamSink): (message: T) => void {
  if (!sink.buffered) return (message) => sink.send(message);
  const { buffered: unread } = sink;
  const waiting: { message: T; size: number }[] = [];
  let waitingBytes = 0;
  let cut = false;
  const flush = () => {
    while (!cut && waiting.length > 0 && unread() <= STREAM_HOLD_BYTES) {
      const next = waiting.shift()!;
      waitingBytes -= next.size;
      sink.send(next.message);
    }
  };
  sink.onDrain(flush);
  return (message) => {
    if (cut) return;
    const size = Buffer.byteLength(`data: ${JSON.stringify(message)}\n\n`);
    if (unread() + waitingBytes + size > STREAM_CUT_BYTES) {
      cut = true;
      waiting.length = 0;
      sink.close();
      return;
    }
    if (waiting.length > 0 || unread() > STREAM_HOLD_BYTES) {
      waiting.push({ message, size });
      waitingBytes += size;
      return;
    }
    sink.send(message);
  };
}

/**
 * Open the window's stream on `send`: first the connection, then the requests still asked about (a window that opens
 * later hears them again), then each change. Returns the function that ends it.
 */
export function openWindowStream(send: (message: RunTargetMessage) => void): () => void {
  const unsubscribe = subscribeRunTargetWindow(send);
  send({ type: 'run-target', connection: runTargetConnection() });
  for (const request of waitingRunRequests()) send({ type: 'run-request', request });
  return unsubscribe;
}

/** Open the shell's stream on `send`: each stop of a run it started. Returns the function that ends it. */
export function openShellStream(send: (command: ShellRunTargetCommand) => void): () => void {
  return subscribeRunTargetShell(send);
}

/** The stream a method and a path name, or null for none. */
export function matchStream(method: string, path: string): 'window' | 'shell' | null {
  if (method.toUpperCase() !== 'GET') return null;
  const pathname = pathnameOf(path);
  if (pathname === WINDOW_STREAM_PATH) return 'window';
  if (pathname === SHELL_STREAM_PATH) return 'shell';
  return null;
}
