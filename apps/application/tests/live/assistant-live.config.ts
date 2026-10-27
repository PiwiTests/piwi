import { defineConfig } from '@playwright/test';

/**
 * Config for the LIVE assistant question set (`assistant-live.spec.ts`): every
 * question of `assistant-questions.ts` asked of a real model, each answer
 * scored. It spends tokens, so it sits outside the main suite —
 * `playwright.config.ts` ignores `tests/live/` — and runs on demand:
 *
 *   OPENCODE_API_KEY=<key> npm run app:test:assistant:live
 *
 * With no key and `PIWI_ASSISTANT_LIVE_MOCK=1`, the same spec runs against a
 * scripted mock model, which proves the runner and the report with no tokens.
 * The spec boots its own server on its own port and database.
 */

const apiKey = process.env.OPENCODE_API_KEY || process.env.PIWI_AI_API_KEY || '';
if (!apiKey && process.env.PIWI_ASSISTANT_LIVE_MOCK !== '1') {
  throw new Error(
    'The live assistant run needs a provider key — set OPENCODE_API_KEY (or PIWI_AI_API_KEY) — or ' +
      'PIWI_ASSISTANT_LIVE_MOCK=1 to run it against the mock model.',
  );
}

export default defineConfig({
  testDir: '.',
  testMatch: '**/assistant-live.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A rerun asks every question again and spends the tokens again.
  retries: 0,
  // The spec sets its own timeout from the number of questions it asks.
  timeout: 30 * 60_000,
  reporter: [['list']],
});
