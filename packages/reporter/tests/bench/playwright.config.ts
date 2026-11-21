import { defineConfig } from '@playwright/test';

// Same pinned binary as the integration project: this package's
// @playwright/test peer resolves to a browser revision the sandbox does not
// pre-install, and downloading one mid-benchmark would skew the first
// variant's numbers. `run.mjs` fills this in when the binary is present.
const launchOptions = process.env.PIWI_BENCH_CHROMIUM
  ? { executablePath: process.env.PIWI_BENCH_CHROMIUM }
  : {};

/**
 * Standalone Playwright project for the capture-overhead benchmark. Driven by
 * `run.mjs`, which invokes it once per capture variant and reads the per-test
 * durations back out of the JSON reporter.
 *
 * The settings below exist to keep the measurement quiet rather than to mirror
 * a production config: one worker and no parallelism so tests never contend for
 * CPU, no retries so a slow test is never silently re-run, and every artifact
 * Playwright would otherwise write (traces, video, screenshots) switched off so
 * the numbers reflect capture cost and not disk I/O.
 */
export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['json']],
  use: {
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions,
  },
});
