import { defineConfig } from '@playwright/test';
import { baseConfig, piwiOptions } from './playwright.shared';

/**
 * The other setup: the reporter in the `reporter` array, without `wrapConfig`. `npm run test:manual-reporter` runs
 * it, against the backend `SAMPLE_BACKEND` names (ASP.NET Core by default).
 */
export default defineConfig(baseConfig, {
  reporter: [['list'], ['@piwitests/reporter', piwiOptions]],
  // `wrapConfig` sets these when the config leaves them unset; a reporter added by hand sets nothing.
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
