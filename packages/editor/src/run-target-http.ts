/**
 * The run-target routes (`./run-target-routes.ts`) on a bare `node:http` server: the guard takes the access token
 * (`./host-guard.ts`), then the route answers. The desktop app's server serves the same routes through Nitro.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cookiesOf, headersOf, presentsToken } from './host-guard';
import { answerRunTargetRoute, matchRunTargetRoute } from './run-target-routes';

/** The largest body a run-target route reads, in bytes. */
export const MAX_RUN_TARGET_BODY = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown, noStore = false): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(noStore ? { 'Cache-Control': 'no-store' } : {}),
  });
  res.end(JSON.stringify(body));
}

/** The JSON body of a request, null for none or one that is not JSON; `false` past `MAX_RUN_TARGET_BODY`. */
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_RUN_TARGET_BODY) return false;
    chunks.push(chunk);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Answer `req` when it names a run-target route, with the access token `token`: 401 without it. Answers false, having
 * written nothing, for any other path, for the host to answer. Never rejects.
 */
export async function serveRunTarget(req: IncomingMessage, res: ServerResponse, token: string): Promise<boolean> {
  const route = matchRunTargetRoute(req.method ?? 'GET', req.url ?? '/');
  if (!route) return false;
  const headers = headersOf(req.headers);
  const guarded = { headers, cookies: cookiesOf(headers.cookie) };
  if (!presentsToken(guarded, token)) {
    req.resume();
    send(res, 401, { message: 'Desktop access token required' });
    return true;
  }
  const readsBody = req.method !== 'GET' && req.method !== 'DELETE';
  // A body the route does not read is discarded, so the next request on the connection reads from its start.
  if (!readsBody) req.resume();
  try {
    const body = readsBody ? await jsonBody(req) : null;
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
