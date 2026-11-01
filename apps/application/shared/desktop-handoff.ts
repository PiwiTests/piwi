/**
 * Which dashboard links the desktop app takes over from the system browser.
 *
 * In the desktop build the bundled server serves the dashboard to the app's own
 * window only: a browser tab has no access token, so every API call it makes is
 * refused. When the user opens a dashboard link outside the app (a `View run:`
 * URL clicked in a terminal, a bookmark), the server forwards the page to the
 * app window instead (`server/middleware/desktop-handoff.ts`), and the window
 * navigates to it (`app/plugins/desktop-open-page.client.ts`).
 */

/** Whether `text` holds an ASCII control character (a tab, a line break, DEL…). */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Path prefixes that are never dashboard pages: the API, and `/_…` build assets and desktop routes. */
const NON_PAGE_PREFIXES = ['/api/', '/_'];

/**
 * The app-relative URL (path and query) the app window should show for the
 * request URL `url`, or `null` when `url` is not a dashboard page. Only a path
 * on this origin passes: a protocol-relative `//host`, a backslash and a control
 * character (which a browser drops from a URL, so `/<tab>/host` reads as
 * `//host`) are refused, so the result can never send the window to another site.
 */
export function desktopPagePath(url: string): string | null {
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\') || hasControlCharacter(url)) return null;
  const withoutHash = url.split('#', 1)[0]!;
  const pathname = withoutHash.split('?', 1)[0]!;
  if (NON_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;
  // A dot in the last segment is a static file (`/logo.svg`, `/favicon.ico`).
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return null;
  return withoutHash;
}

/**
 * Where the session bootstrap (`/__piwi/session`) sends the window once it is signed in: the page its `to` names,
 * which the shell passes for a `piwi://open/…` link that launched the app, or the home page.
 */
export function desktopSessionTarget(to: unknown): string {
  return (typeof to === 'string' && desktopPagePath(to)) || '/';
}
