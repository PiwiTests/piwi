/**
 * The headers of every response the dashboard writes as it goes and a client reads as it arrives (an event stream, the
 * live view's stream): no cache and no transformation on the way, and `X-Accel-Buffering: no`, which tells an nginx in
 * front to pass the body on as it comes even where its configuration buffers responses (`proxy_buffering on`, its
 * default). nginx reads that header and keeps it from the client by default.
 */
export function streamHeaders<T extends string>(contentType: T) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  } as const;
}
