/**
 * The routes of a desktop shell's run hub (`./shell-runs.ts`), framework-neutral: the run channel the shell reads, the
 * window's stream and commands, and the runs' picks. The dashboard's desktop build calls them from its Nitro routes,
 * behind its guard; Piwi Runner's host serves them on `node:http` (`serveShellRuns` in `./shell-runs-http.ts`), behind
 * the same access token. Each answer is the status and the body the route sends.
 */
import { parseSendPayload } from '@piwitests/core/editor-send';
import type { HubAnswer } from '@piwitests/core/run-hub';
import { isBrowserRequest, type HostRequest } from './host-guard';
import type { DesktopRunSink, ShellRuns } from './shell-runs';
import {
  DESKTOP_PICKS_PATH,
  DESKTOP_RUN_CHANNEL_PATH,
  DESKTOP_RUN_COMMANDS_PATH,
  DESKTOP_RUN_EVENTS_PATH,
  DESKTOP_RUN_STARTED_PATH,
} from './shell-run-events';

/** A route's answer: its status and its JSON body. */
export interface ShellRunsAnswer {
  status: number;
  body: unknown;
}

/** The route of the shell's run hub a request names, or null for any other. */
type ShellRunsRoute = 'run-channel' | 'events' | 'commands' | 'picks' | 'started';

/** The route of `method` and `pathname`, or null. */
export function matchShellRunsRoute(method: string, pathname: string): ShellRunsRoute | null {
  if (method === 'GET' && pathname === DESKTOP_RUN_CHANNEL_PATH) return 'run-channel';
  if (method === 'GET' && pathname === DESKTOP_RUN_EVENTS_PATH) return 'events';
  if (method === 'POST' && pathname === DESKTOP_RUN_COMMANDS_PATH) return 'commands';
  if (method === 'POST' && pathname === DESKTOP_PICKS_PATH) return 'picks';
  if (method === 'POST' && pathname === DESKTOP_RUN_STARTED_PATH) return 'started';
  return null;
}

const NOT_LISTENING: ShellRunsAnswer = { status: 503, body: { message: 'The runs’ hub is not listening' } };

/**
 * `GET DESKTOP_RUN_CHANNEL_PATH`: the run channel the shell names in each run it starts (`PIWI_RUN_CHANNEL`), where
 * the runs' picks go (`PIWI_EDITOR_SEND`, on the host's `port`) and the hub (`{ url, token }`), each null while it does
 * not listen. Refused (403) to a request a browser sends: the shell alone asks, so the channel's token never reaches a
 * page or an extension.
 */
export function answerRunChannel(
  runs: ShellRuns | null,
  request: Pick<HostRequest, 'headers'>,
  port: number | string,
): ShellRunsAnswer {
  if (isBrowserRequest(request)) {
    return { status: 403, body: { message: 'The desktop shell alone reads the run channel' } };
  }
  const hub = runs?.live()[0];
  return {
    status: 200,
    body: {
      runChannel: runs?.runChannel ?? null,
      picks: runs?.picksAddress(port) ?? null,
      hub: hub ? { url: hub.url, token: hub.token } : null,
    },
  };
}

/**
 * `POST DESKTOP_RUN_STARTED_PATH`: the shell started its run `ref` (`desktop-<id>`) with Playwright's `args`, which the
 * hub names as the run's command (`ShellRuns.started`). Refused (403) to a request a browser sends, as the shell alone
 * says it; 400 for another ref or arguments that are no list of words; 503 while the hub does not listen.
 */
export function answerRunStarted(
  runs: ShellRuns | null,
  request: Pick<HostRequest, 'headers'>,
  body: unknown,
): ShellRunsAnswer {
  if (isBrowserRequest(request)) {
    return { status: 403, body: { message: 'The desktop shell alone says what a run runs' } };
  }
  if (!runs) return NOT_LISTENING;
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const refused = runs.started(value.ref, value.args);
  if (refused) return { status: 400, body: { message: refused } };
  return { status: 200, body: { ok: true } };
}

/**
 * `POST DESKTOP_RUN_COMMANDS_PATH`: a window's command, answered as the hub answers it. 404 for a stream that is not
 * open, 400 for a body that is no command, 503 while the hub does not listen.
 */
export async function answerRunCommand(runs: ShellRuns | null, body: unknown): Promise<ShellRunsAnswer> {
  if (!runs) return NOT_LISTENING;
  const answer: HubAnswer | null = await runs.command(body);
  if (!answer) return { status: 404, body: { message: 'The run stream is not open' } };
  if (answer.id === 0) return { status: 400, body: { message: answer.message } };
  return { status: 200, body: answer };
}

/**
 * `POST DESKTOP_PICKS_PATH`: a locator a test of a run picked, in Send to editor's body (`{ kind: "locator", text,
 * at? }`), which every window hears, to copy. 400 for another body, 503 while the hub does not listen.
 */
export function answerRunPick(runs: ShellRuns | null, body: unknown): ShellRunsAnswer {
  if (!runs) return NOT_LISTENING;
  const payload = parseSendPayload(body);
  if ('error' in payload) return { status: 400, body: { message: payload.error } };
  if (payload.kind !== 'locator') {
    return { status: 400, body: { message: 'The runs’ hub takes a picked locator alone' } };
  }
  runs.picked({ locator: payload.text, file: payload.at?.file ?? null, line: payload.at?.line ?? null });
  return { status: 200, body: { ok: true } };
}

/**
 * Whether a request posts a run's pick with the picks token (`Authorization: Bearer`, compared in constant time),
 * from this machine: no `Origin`, or a loopback one. The one request that token opens.
 */
export function presentsPicksToken(
  runs: ShellRuns | null,
  request: Pick<HostRequest, 'headers'> & { method: string; pathname: string },
): boolean {
  if (!runs || request.method !== 'POST' || request.pathname !== DESKTOP_PICKS_PATH) return false;
  const presented = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!presented || !runs.isPicksToken(presented)) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const name = new URL(origin).hostname;
    return name === 'localhost' || name === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(name);
  } catch {
    return false;
  }
}

/**
 * `GET DESKTOP_RUN_EVENTS_PATH`: a window's stream opens on `sink`, which writes to the response itself so what the
 * window has not read is counted (`buffered`). Null, with the answer to send instead, while the hub does not listen or
 * holds as many streams as it takes.
 */
export async function openRunWindow(
  runs: ShellRuns | null,
  sink: DesktopRunSink,
): Promise<{ close(): void } | ShellRunsAnswer> {
  if (!runs) return NOT_LISTENING;
  const opened = await runs.openWindow(sink);
  if (opened) return opened;
  return { status: 503, body: { message: 'The runs’ hub is not listening, or holds 16 window streams' } };
}

/** The sentence of a refusal's body. */
export function messageOf(answer: ShellRunsAnswer): string {
  const body = answer.body as { message?: unknown } | null;
  return typeof body?.message === 'string' ? body.message : 'The route failed';
}
