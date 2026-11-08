/**
 * The guard of a host the desktop shell serves its window and itself from on this machine (the desktop app's bundled
 * server): who may call it, and which callers a route refuses. It decides over a plain request shape, so every host
 * that serves the same routes decides the same way.
 */
import { sameToken } from './recorder/handoff';

/** What a host's guard and its routes read of a request. */
export interface HostRequest {
  /** The request's headers, their names in lower case. */
  headers: Readonly<Record<string, string | undefined>>;
  /** The request's cookies, by name. */
  cookies: Readonly<Record<string, string | undefined>>;
}

/** The cookie the window holds the access token in, set by the host's session route. */
export const TOKEN_COOKIE = 'piwi_token';

/** The response header that answers the shell's readiness probe with the launch nonce. */
export const LAUNCH_NONCE_HEADER = 'X-Piwi-Desktop-Nonce';

/** Node's request headers as a host reads them: a header sent more than once joined with `, `. */
export function headersOf(
  raw: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(raw)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/** The cookies of a `Cookie` header, by name; the first of a name sent twice wins. */
export function cookiesOf(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (!name || name in cookies) continue;
    let value = part.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/**
 * The access token a request presents, as any of: the `piwi_token` cookie (the window), the `x-piwi-token` header
 * (the shell), an `Authorization: Bearer` header (the Playwright reporter, whose `pd_` token goes through its API-key
 * path) or an `X-API-Key` header (the `piwi` commands). Null with none.
 */
export function presentedToken(request: HostRequest): string | null {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return (
    request.cookies[TOKEN_COOKIE] || request.headers['x-piwi-token'] || bearer || request.headers['x-api-key'] || null
  );
}

/** Whether a request presents the access token `token`, compared in constant time. */
export function presentsToken(request: HostRequest, token: string): boolean {
  const presented = presentedToken(request);
  return !!presented && sameToken(presented, token);
}

/**
 * Whether a browser sent the request: it carries `Origin` or a `Sec-Fetch-*` header, which a browser sets itself on a
 * page's or an extension's request, and which the shell's own requests never carry.
 */
export function isBrowserRequest(request: Pick<HostRequest, 'headers'>): boolean {
  return ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'].some((name) => !!request.headers[name]);
}

/**
 * The per-launch nonce the shell hands the host it starts in `PIWI_DESKTOP_LAUNCH_NONCE`, or null without one. The
 * readiness probe echoes it (`LAUNCH_NONCE_HEADER`), so the shell loads its session only from the host it started,
 * never from another process that took the port.
 */
export function launchNonce(env: Record<string, string | undefined> = process.env): string | null {
  return env.PIWI_DESKTOP_LAUNCH_NONCE || null;
}
