import { timingSafeEqualStr } from '../../utils/timing-safe';

// Desktop (Tauri) bootstrap endpoint.
//
// The shell navigates the webview here exactly once at startup, exchanging the
// per-launch token (passed on the query string) for an httpOnly cookie. Every
// subsequent request — the SSR HTML load, its internal /api fetches, and the
// notification/live-run EventSource streams — then carries the cookie and is
// authorized by server/middleware/desktop-guard.ts. Responds 404 unless
// PIWI_DESKTOP_TOKEN is set, so it does not exist on the normal server build.
export default defineEventHandler((event) => {
  const token = process.env.PIWI_DESKTOP_TOKEN;
  if (!token) {
    throw apiError({ statusCode: 404, statusMessage: 'Not found' });
  }

  const provided = getQuery(event).token;
  if (typeof provided !== 'string' || !timingSafeEqualStr(provided, token)) {
    throw apiError({ statusCode: 403, statusMessage: 'Invalid desktop token' });
  }

  setCookie(event, 'piwi_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });

  return sendRedirect(event, '/');
});
