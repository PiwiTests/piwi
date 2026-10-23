import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Config for the LIVE AI E2E (`ai-diagnosis-live.spec.ts`): the real diagnosis
 * pipeline against a real model, where `tests/ai-diagnosis.spec.ts` drives a
 * mock OpenAI-compatible server. It spends tokens, so it sits outside the main
 * suite — `playwright.config.ts` ignores `tests/live/` — and runs on demand:
 *
 *   OPENCODE_API_KEY=<key> npm run app:test:ai:live
 */

const apiKey = process.env.OPENCODE_API_KEY || process.env.PIWI_AI_API_KEY || '';
if (!apiKey) {
  throw new Error(
    'The live AI E2E needs a provider key — set OPENCODE_API_KEY (or PIWI_AI_API_KEY) before running it.',
  );
}

const baseUrl = process.env.PIWI_AI_BASE_URL || 'https://opencode.ai/zen/v1';
const model = process.env.PIWI_AI_MODEL || 'deepseek-v4-flash';

const PORT = 3102;
// Its own subdirectory: the reporter's live AI-step E2E keeps its server state
// under `.live-temp/steps`.
const tempDir = join(process.cwd(), '.live-temp', 'diagnosis');

// The server self-migrates on boot but only creates the database file, not the
// directory holding it.
mkdirSync(join(tempDir, 'storage'), { recursive: true });

// CI runs the production output when it is already built; locally the dev
// server compiles on demand. `PIWI_AI_*` is read when the Nuxt config is
// evaluated — build time for a production build — so the built server also gets
// the `NUXT_AI_*` forms Nitro maps onto the same runtimeConfig keys at startup.
const serverCommand = process.env.CI ? 'node .output/server/index.mjs' : 'npm run app:dev';

export default defineConfig({
  testDir: '.',
  testMatch: '**/ai-diagnosis-live.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A gateway hiccup should not redden a run that costs tokens to repeat, but a
  // second attempt is as far as it goes.
  retries: process.env.CI ? 1 : 0,
  // Live model latency: a diagnosis is one long provider call.
  timeout: 180_000,
  reporter: [['list']],

  use: {
    baseURL: `http://localhost:${PORT}`,
  },

  webServer: [
    {
      command: serverCommand,
      url: `http://localhost:${PORT}/api/ai/status`,
      env: {
        PIWI_AI_PROVIDER: 'openai',
        PIWI_AI_BASE_URL: baseUrl,
        PIWI_AI_MODEL: model,
        PIWI_AI_API_KEY: apiKey,
        NUXT_AI_PROVIDER: 'openai',
        NUXT_AI_BASE_URL: baseUrl,
        NUXT_AI_MODEL: model,
        NUXT_AI_API_KEY: apiKey,
        // The live model is text-only, and the provider rejects the whole call
        // when a context carries an image. The diagnosis context stays
        // image-free; `ai-diagnosis-live.spec.ts` asserts it.
        PIWI_AI_MAX_IMAGES: '0',
        // Reasoning tokens count toward the completion budget, so the default
        // 1024-token step cap truncates a decision mid-JSON.
        PIWI_AI_STEP_MAX_OUTPUT_TOKENS: '8192',
        PIWI_SECRET_KEY: process.env.PIWI_SECRET_KEY || 'live-e2e-encryption-key-not-for-production',
        // Throwaway SQLite + local storage, pinned so an inherited CI storage
        // matrix cannot repoint this server's backend.
        PIWI_DATABASE_PATH: join(tempDir, 'live.db'),
        PIWI_DATABASE_URL: '',
        PIWI_STORAGE_TYPE: 'local',
        PIWI_STORAGE_PATH: join(tempDir, 'storage'),
        PIWI_BUILD_DIR: join(tempDir, 'nuxt-build'),
        NITRO_PORT: String(PORT),
      },
      reuseExistingServer: false,
      timeout: 120 * 1000,
    },
  ],
});
