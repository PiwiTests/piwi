/**
 * How long an event stream may stay unopened before the page says so. An instance that does not answer, or a proxy
 * that refuses the stream, leaves it unopened, and so does the browser: over HTTP/1.1 it opens at most six connections
 * to one address, and a stream queued behind the ones other tabs hold waits until one of them closes.
 */
export const STREAM_STALL_MS = 5_000;

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
