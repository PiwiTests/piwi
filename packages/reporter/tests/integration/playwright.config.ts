import { defineConfig } from '@playwright/test';

// The workers inherit it: the capture fixtures keep the `X-Piwi-Coverage`
// request ids the fixture server names, as with server coverage on.
process.env.PIWI_COVERAGE_SERVER = 'lines';

/**
 * Standalone Playwright project for the capture-fixtures integration spec.
 * Deliberately separate from the Vitest unit suite (which cannot drive a real
 * browser) and from the application's own E2E suite (which tests the app, not
 * this package). Run with `npm run reporter:test:integration`.
 *
 * Verification lives in `verify-reporter.ts` — a custom Reporter whose
 * `onTestEnd` inspects the real `piwi-*` attachments the capture fixtures
 * produced and fails the run (non-zero exit) on a mismatch.
 */
export default defineConfig({
  testDir: '.',
  // The AI-step integration spec lives in `ai/` with its own config and
  // verification (its own `expect()`s, not the capture attachments this reporter
  // checks); keep it out of this run.
  testIgnore: '**/ai/**',
  // The stub instrumented backend the API tests call, in this process.
  globalSetup: './api-backend.ts',
  timeout: 30_000,
  reporter: [['./verify-reporter.ts'], ['line']],
  use: {
    headless: true,
    launchOptions: {
      // This package's @playwright/test peer resolves to a browser revision
      // this sandbox doesn't have pre-installed (only the regular chromium
      // binary is, not the separate chrome-headless-shell variant that
      // `headless: true` otherwise resolves to). Point at the pre-installed
      // binary directly instead of downloading a new one.
      executablePath: '/opt/pw-browsers/chromium',
    },
  },
});
