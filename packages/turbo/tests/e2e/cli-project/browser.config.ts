import { defineConfig } from '@playwright/test';

// The early browser's project, run through `piwi-turbo` by `cli.spec.ts`. CLI_PROJECT_TZ is a time zone the config
// gives its workers.
if (process.env.CLI_PROJECT_TZ) process.env.TZ = process.env.CLI_PROJECT_TZ;

export default defineConfig({
  testDir: '.',
  testMatch: 'browser.check.ts',
  outputDir: process.env.CLI_PROJECT_OUTPUT,
  reporter: 'line',
  workers: 1,
});
