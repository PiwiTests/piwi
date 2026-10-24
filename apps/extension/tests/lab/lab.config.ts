import { defineConfig } from '@playwright/test';

/**
 * The lab's recordings and replays, one scenario at a time by default: the
 * dashboard's share its data. `LAB_WORKERS` runs the public sites' side by side.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'lab.spec.ts',
  workers: Number(process.env.LAB_WORKERS ?? 1),
  timeout: 6 * 60_000,
  reporter: [['list'], ['json', { outputFile: 'out/lab-report.json' }]],
  outputDir: 'out/test-results',
});
