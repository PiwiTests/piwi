/**
 * How long an event stream may stay unopened before the page says so. An instance that does not answer, or a proxy
 * that refuses the stream, leaves it unopened, and so does the browser: over HTTP/1.1 it opens at most six connections
 * to one address, and a stream queued behind the ones other tabs hold waits until one of them closes.
 */
export const STREAM_STALL_MS = 5_000;

/** How long a stream that dropped may take to open again before the page says so: past a browser's own wait to reconnect. */
export const STREAM_RECONNECT_STALL_MS = 10_000;

/**
 * Calls `stalled` when `isOpen` still says no after `ms`, whatever the stream went through meanwhile (reconnections, a
 * new stream after an error answer); the returned function cancels the check.
 */
export function onStreamStall(isOpen: () => boolean, stalled: () => void, ms: number = STREAM_STALL_MS): () => void {
  const timer = setTimeout(() => {
    if (!isOpen()) stalled();
  }, ms);
  return () => clearTimeout(timer);
}

/**
 * Watches a stream that should be open. `arm` starts a check while the stream is not open and none runs, which calls
 * `stalled` once if it still is not after `ms`; `disarm` cancels it.
 */
export function stallWatch(isOpen: () => boolean, stalled: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    arm(ms: number = STREAM_STALL_MS): void {
      if (timer || isOpen()) return;
      timer = setTimeout(() => {
        timer = null;
        if (!isOpen()) stalled();
      }, ms);
    },
    disarm(): void {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
