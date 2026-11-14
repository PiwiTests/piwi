import { defineConfig, devices } from '@playwright/test';

// Every lever the benchmark varies is an environment variable, so one config serves every variant:
//   BENCH_AUTH               state (sign in once, reuse storageState) | ui (sign in through the form in every test)
//   BENCH_TRACE              trace mode (default on-first-retry)
//   BENCH_SCREENSHOT         screenshot mode (default only-on-failure)
//   BENCH_VIDEO              video mode (default off)
//   BENCH_WORKERS            worker count or percentage (default: Playwright's)
//   BENCH_RETRIES            retries (default 2 on CI, 0 elsewhere)
//   BENCH_REDUCED_MOTION     1 emulates prefers-reduced-motion: reduce
//   BENCH_BLOCK_THIRD_PARTY  1 aborts requests to the vendor origin
//   BENCH_EVIDENCE           png | jpeg, the format of the screenshots tests attach as evidence
//   BENCH_PORT               app port (default 4310); LATENCY scales the server's delays
const env = process.env;
const PORT = Number(env.BENCH_PORT ?? 4310);
const auth = env.BENCH_AUTH ?? 'state';
const workers = env.BENCH_WORKERS?.endsWith('%') ? env.BENCH_WORKERS : env.BENCH_WORKERS ? Number(env.BENCH_WORKERS) : undefined;
const chrome = devices['Desktop Chrome'];

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!env.CI,
  retries: Number(env.BENCH_RETRIES ?? (env.CI ? 2 : 0)),
  workers,
  reporter: env.CI ? 'dot' : 'list',
  outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: (env.BENCH_TRACE ?? 'on-first-retry') as 'on',
    screenshot: (env.BENCH_SCREENSHOT ?? 'only-on-failure') as 'on',
    video: (env.BENCH_VIDEO ?? 'off') as 'on',
    contextOptions: { reducedMotion: env.BENCH_REDUCED_MOTION === '1' ? 'reduce' : 'no-preference' },
  },
  expect: {
    toHaveScreenshot: { stylePath: './tests/screenshot.css', maxDiffPixelRatio: 0.002 },
  },
  projects:
    auth === 'ui'
      ? [{ name: 'chromium', use: chrome, testIgnore: /auth\.setup\.ts/ }]
      : [
          { name: 'setup', testMatch: /auth\.setup\.ts/, use: chrome },
          { name: 'chromium', use: { ...chrome, storageState: '.auth/user.json' }, dependencies: ['setup'] },
        ],
  webServer: {
    command: 'node app/server.mjs',
    url: `http://localhost:${PORT}/login`,
    env: { PORT: String(PORT), LATENCY: env.LATENCY ?? '1' },
    reuseExistingServer: env.BENCH_REUSE_SERVER === '1',
  },
});
