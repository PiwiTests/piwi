/**
 * The run-target routes (`./run-target-routes.ts`), the window's session (`./run-target-session.ts`) and the two event
 * streams (`./run-target-stream.ts`) on a bare `node:http` server: the guard takes the access token
 * (`./host-guard.ts`), then the route answers. The desktop app's server serves the same routes through Nitro.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cookiesOf, headersOf, presentsToken } from './host-guard';
import {
  answerRunTargetRoute,
  matchRunTargetRoute,
  pathnameOf,
  refuseRunTargetRequest,
  sendsBody,
} from './run-target-routes';
import { answerSession, queryOf, SESSION_PATH, sessionCookieHeader } from './run-target-session';
import { limitedSend, matchStream, openShellStream, openWindowStream, type StreamSink } from './run-target-stream';

/** Every how many milliseconds an open stream gets a comment, so a gone reader is noticed. */
const HEARTBEAT_MS = 15_000;

/** The largest body a run-target route reads, in bytes. */
export const MAX_RUN_TARGET_BODY = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown, noStore = false): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(noStore ? { 'Cache-Control': 'no-store' } : {}),
  });
  res.end(JSON.stringify(body));
}

/**
 * The JSON a request's body holds, read from its `chunks` as they arrive: null for none or one that is not JSON;
 * `false` past `maxBytes`, reading no further.
 */
export async function readJsonBody(
  chunks: AsyncIterable<Uint8Array>,
  maxBytes = MAX_RUN_TARGET_BODY,
): Promise<unknown> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    if (size > maxBytes) return false;
    parts.push(chunk);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** The session route: the cookie and the redirect for the token on the query string, else a refusal. */
function serveSession(req: IncomingMessage, res: ServerResponse, token: string): void {
  req.resume();
  const answer = answerSession(queryOf(req.url ?? '/'), token);
  if (answer.status !== 302) {
    send(res, answer.status, { message: answer.message });
    return;
  }
  res.writeHead(302, { Location: answer.location, 'Set-Cookie': sessionCookieHeader(answer.cookie) });
  res.end();
}

/**
 * An event stream written straight to the response, so the unread data can be counted (`limitedSend`): `open` takes
 * the stream's `send` and returns what ends it, called once when the reader leaves.
 */
function serveStream<T>(
  req: IncomingMessage,
  res: ServerResponse,
  open: (send: (message: T) => void) => () => void,
): void {
  req.resume();
  let gone = false;
  let stop: (() => void) | null = null;
  const leave = () => {
    if (gone) return;
    gone = true;
    clearInterval(heartbeat);
    stop?.();
  };
  const heartbeat = setInterval(() => {
    if (!gone) res.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  req.on('error', leave);
  res.on('close', leave);
  res.on('error', leave);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // A stream with nothing to say yet still opens for its reader.
  res.flushHeaders();
  const sink: StreamSink = {
    send: (message) => {
      if (!gone) res.write(`data: ${JSON.stringify(message)}\n\n`);
    },
    buffered: () => res.writableLength,
    onDrain: (listener) => void res.on('drain', listener),
    close: () => {
      // What a reader left unread would never be read: its stream is cut; one that read everything is ended.
      if (res.writableLength > 0) res.destroy();
      else res.end();
      leave();
    },
  };
  stop = open(limitedSend<T>(sink));
  if (gone) stop();
}

/**
 * Answer `req` when it names a run-target route, the window's session or an event stream, with the access token
 * `token`: 401 without it, except on the session route, which takes the token on its query string. Answers false,
 * having written nothing, for any other path, for the host to answer. Never rejects.
 */
export async function serveRunTarget(req: IncomingMessage, res: ServerResponse, token: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';
  if (method === 'GET' && pathnameOf(url) === SESSION_PATH) {
    serveSession(req, res, token);
    return true;
  }
  const stream = matchStream(method, url);
  const route = stream ? null : matchRunTargetRoute(method, url);
  if (!stream && !route) return false;
  const headers = headersOf(req.headers);
  const guarded = { headers, cookies: cookiesOf(headers.cookie) };
  if (!presentsToken(guarded, token)) {
    req.resume();
    send(res, 401, { message: 'Desktop access token required' });
    return true;
  }
  if (stream) {
    if (stream === 'window') serveStream(req, res, openWindowStream);
    else serveStream(req, res, openShellStream);
    return true;
  }
  if (!route) return false;
  // A refusal comes before the body is read; what the request sent is discarded, so the next request on the
  // connection reads from its start.
  const refusal = refuseRunTargetRequest(route.name, { ...guarded, id: route.id });
  if (refusal) {
    req.resume();
    send(res, refusal.status, refusal.body, refusal.noStore);
    return true;
  }
  const readsBody = sendsBody(method);
  if (!readsBody) req.resume();
  try {
    const body = readsBody ? await readJsonBody(req) : null;
    if (body === false) {
      req.resume();
      send(res, 413, { message: 'The body is too large' });
      return true;
    }
    const answer = await answerRunTargetRoute(route.name, { ...guarded, id: route.id, body });
    send(res, answer.status, answer.body, answer.noStore);
  } catch {
    // A client gone mid-body leaves nothing to answer; anything else answers 500.
    if (req.destroyed || res.headersSent) res.destroy();
    else send(res, 500, { message: 'The route failed' });
  }
  return true;
}
