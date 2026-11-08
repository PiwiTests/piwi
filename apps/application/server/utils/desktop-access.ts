import { randomBytes } from 'node:crypto';
import { setResponseHeader, type H3Event } from 'h3';
import {
  challengeAnswer,
  cookiesOf,
  headersOf,
  isBrowserRequest as isHostBrowserRequest,
  presentsToken,
  type HostRequest,
} from '@piwitests/editor/host-guard';
import { DESKTOP_PICKS_PATH } from '#shared/desktop-runs';
import { timingSafeEqualStr } from './timing-safe';
import { bearerToken } from './bearer';
import { isLoopbackRequest } from './assistant/turn-token';

/**
 * Whether the request presents the desktop access token `token` (`presentsToken` of `@piwitests/editor/host-guard`,
 * which every host of the shell's routes decides with): the `piwi_token` cookie the app window obtains via
 * `/__piwi/session`, an `x-piwi-token` header, an `Authorization: Bearer` header (the Playwright reporter) or an
 * `X-API-Key` header (the `piwi` commands).
 */
export function presentsDesktopToken(event: H3Event, token: string): boolean {
  return presentsToken(hostRequestOf(event), token);
}

let picksToken: string | null = null;

/**
 * The token the Playwright runs the desktop shell starts post the locators their tests pick with: the token of the
 * address the run channel's route names (`PIWI_EDITOR_SEND`), minted once per server start, the first time it is
 * asked for. It opens `POST /api/desktop/runs/picks` alone (`presentsDesktopPicksToken`), so a run's environment (its
 * tests, its `webServer`, the logs and crash reports they write) never holds the desktop token.
 */
export function desktopPicksToken(): string {
  picksToken ??= `pdp_${randomBytes(32).toString('hex')}`;
  return picksToken;
}

/**
 * Whether a request posts a run's pick with the picks token, from this machine (a loopback host, origin and peer): the
 * one request that token opens, which the desktop guard lets through without the desktop token.
 */
export function presentsDesktopPicksToken(event: H3Event): boolean {
  if (!picksToken || event.method !== 'POST' || (event.path || '').split('?')[0] !== DESKTOP_PICKS_PATH) return false;
  const presented = bearerToken(event);
  return !!presented && timingSafeEqualStr(presented, picksToken) && isLoopbackRequest(event);
}

/**
 * The routes the desktop guard leaves open, without the token: the readiness
 * probe the shell polls before the window has a cookie, and Piwi Picker's
 * pairing start and poll, which it sends before it holds the token. Each of
 * the two checks for itself who may ask (`shared/desktop-pairing.ts`).
 */
export function isOpenDesktopRoute(method: string, path: string): boolean {
  const pathname = path.split('?')[0]!;
  if (pathname === '/api/health') return true;
  if (method === 'POST' && pathname === '/api/desktop/picker-pairings') return true;
  return method === 'GET' && /^\/api\/desktop\/picker-pairings\/[0-9a-f]{16}$/.test(pathname);
}

/**
 * Answers a challenge on `/api/health` with the proof that this server holds the desktop token, for the loopback port
 * the request reached (`challengeAnswer` of `@piwitests/editor/host-guard`): the desktop shell and Piwi Picker send the
 * token only to the app that proves it. Does nothing outside the desktop app or without a challenge.
 */
export async function answerDesktopChallenge(
  event: H3Event,
  token: string | undefined = process.env.PIWI_DESKTOP_TOKEN,
): Promise<void> {
  const headers = headersOf(event.node.req.headers);
  for (const [name, value] of Object.entries(await challengeAnswer(headers, token, event.node.req.socket?.localPort))) {
    setResponseHeader(event, name, value);
  }
}

/**
 * Whether a browser sent the request: it carries `Origin` or a `Sec-Fetch-*` header, which a browser sets itself on a
 * page's or an extension's request, and which the desktop shell's own requests never carry (`isBrowserRequest` of
 * `@piwitests/editor/host-guard`).
 */
export function isBrowserRequest(event: H3Event): boolean {
  return isHostBrowserRequest({ headers: headersOf(event.node.req.headers) });
}

/** What the shared guard reads of a request: its headers and cookies. */
function hostRequestOf(event: H3Event): HostRequest {
  const headers = headersOf(event.node.req.headers);
  return { headers, cookies: cookiesOf(headers.cookie) };
}
