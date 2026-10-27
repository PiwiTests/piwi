#!/usr/bin/env node
/**
 * Captures the demo's attachment screenshots — real PNGs of the fake
 * app-under-test pages in `demo-pages.mjs`, not the Piwi dashboard itself.
 *
 * Each output corresponds to one seeded failure story's evidence (or one of
 * its passing sibling executions) in `shared/demo/failure-stories.mjs`.
 * Screenshots are captured against a throwaway local HTTP server — no dev
 * server, no seeded dev DB required.
 *
 * Usage (from application/):
 *   node scripts/take-demo-screenshots.mjs
 *
 * Output: public/demo/screenshots/*.png  (committed to repo)
 */

import { createRequire } from 'module';
import { createServer } from 'http';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  checkoutFormPage,
  cartSummaryPage,
  buttonGalleryPage,
  modalPage,
  mobileNavPage,
  mobileFormsPage,
  adminReportsPage,
  adminUsersPage,
  loginPage,
} from './demo-pages.mjs';
import { resolveChromium } from './lib/dev-server.mjs';

const require = createRequire(import.meta.url);
const pw = require('playwright');
const chromium = pw.chromium;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../public/demo/screenshots');

/** Each shot: output filename, page route, viewport, colorScheme, optional post-load action. */
const SHOTS = [
  {
    file: 'checkout-form-filled.png',
    route: '/checkout',
    page: () => checkoutFormPage(),
    viewport: { width: 460, height: 620 },
  },
  {
    file: 'checkout-order-confirmed.png',
    route: '/checkout',
    page: () => checkoutFormPage({ confirmed: true }),
    viewport: { width: 460, height: 620 },
  },
  {
    file: 'checkout-error-banner.png',
    route: '/checkout',
    page: () => checkoutFormPage({ pending: true }),
    extraRoutes: { '/api/quote': () => new Promise(() => {}) },
    viewport: { width: 460, height: 620 },
  },
  {
    file: 'checkout-contact-restructured.png',
    route: '/checkout',
    page: () => checkoutFormPage({ contactRestructured: true }),
    viewport: { width: 460, height: 700 },
  },
  { file: 'cart-summary.png', route: '/cart', page: () => cartSummaryPage(), viewport: { width: 460, height: 400 } },
  {
    file: 'button-gallery-strict.png',
    route: '/components/button',
    page: () => buttonGalleryPage(),
    viewport: { width: 640, height: 240 },
  },
  {
    file: 'components-modal-stuck.png',
    route: '/components/modal',
    page: () => modalPage(),
    viewport: { width: 640, height: 300 },
  },
  { file: 'mobile-nav-loading.png', route: '/', page: () => mobileNavPage(), viewport: { width: 390, height: 664 } },
  {
    file: 'mobile-form-keyboard.png',
    route: '/checkout',
    page: () => mobileFormsPage(),
    viewport: { width: 390, height: 664 },
  },
  {
    file: 'admin-dark-dashboard.png',
    route: '/reports/monthly',
    page: () => adminReportsPage({ dark: true }),
    viewport: { width: 720, height: 420 },
    colorScheme: 'dark',
  },
  {
    file: 'admin-users-table.png',
    route: '/users',
    page: () => adminUsersPage({ rowCount: 51 }),
    viewport: { width: 700, height: 560 },
  },
  { file: 'login-form.png', route: '/login', page: () => loginPage(), viewport: { width: 460, height: 300 } },
];

function startServer(routes) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const handler = routes[req.url];
      if (!handler) {
        res.writeHead(404);
        res.end();
        return;
      }
      const result = await handler();
      if (typeof result === 'string') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(result);
      }
      // else: intentionally hung (e.g. a never-resolving quote fetch).
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.PIWI_DEMO_CHROMIUM || resolveChromium(),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  for (const shot of SHOTS) {
    const routes = { [shot.route]: shot.page, ...shot.extraRoutes };
    const server = await startServer(routes);
    const { port } = server.address();

    const context = await browser.newContext({ viewport: shot.viewport, colorScheme: shot.colorScheme });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}${shot.route}`);
    // Let the layout settle (and, for the pending-quote shot, let the hung
    // fetch actually be in flight) before capturing.
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(OUT_DIR, shot.file) });
    await context.close();
    server.close();
    console.log(`-> ${shot.file}`);
  }

  await browser.close();
  console.log('All done! Screenshots written to public/demo/screenshots/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
