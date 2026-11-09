/**
 * The window's session bootstrap, framework-neutral: the shell sends the window to `/__piwi/session` once at startup
 * with the access token on the query string, and the host answers with the `piwi_token` cookie and a redirect to the
 * page the window shows. A host adapts the answer to its framework (the desktop app's Nitro route,
 * `./run-target-http.ts`); the token check and the page the redirect names are decided here, so every host answers
 * the same.
 */
import { desktopSessionTarget } from './desktop-page';
import { isAccessToken, TOKEN_COOKIE } from './host-guard';

/** The path of the session bootstrap. */
export const SESSION_PATH = '/__piwi/session';

/** How long the window keeps its session cookie, in seconds. */
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 365;

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
 * Answer the session route. `query` is the parsed query string (`token`, and `to` for the page to show), `token` the
 * access token of the host: 404 without one, as the route does not exist on a server that has none, 403 for a token
 * that differs or is sent more than once, 400 for a page that is not printable ASCII, which a `Location` header cannot
 * hold.
 */
export function answerSession(
  query: Readonly<Record<string, unknown>>,
  token: string | null | undefined,
): SessionAnswer {
  if (!token) return { status: 404, message: 'Not found' };
  const provided = query.token;
  if (typeof provided !== 'string' || !isAccessToken(provided, token)) {
    return { status: 403, message: 'Invalid desktop token' };
  }
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
