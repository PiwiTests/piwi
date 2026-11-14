import { defineConfig } from '@playwright/test';

// The compatibility suite: run it before trusting the experimental hooks on a new Playwright version.
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  reporter: process.env.CI ? 'dot' : 'list',
  outputDir: '../../test-results/e2e',
  use: { browserName: 'chromium' },
});
