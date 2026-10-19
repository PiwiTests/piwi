import { getCookie, getRequestHeader, type H3Event } from 'h3';
import { timingSafeEqualStr } from './timing-safe';

/**
 * Whether the request presents the desktop access token `token`, as any of:
 *   - the `piwi_token` cookie the app window obtains via `/__piwi/session`
 *     (rides along on SSR-internal fetches and EventSource streams),
 *   - an `Authorization: Bearer <token>` header (the Playwright reporter, whose
 *     `pd_`-prefixed token goes through its API-key path),
 *   - an `X-API-Key` header (the `piwi` commands: `flake`, `probe`, `select`,
 *     which send their API key there), or
 *   - an `x-piwi-token` header.
 */
export function presentsDesktopToken(event: H3Event, token: string): boolean {
  const authz = getRequestHeader(event, 'authorization');
  const bearer = authz && authz.startsWith('Bearer ') ? authz.slice('Bearer '.length) : undefined;
  const presented =
    getCookie(event, 'piwi_token') ||
    getRequestHeader(event, 'x-piwi-token') ||
    bearer ||
    getRequestHeader(event, 'x-api-key');
  return !!presented && timingSafeEqualStr(presented, token);
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

/** The response header that answers the desktop shell's readiness probe with the launch nonce. */
export const DESKTOP_LAUNCH_NONCE_HEADER = 'X-Piwi-Desktop-Nonce';

/**
 * The per-launch nonce the desktop shell hands its sidecar in
 * `PIWI_DESKTOP_LAUNCH_NONCE`, or null outside the desktop app. `/api/health`
 * echoes it so the shell loads its session bootstrap only from the server it
 * spawned, never from another process that took the port.
 */
export function desktopLaunchNonce(env: Record<string, string | undefined> = process.env): string | null {
  return env.PIWI_DESKTOP_LAUNCH_NONCE || null;
}
