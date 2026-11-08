import { answerSession } from '@piwitests/editor/run-target-session';

// Desktop (Tauri) bootstrap endpoint.
//
// The shell navigates the webview here exactly once at startup, exchanging the
// desktop token (passed on the query string) for an httpOnly cookie. Every
// subsequent request — the SSR HTML load, its internal /api fetches, and the
// notification/live-run EventSource streams — then carries the cookie and is
// authorized by server/middleware/desktop-guard.ts. It then shows the page
// `to` names (a `piwi://open/…` link that launched the app), or the home page.
// Responds 404 unless PIWI_DESKTOP_TOKEN is set, so it does not exist on the
// normal server build. The answer comes from the editor service, which serves
// the same route on its own host.
export default defineEventHandler((event) => {
  const answer = answerSession(getQuery(event), process.env.PIWI_DESKTOP_TOKEN);
  if (answer.status !== 302) {
    throw apiError({ statusCode: answer.status, statusMessage: answer.message });
  }
  setCookie(event, answer.cookie.name, answer.cookie.value, answer.cookie.options);
  return sendRedirect(event, answer.location);
});
