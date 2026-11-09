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

export { desktopPagePath, desktopSessionTarget } from '@piwitests/editor/desktop-page';
