import { defineConfig, devices } from '@playwright/test';
import { withOptimizations } from '../../src/index';

// Every lever the benchmark varies is an environment variable, so one config serves every variant. The levers go
// through @piwitests/turbo, so the benchmark measures the package itself:
//   BENCH_AUTH               ui (default: sign in through the form in every test) | state (@piwitests/turbo's signIn)
//   BENCH_TRACE              trace mode (default on)
//   BENCH_LIGHT_TRACES       1 | actions: @piwitests/turbo's lightTraces
//   BENCH_REDUCED_MOTION     1: @piwitests/turbo's reducedMotion
//   BENCH_BLOCK_THIRD_PARTY  1: @piwitests/turbo's blockRequests, for the vendor origin
//   BENCH_FAILURE_SCREENSHOTS 1: @piwitests/turbo's failureScreenshots
//   BENCH_INSTANT_ANIMATIONS 1: @piwitests/turbo's instantAnimations
//   BENCH_PRESET             safe | fast | experimental: @piwitests/turbo's preset (BENCH_TRACE would win over it)
//   BENCH_FAIL_FAST          1: the experimental failFast hook
//   BENCH_DIFFERENTIAL_SNAPSHOTS 1: the experimental differentialSnapshots hook
//   BENCH_FAILING            1: also run the failing tests (tests/failing.spec.ts), to measure a red run
//   BENCH_FAST_SCREENSHOTS   1: the experimental fastScreenshots hook
//   BENCH_RETRY_INTERVALS    comma-separated milliseconds: the experimental retryIntervals hook
//   BENCH_WORKERS            worker count or percentage (default: Playwright's)
//   BENCH_RETRIES            retries (default 2 on CI, 0 elsewhere)
//   BENCH_SCREENSHOT         screenshot mode (default only-on-failure); BENCH_VIDEO video mode (default off)
//   BENCH_EVIDENCE           png | jpeg, the format of the screenshots tests attach as evidence
//   BENCH_PORT               app port (default 4310); LATENCY scales the server's delays
const env = process.env;
const PORT = Number(env.BENCH_PORT ?? 4310);
const VENDOR_PORT = String(PORT + 1);
const workers = env.BENCH_WORKERS?.endsWith('%')
  ? env.BENCH_WORKERS
  : env.BENCH_WORKERS
    ? Number(env.BENCH_WORKERS)
    : undefined;

const config = defineConfig({
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
    trace: 'on',
    screenshot: (env.BENCH_SCREENSHOT ?? 'only-on-failure') as 'on',
    video: (env.BENCH_VIDEO ?? 'off') as 'on',
  },
  expect: {
    toHaveScreenshot: { stylePath: './tests/screenshot.css', maxDiffPixelRatio: 0.002 },
  },
  projects: [
    {
      name: 'chromium',
      use: devices['Desktop Chrome'],
      testIgnore: env.BENCH_FAILING === '1' ? /auth\.setup\.ts/ : [/auth\.setup\.ts/, /failing\.spec\.ts/],
    },
  ],
  webServer: {
    command: 'node app/server.mjs',
    url: `http://localhost:${PORT}/login`,
    env: { PORT: String(PORT), LATENCY: env.LATENCY ?? '1' },
    reuseExistingServer: env.BENCH_REUSE_SERVER === '1',
  },
});

export default withOptimizations(config, {
  preset: env.BENCH_PRESET as 'safe' | 'fast' | 'experimental' | undefined,
  failureScreenshots: env.BENCH_FAILURE_SCREENSHOTS === '1' || undefined,
  instantAnimations: env.BENCH_INSTANT_ANIMATIONS === '1' || undefined,
  signIn: env.BENCH_AUTH === 'state' ? { storageState: '.auth/user.json' } : undefined,
  trace: env.BENCH_TRACE as 'on' | undefined,
  lightTraces: env.BENCH_LIGHT_TRACES === 'actions' ? 'actions' : env.BENCH_LIGHT_TRACES === '1' || undefined,
  reducedMotion: env.BENCH_REDUCED_MOTION === '1' || undefined,
  blockRequests: env.BENCH_BLOCK_THIRD_PARTY === '1' ? [(url) => url.port === VENDOR_PORT] : undefined,
  experimental: {
    fastScreenshots: env.BENCH_FAST_SCREENSHOTS === '1' || undefined,
    failFast: env.BENCH_FAIL_FAST === '1' || undefined,
    differentialSnapshots: env.BENCH_DIFFERENTIAL_SNAPSHOTS === '1' || undefined,
    retryIntervals: env.BENCH_RETRY_INTERVALS ? env.BENCH_RETRY_INTERVALS.split(',').map(Number) : undefined,
  },
});
