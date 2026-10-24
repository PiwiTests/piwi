// The extension in the real VS Code, nightly (`.github/workflows/nightly-vscode.yml`): one window for the whole suite,
// so the tests run in order, in one worker. Needs `npm run vscode:build`, and Xvfb on Linux without a display.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'report' }]] : 'list',
  outputDir: 'results',
});
