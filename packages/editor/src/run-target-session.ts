/**
 * The window's session bootstrap, framework-neutral: the shell sends the window to `/__piwi/session` with a session
 * code on the query string, and the host answers with the `piwi_token` cookie and a redirect to the page the window
 * shows. The code is single-use and short-lived: the shell asks for one over its proven connection
 * (`POST /api/desktop/run-target/session-code`), so the access token is never in a URL. A host adapts the answer to its
 * framework (the desktop app's Nitro route, `./run-target-http.ts`); the code check and the page the redirect names are
 * decided here, so every host answers the same.
 */
import { randomBytes } from 'node:crypto';
import { desktopSessionTarget } from './desktop-page';
import { TOKEN_COOKIE } from './host-guard';

/** The path of the session bootstrap. */
export const SESSION_PATH = '/__piwi/session';

/** How long the window keeps its session cookie, in seconds. */
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 365;

/** How long a session code can be used after it was given, in milliseconds. */
export const SESSION_CODE_TTL_MS = 30_000;

/** How many codes can wait to be used; a new one past this drops the oldest. */
const MAX_SESSION_CODES = 8;

/** The codes given and not yet used, each with the time it expires. */
const sessionCodes = new Map<string, number>();

/** Give a session code: `pds_` and 64 hex digits, good once, until `SESSION_CODE_TTL_MS` has passed. */
export function mintSessionCode(now = Date.now()): string {
  for (const [code, expires] of sessionCodes) if (expires <= now) sessionCodes.delete(code);
  while (sessionCodes.size >= MAX_SESSION_CODES) sessionCodes.delete(sessionCodes.keys().next().value!);
  const code = `pds_${randomBytes(32).toString('hex')}`;
  sessionCodes.set(code, now + SESSION_CODE_TTL_MS);
  return code;
}

/** Use a session code: true once for a code that was given and has not expired, false for any other. */
export function takeSessionCode(code: unknown, now = Date.now()): boolean {
  if (typeof code !== 'string') return false;
  const expires = sessionCodes.get(code);
  sessionCodes.delete(code);
  return expires !== undefined && expires > now;
}

/** What a `Location` header holds without being encoded. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** The cookie that holds the access token for the window. */
export interface SessionCookie {
  name: string;
  value: string;
  options: { httpOnly: true; sameSite: 'lax'; path: '/'; maxAge: number };
}

/** The session route's answer: a refusal, or the cookie and the page to show. */
export type SessionAnswer =
  | { status: 400 | 403 | 404; message: string }
  | { status: 302; location: string; cookie: SessionCookie };

/**
 * Answer the session route. `query` is the parsed query string (`code`, and `to` for the page to show), `token` the
 * access token of the host: 404 without one, as the route does not exist on a server that has none, 403 for a code
 * that was not given, was used, has expired or is sent more than once (the access token itself opens nothing here),
 * 400 for a page that is not printable ASCII, which a `Location` header cannot hold.
 */
export function answerSession(
  query: Readonly<Record<string, unknown>>,
  token: string | null | undefined,
  now = Date.now(),
): SessionAnswer {
  if (!token) return { status: 404, message: 'Not found' };
  if (!takeSessionCode(query.code, now)) return { status: 403, message: 'Invalid session code' };
  const location = desktopSessionTarget(query.to);
  if (!PRINTABLE_ASCII.test(location)) return { status: 400, message: 'Invalid page' };
  return {
    status: 302,
    location,
    cookie: {
      name: TOKEN_COOKIE,
      value: token,
      options: { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE_S },
    },
  };
}

/** The query string of a request URL by name; a name sent more than once is a list. */
export function queryOf(url: string): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [name, value] of new URL(url, 'http://localhost').searchParams) {
    const kept = query[name];
    if (kept === undefined) query[name] = value;
    else query[name] = Array.isArray(kept) ? [...kept, value] : [kept, value];
  }
  return query;
}

/** The `Set-Cookie` header value of a session cookie. */
export function sessionCookieHeader(cookie: SessionCookie): string {
  const { maxAge, path } = cookie.options;
  return `${cookie.name}=${encodeURIComponent(cookie.value)}; Max-Age=${maxAge}; Path=${path}; HttpOnly; SameSite=Lax`;
}
