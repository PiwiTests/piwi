/**
 * Desktop build: hand a dashboard link opened in the system browser over to the
 * app window (see `server/middleware/desktop-handoff.ts`).
 *
 * Each open app window listens on the desktop event stream
 * (`/api/desktop/events`), which registers it here; `requestDesktopOpen`
 * forwards a page to every listener.
 */

import { createHash } from 'node:crypto';

type OpenPageListener = (path: string) => void;

const openPageListeners = new Set<OpenPageListener>();

/** Receive every page forwarded to the app window; returns the unsubscribe function. */
export function subscribeDesktopOpenRequests(listener: OpenPageListener): () => void {
  openPageListeners.add(listener);
  return () => {
    openPageListeners.delete(listener);
  };
}

/** Forward `path` to the app window. False when no window is listening. */
export function requestDesktopOpen(path: string): boolean {
  for (const listener of openPageListeners) listener(path);
  return openPageListeners.size > 0;
}

/** The request headers `isOutsideNavigation` reads. */
export interface NavigationHeaders {
  method: string;
  secFetchSite: string | undefined;
  secFetchMode: string | undefined;
  secFetchDest: string | undefined;
  /** `Sec-Purpose` (or the older `Purpose`) — set when the browser prefetches or prerenders a page. */
  purpose: string | undefined;
}

/**
 * Whether the request is a browser tab loading a page that no web page asked
 * for: a link opened from a terminal or another app, a bookmark, the address
 * bar. Browsers send `Sec-Fetch-Site: none` only for those, so a site the user
 * visits (a link, a redirect, a script) can never drive the app window. A
 * prefetch or prerender (Chrome may prerender a URL while it is typed in the
 * address bar) is not the user opening the page.
 */
export function isOutsideNavigation(headers: NavigationHeaders): boolean {
  return (
    headers.method === 'GET' &&
    headers.secFetchSite === 'none' &&
    headers.secFetchMode === 'navigate' &&
    headers.secFetchDest === 'document' &&
    !headers.purpose
  );
}

/**
 * The script the notice runs once the page was forwarded: it closes the tab.
 * Browsers let a page close a tab that holds no other page, which is the case
 * for a link opened from a terminal or another app; any other tab keeps the
 * notice.
 */
const CLOSE_TAB_SCRIPT = 'window.close();';

/** The notice's Content-Security-Policy: its own images and styles, and no script but `CLOSE_TAB_SCRIPT`. */
export const DESKTOP_HANDOFF_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${createHash('sha256').update(CLOSE_TAB_SCRIPT).digest('base64')}'`,
  "base-uri 'none'",
].join('; ');

/** The notice the browser tab shows once the page was forwarded (`shown`) or when no app window listens. */
export function renderDesktopHandoffPage(shown: boolean): string {
  const heading = shown ? 'Opened in Piwi Dashboard' : 'Open this page in Piwi Dashboard';
  const body = shown
    ? 'The page is now showing in the desktop app. You can close this tab.'
    : 'This dashboard runs in the Piwi Dashboard desktop app, but its window is not ready yet. Open it from the tray icon, then open the link again.';
  const closeTab = shown ? `\n<script>${CLOSE_TAB_SCRIPT}</script>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --text: #111827; --muted: #4b5563; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f172a; --text: #f3f4f6; --muted: #9ca3af; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 28rem; padding: 0 16px; text-align: center; }
  img { width: 48px; height: 48px; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 16px 0 8px; }
  p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main data-desktop-handoff="${shown ? 'shown' : 'not-ready'}">
<img src="/logo.svg" alt="">
<h1>${heading}</h1>
<p>${body}</p>
</main>${closeTab}
</body>
</html>
`;
}
