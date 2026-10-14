import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import type { PiwiDashboardOptions } from '@piwitests/reporter';
import { BASE_URL, PORT, backend } from './backends';

// The dashboard's address, its API key and the shopper's password, when `.env` sets them.
if (existsSync('.env')) process.loadEnvFile('.env');

/**
 * Where the reporter sends results, and what it records beyond its defaults. Each backend reports to its own project,
 * `sample-app-<backend>`; override the address and the project with PIWI_DASHBOARD_URL / PIWI_PROJECT_NAME.
 *
 * On by default, and kept on here: the capture fixtures' network, console, Web Vitals, locators and page state, the
 * backend logs and server traces the integration sends, the resource ledger and the run's CPU, memory and disk (the
 * Resources tab), the ARIA snapshot of passing tests, and the app's declared surface (`piwi.manifest.json` and the
 * integration's route manifest).
 */
export const piwiOptions: PiwiDashboardOptions = {
  serverUrl: process.env.PIWI_DASHBOARD_URL ?? 'http://localhost:3000',
  projectName: process.env.PIWI_PROJECT_NAME ?? `sample-app-${backend.name}`,
  // The controls and links each page shows on passing runs: the dashboard names the ones no test uses.
  capturePageInventory: true,
  // A browser, context or page a test opens and leaves open is listed with the line that opened it.
  leakCheck: 'report',
  // The browser files each test runs, and, from a backend with a coverage build, the server lines. The pages load
  // their scripts from /assets/*, which are the files under web/.
  coverage: { browser: 'files', server: backend.features.serverCoverage ? 'lines' : 'off' },
  codeReachRoots: ['web'],
};

/**
 * Piwi's section of the config: how the code a recording writes looks, for everyone recording in this folder. The
 * editor extensions read it through Playwright. Here: a `test.step` per page in a test, and a new test tagged
 * `@recorded` and owned by the shop team. Written apart and spread into the config, so the config type-checks with
 * reporter versions that do not declare `'@piwi'` on Playwright's config yet.
 */
const piwiSection = {
  '@piwi': {
    codegen: {
      testSteps: 'page' as const,
      tags: ['@recorded'],
      annotations: [{ type: 'piwi:owner', description: '@shop-team' }],
    },
  },
};

/** The config both reporter wirings share: the suite, the browser options, and the backend it starts. */
export const baseConfig = defineConfig({
  ...piwiSection,
  testDir: './tests',
  fullyParallel: true,
  use: {
    baseURL: BASE_URL,
    // A failing test keeps its video beside the screenshot and the trace the reporter's defaults keep.
    video: 'retain-on-failure',
  },
  webServer: {
    command: backend.command,
    cwd: backend.cwd,
    env: backend.env,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: backend.startTimeout,
  },
});
