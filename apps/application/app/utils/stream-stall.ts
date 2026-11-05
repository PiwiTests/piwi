/**
 * How long an event stream may stay unopened before the page says so. An instance that does not answer leaves it
 * unopened, and so does the browser: over HTTP/1.1 it opens at most six connections to one address, and a stream
 * queued behind the ones other tabs hold waits until one of them closes.
 */
export const STREAM_STALL_MS = 5_000;

/** `EventSource.CONNECTING`, which Node, where the unit tests run, does not define. */
const CONNECTING = 0;

/** Calls `stalled` when `source` is still connecting after `ms`; the returned function cancels the check. */
export function onStreamStall(
  source: Pick<EventSource, 'readyState'>,
  stalled: () => void,
  ms: number = STREAM_STALL_MS,
): () => void {
  const timer = setTimeout(() => {
    if (source.readyState === CONNECTING) stalled();
  }, ms);
  return () => clearTimeout(timer);
}
