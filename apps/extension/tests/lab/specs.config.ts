import { defineConfig } from '@playwright/test';

/** The specs the lab wrote from its recordings, run by Playwright as a project would. */
export default defineConfig({
  testDir: 'out/specs',
  workers: Number(process.env.LAB_WORKERS ?? 1),
  fullyParallel: true,
  timeout: 3 * 60_000,
  expect: { timeout: 5_000 },
  reporter: [['list'], ['json', { outputFile: 'out/specs-report.json' }]],
  outputDir: 'out/specs-results',
  use: {
    channel: 'chromium',
    viewport: { width: 1400, height: 900 },
    actionTimeout: 10_000,
    navigationTimeout: 90_000,
  },
});
