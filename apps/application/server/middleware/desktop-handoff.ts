// Desktop (Tauri) build: a dashboard link opened in the system browser shows in
// the app window.
//
// A browser tab has no access token, so the dashboard cannot work there. When
// the user opens a dashboard page in the browser from outside any web page (a
// link clicked in a terminal or another app, a bookmark), the page is forwarded
// to the app window, which navigates to it and comes to the front; the tab gets
// a short notice instead, and closes itself where the browser allows it. Inert
// unless PIWI_DESKTOP_TOKEN is set.
import { desktopPagePath } from '#shared/desktop-handoff';
import { presentsDesktopToken } from '../utils/desktop-access';
import {
  DESKTOP_HANDOFF_CSP,
  isOutsideNavigation,
  renderDesktopHandoffPage,
  requestDesktopOpen,
} from '../utils/desktop-handoff';

export default defineEventHandler((event) => {
  const token = process.env.PIWI_DESKTOP_TOKEN;
  if (!token) return;

  const outside = isOutsideNavigation({
    method: event.method,
    secFetchSite: getRequestHeader(event, 'sec-fetch-site'),
    secFetchMode: getRequestHeader(event, 'sec-fetch-mode'),
    secFetchDest: getRequestHeader(event, 'sec-fetch-dest'),
    purpose: getRequestHeader(event, 'sec-purpose') || getRequestHeader(event, 'purpose'),
  });
  // The app window's own requests carry the token (its cookie).
  if (!outside || presentsDesktopToken(event, token)) return;

  const path = desktopPagePath(event.path);
  if (!path) return;

  const shown = requestDesktopOpen(path);
  setResponseHeaders(event, {
    'Content-Type': 'text/html; charset=utf-8',
    // Never cached: every click on the link must reach the server again.
    'Cache-Control': 'no-store',
    'Content-Security-Policy': DESKTOP_HANDOFF_CSP,
  });
  return renderDesktopHandoffPage(shown);
});
