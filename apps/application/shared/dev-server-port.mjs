/**
 * The port the dashboard's dev server listens on (`npm run app:dev`,
 * `app:dev:bg`), and the one the E2E suite's own server takes
 * (`playwright.config.ts`). It stays off 3000, the port of the desktop app and
 * of the production server, so a dev server runs beside an installed desktop
 * app. `nuxt dev` takes it strictly: a busy port is an error, never another
 * port. `PORT=<port> npm run app:dev` or `npm run app:dev:bg -- <port>` picks
 * another one for one run. Plain JS, so the scripts that run under plain Node
 * read the same value as the Nuxt and Playwright configs.
 * 7494 spells PIWI on a phone keypad.
 */
export const DEV_SERVER_PORT = 7494;
