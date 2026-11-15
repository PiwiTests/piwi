import { defineConfig } from '@playwright/test';

// The same project's ESM entry, which Playwright loads through `import()`.
export default defineConfig({
  testDir: '.',
  testMatch: 'esm.check.mts',
  outputDir: process.env.CLI_PROJECT_OUTPUT,
  reporter: 'line',
});
