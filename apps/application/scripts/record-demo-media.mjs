#!/usr/bin/env node
/**
 * Records the demo's committed trace archives and failure videos.
 *
 * The demo SPA has no server-side file storage, so the traces/videos shown on
 * seeded failures are real Playwright artifacts committed to the repo
 * (public/demo/traces/, public/demo/videos/). This script regenerates them
 * against the fake pages in `demo-pages.mjs`, served from a throwaway local
 * HTTP server — never a real application, since traces embed full page
 * snapshots.
 *
 * Each scenario below mirrors one seeded failure story in
 * `shared/demo/failure-stories.mjs` (same page, same interaction, same
 * failure mode), so the recorded evidence is authentic — not just realistic
 * decoration.
 *
 * Usage (from application/):
 *   node scripts/record-demo-media.mjs
 *
 * Output (committed to repo):
 *   public/demo/traces/*.zip
 *   public/demo/videos/*.webm
 */

import { createRequire } from 'module';
import { createServer } from 'http';
import { mkdirSync, copyFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { checkoutFormPage, buttonGalleryPage, adminReportsPage, mobileNavPage } from './demo-pages.mjs';
import { resolveChromium } from './lib/dev-server.mjs';

const require = createRequire(import.meta.url);
const pw = require('playwright');
const chromium = pw.chromium;

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACES_DIR = join(__dirname, '../public/demo/traces');
const VIDEOS_DIR = join(__dirname, '../public/demo/videos');
const EXECUTABLE = process.env.PIWI_DEMO_CHROMIUM || resolveChromium();

/**
 * Each scenario declares the routes its page needs (path → html, or a
 * function returning `{ status, contentType, body }` for non-200/HTML
 * responses like the hung quote fetch), a `viewport`, an optional
 * `colorScheme`, the `run(page)` interaction, and which outputs to capture.
 */
const SCENARIOS = [
  {
    name: 'checkout-pay-timeout',
    viewport: { width: 640, height: 480 },
    routes: {
      '/checkout': () => checkoutFormPage({ pending: true }),
      // Never resolves — the Pay button stays disabled, so the click below
      // genuinely times out waiting for "enabled" (real actionability check).
      '/api/quote': () => new Promise(() => {}),
    },
    async run(page, baseUrl) {
      await page.goto(`${baseUrl}/checkout`);
      await page.getByLabel('Email address').fill('buyer@example.com');
      await page
        .getByRole('button', { name: 'Confirming total…' })
        .click({ timeout: 2500 })
        .catch(() => {});
    },
    outputs: ['trace', 'video'],
  },
  {
    name: 'email-label-renamed',
    viewport: { width: 640, height: 480 },
    routes: { '/checkout': () => checkoutFormPage({ contactRestructured: true }) },
    async run(page, baseUrl) {
      await page.goto(`${baseUrl}/checkout`);
      // The label-based locator does not resolve — the field is an
      // aria-labeled input behind a "Contact method" selector.
      await page
        .getByLabel('Email address')
        .fill('buyer@example.com', { timeout: 2000 })
        .catch(() => {});
    },
    outputs: ['trace'],
  },
  {
    name: 'button-strict-mode',
    viewport: { width: 640, height: 360 },
    routes: { '/components/button': () => buttonGalleryPage() },
    async run(page, baseUrl) {
      await page.goto(`${baseUrl}/components/button`);
      // Strict mode violation — resolves to 3 elements, throws immediately.
      await page
        .getByRole('button')
        .click({ timeout: 2000 })
        .catch(() => {});
    },
    outputs: ['trace', 'video'],
  },
  {
    name: 'admin-dark-dashboard',
    viewport: { width: 720, height: 480 },
    colorScheme: 'dark',
    routes: { '/reports/monthly': () => adminReportsPage({ dark: true }) },
    async run(page, baseUrl) {
      await page.goto(`${baseUrl}/reports/monthly`);
      // The button is present but visibility:hidden under the dark theme.
      await page
        .getByRole('button', { name: 'Export CSV' })
        .waitFor({ state: 'visible', timeout: 2000 })
        .catch(() => {});
    },
    outputs: ['trace'],
  },
  {
    name: 'mobile-nav-timeout',
    viewport: { width: 390, height: 664 },
    routes: {
      '/': () => mobileNavPage({ heroImage: true }),
      // Never resolves — the "load" event can't fire until every embedded
      // resource settles, so goto() genuinely times out.
      '/hero-4k.png': () => new Promise(() => {}),
    },
    async run(page, baseUrl) {
      await page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: 2500 }).catch(() => {});
    },
    outputs: ['video'],
  },
];

/** Serve a scenario's routes on an ephemeral port. */
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
      // else: the handler's promise never resolves (simulated hang) — the
      // request just stays open, which is the point for the quote endpoint.
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function recordScenario(browser, scenario) {
  const server = await startServer(scenario.routes);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const contextOpts = { viewport: scenario.viewport, colorScheme: scenario.colorScheme };

  const outputs = [];

  if (scenario.outputs.includes('trace')) {
    const context = await browser.newContext(contextOpts);
    // sources: true embeds this script's own source under resources/src@… so the
    // demo can show the full-call-stack-with-source evidence view.
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    await scenario.run(page, baseUrl);
    const tracePath = join(TRACES_DIR, `${scenario.name}.zip`);
    await context.tracing.stop({ path: tracePath });
    await context.close();
    outputs.push(tracePath);
  }

  if (scenario.outputs.includes('video')) {
    const context = await browser.newContext({
      ...contextOpts,
      recordVideo: { dir: tmpdir(), size: scenario.viewport },
    });
    const page = await context.newPage();
    await scenario.run(page, baseUrl);
    await page.waitForTimeout(400);
    const video = page.video();
    await context.close();
    const videoPath = join(VIDEOS_DIR, `${scenario.name}.webm`);
    copyFileSync(await video.path(), videoPath);
    outputs.push(videoPath);
  }

  server.close();
  return outputs;
}

async function main() {
  mkdirSync(TRACES_DIR, { recursive: true });
  mkdirSync(VIDEOS_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  for (const scenario of SCENARIOS) {
    console.log(`Recording ${scenario.name}…`);
    const outputs = await recordScenario(browser, scenario);
    for (const file of outputs) {
      console.log(`  ${file} — ${(statSync(file).size / 1024).toFixed(1)} KB`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
