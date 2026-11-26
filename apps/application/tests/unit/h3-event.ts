import { H3Event } from 'nitro/h3';

export interface TestEventInit {
  method?: string;
  /** A path, or a whole URL; `http://localhost` is its origin when it names none. */
  url?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Aborts as the client leaves. */
  signal?: AbortSignal;
  /** The peer's address, which Nitro's Node server reads from the connection's socket. */
  ip?: string;
  /** The Node request and response, which Nitro's Node server hands to the routes that write to them. */
  node?: { req?: unknown; res?: unknown };
  context?: Record<string, unknown>;
}

/** An h3 v2 event as Nitro's Node server hands one to a route: a web request, its peer and its Node objects. */
export function testEvent(init: TestEventInit = {}): H3Event {
  const request = new Request(new URL(init.url ?? '/', 'http://localhost'), {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.headers,
    body: init.body as BodyInit | undefined,
    signal: init.signal,
  });
  if (init.ip !== undefined) Object.defineProperty(request, 'ip', { value: init.ip });
  if (init.node) {
    const node = { req: { headers: init.headers ?? {}, socket: { remoteAddress: init.ip } }, ...init.node };
    Object.defineProperty(request, 'runtime', { value: { name: 'node', node } });
  }
  return new H3Event(request, init.context ? { ...init.context } : undefined);
}
