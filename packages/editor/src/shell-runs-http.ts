/**
 * The routes of a desktop shell's run hub (`./shell-runs-routes.ts`) on a bare `node:http` server, as Piwi Runner's
 * host serves them: the access token opens each of them, and the picks token the picks route alone. The dashboard's
 * desktop build serves the same routes through Nitro.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cookiesOf, headersOf, presentsToken } from './host-guard';
import { readJsonBody } from './run-target-http';
import { pathnameOf } from './run-target-routes';
import type { ShellRuns } from './shell-runs';
import {
  answerRunChannel,
  answerRunCommand,
  answerRunPick,
  answerRunStarted,
  matchShellRunsRoute,
  openRunWindow,
  presentsPicksToken,
} from './shell-runs-routes';

/** Every how many milliseconds an open stream gets a comment, so a gone window is noticed. */
const HEARTBEAT_MS = 15_000;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * `GET DESKTOP_RUN_EVENTS_PATH` once the access token was checked: the window's stream, written straight to the
 * response so what it has not read is the response's own backlog (`writableLength`): past 1 MB a frame waits for it, and
 * past 32 MB the stream is cut, as the hub does with a WebSocket. The dashboard's Nitro route serves it too.
 */
export async function serveRunEvents(req: IncomingMessage, res: ServerResponse, runs: ShellRuns | null): Promise<void> {
  req.resume();
  let gone = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let window: { close(): void } | null = null;
  const start = () => {
    if (res.headersSent) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    heartbeat = setInterval(() => {
      if (!gone) res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  };
  const leave = () => {
    if (gone) return;
    gone = true;
    if (heartbeat) clearInterval(heartbeat);
    window?.close();
  };
  // The request's own `close` comes once its empty body is read: the response's tells that the window left.
  req.on('error', leave);
  res.on('close', leave);
  res.on('error', leave);
  const opened = await openRunWindow(runs, {
    send: (payload) => {
      if (gone) return;
      start();
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    buffered: () => res.writableLength,
    close: () => {
      if (gone) return;
      // What a window left unread would never be read: its stream is cut; one that read everything is ended.
      if (res.writableLength > 0) res.destroy();
      else res.end();
      leave();
    },
  });
  if ('status' in opened) {
    if (!res.headersSent) send(res, opened.status, opened.body);
    else res.end();
    return;
  }
  start();
  if (gone) opened.close();
  else window = opened;
}

/**
 * Answer `req` when it names a route of the run hub, with the access token `token` (or, on the picks route, the picks
 * token): 401 without it. `runs` is the host's hub, null while it is not open, and `port` the port the host listens
 * on. Answers false, having written nothing, for any other path. Never rejects.
 */
export async function serveShellRuns(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  runs: ShellRuns | null,
  port: number | string,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const pathname = pathnameOf(req.url ?? '/');
  const route = matchShellRunsRoute(method, pathname);
  if (!route) return false;
  const headers = headersOf(req.headers);
  const guarded = { headers, cookies: cookiesOf(headers.cookie) };
  const picks = route === 'picks' && presentsPicksToken(runs, { headers, method, pathname });
  if (!picks && !presentsToken(guarded, token)) {
    req.resume();
    send(res, 401, { message: 'Desktop access token required' });
    return true;
  }
  try {
    if (route === 'events') {
      await serveRunEvents(req, res, runs);
      return true;
    }
    if (route === 'run-channel') {
      req.resume();
      const answer = answerRunChannel(runs, guarded, port);
      send(res, answer.status, answer.body);
      return true;
    }
    const body = await readJsonBody(req);
    if (body === false) {
      req.resume();
      send(res, 413, { message: 'The body is too large' });
      return true;
    }
    const answer =
      route === 'commands'
        ? await answerRunCommand(runs, body)
        : route === 'started'
          ? answerRunStarted(runs, guarded, body)
          : answerRunPick(runs, body);
    send(res, answer.status, answer.body);
  } catch {
    // A client gone mid-body leaves nothing to answer; anything else answers 500.
    if (req.destroyed || res.headersSent) res.destroy();
    else send(res, 500, { message: 'The route failed' });
  }
  return true;
}
