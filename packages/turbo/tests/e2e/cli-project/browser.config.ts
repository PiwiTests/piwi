import { defineConfig } from '@playwright/test';

// The early browser's project, run through `piwi-turbo` by `cli.spec.ts`. CLI_PROJECT_SET is a variable the config
// sets (`NAME=value`); with CLI_PROJECT_LAUNCH_ENV, the browser is launched with an environment of its own.
const set = process.env.CLI_PROJECT_SET;
if (set) process.env[set.slice(0, set.indexOf('='))] = set.slice(set.indexOf('=') + 1);

export default defineConfig({
  testDir: '.',
  testMatch: 'browser.check.ts',
  outputDir: process.env.CLI_PROJECT_OUTPUT,
  reporter: 'line',
  workers: 1,
  use: process.env.CLI_PROJECT_LAUNCH_ENV
    ? { launchOptions: { env: { ...process.env, CLI_PROJECT_SECRET: process.env.CLI_PROJECT_LAUNCH_ENV } } }
    : {},
});
