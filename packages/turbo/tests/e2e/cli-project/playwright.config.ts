import { defineConfig } from '@playwright/test';

// The project `cli.spec.ts` runs through `piwi-turbo`. CLI_PROJECT_CHANGE names a variable the config changes.
process.env.CLI_PROJECT_FROM_CONFIG = 'set by the config';
if (process.env.CLI_PROJECT_CHANGE) process.env[process.env.CLI_PROJECT_CHANGE] = 'changed by the config';

export default defineConfig({
  testDir: '.',
  outputDir: process.env.CLI_PROJECT_OUTPUT,
  reporter: 'line',
  projects: [
    { name: 'setup', testMatch: 'setup.check.ts' },
    { name: 'main', testMatch: 'main.check.ts', dependencies: ['setup'] },
  ],
});
