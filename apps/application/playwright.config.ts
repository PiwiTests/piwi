import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import PiwiDashboardReporter from '@piwitests/reporter';
const { wrapConfig } = PiwiDashboardReporter;
import { join } from 'path';
import { resolveE2ETarget, targetAuthHeaders } from './tests/desktop-target';

// Where the suite runs: the Playwright-managed server by default, or the Piwi
// desktop app already running on this machine when PIWI_DESKTOP_E2E is set. In
// desktop mode we adopt its loopback URL + access token, inject the token on
// every request, and start no server of our own (see tests/desktop-target.ts).
const e2eTarget = resolveE2ETarget();
// Bridge the resolved base URL to specs that read PIWI_BASE_URL directly.
if (e2eTarget.desktop) process.env.PIWI_BASE_URL = e2eTarget.baseUrl;

// CI runs every test server from the production output built once by the
// workflow; locally each server compiles on demand.
const useBuiltServer = !!process.env.CI;
const serverCommand = useBuiltServer ? 'node .output/server/index.mjs' : 'npm run app:dev';

/** An already-installed Chromium to use instead of the revision Playwright pins. */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim() || '';

// Stored third-party secrets (AI keys, webhook secrets) refuse to persist under
// the built-in default encryption key. Give every test server a real one — it is
// merged into each webServer via the inherited process.env — so the settings and
// channel flows the suite exercises can save.
process.env.PIWI_SECRET_KEY ||= 'test-encryption-secret-key-not-for-production';

// Share links are off by default; the suite exercises minting and the public
// share route, so every test server opts in (inherited via process.env).
process.env.PIWI_SHARE_LINKS_ENABLED = 'true';

// `PIWI_AUTH_*` is resolved into `runtimeConfig` when the Nuxt config is
// evaluated, which for a production build is build time. Nitro maps the
// `NUXT_`-prefixed forms onto the same keys at startup, so auth-enabled servers
// set both and work either way.
function authServerEnv(secret: string) {
  return {
    PIWI_AUTH_ENABLED: 'true',
    PIWI_AUTH_SECRET: secret,
    NUXT_AUTH_ENABLED: 'true',
    NUXT_AUTH_SECRET: secret,
    NUXT_PUBLIC_AUTH_ENABLED: 'true',
  };
}

// CI shards the suite across jobs, where a per-shard HTML report is not useful.
// Each shard emits a blob instead, which `npx playwright merge-reports` turns
// into a single report from the artifacts a failed run uploads.
const reporters: ReporterDescription[] = process.env.CI
  ? [['list'], ['blob', { outputDir: 'blob-report' }]]
  : [
      ['list'],
      ['html', { outputFolder: 'playwright-report' }],
      ['monocart-reporter', { name: 'Piwi Dashboard Tests', outputFile: 'monocart-report/index.html' }],
      ['blob', { outputDir: 'blob-report' }],
    ];

const baseConfig = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  // `tests/live/` talks to a real LLM and has its own config + npm script; a
  // normal run must never spend tokens.
  testIgnore: '**/live/**',

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  // Bail out of a hopelessly broken shard instead of burning the job timeout,
  // but keep the budget well clear of the retries: the counter tracks failed
  // *attempts*, so one test that fails all three of its tries already spends
  // three, and a flaky test that passes on retry still spends one. Reaching the
  // cap also tears down the workers mid-flight, which reports whatever tests
  // were still running as "Target page, context or browser has been closed" —
  // a tight cap turns two flakes into a red shard full of phantom failures.
  maxFailures: process.env.CI ? 12 : 0,

  // Sharding is where CI gets its parallelism now, so each shard can afford one
  // browser fewer: three workers plus the three app servers oversubscribe a
  // four-core runner, and the browsers are the ones that die under it.
  workers: process.env.CI ? 2 : 3,

  globalSetup: './tests/globalSetup',
  globalTeardown: './tests/globalTeardown',

  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: reporters,

  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: e2eTarget.baseUrl,

    // Present the desktop access token on every request the browser context and
    // the `request` fixture make, so the loopback guard lets them through. Empty
    // (and so a no-op) when not targeting the desktop.
    extraHTTPHeaders: targetAuthHeaders(e2eTarget),

    /* Trace on failure, with per-action DOM, ARIA and screenshot snapshots so the
       evidence timeline can show the page at each step. See https://playwright.dev/docs/trace-viewer */
    trace: { mode: 'retain-on-failure', snapshots: { dom: true, aria: true, screen: true } },

    /* Capture screenshot on first retry for failure diagnostics */
    screenshot: 'only-on-failure',

    // Chromium puts its shared renderer memory in /dev/shm, which is small on a
    // CI runner. When it fills the renderer is killed mid-test and Playwright
    // surfaces it as "Target page, context or browser has been closed" or an
    // unbound protocol object rather than as a real assertion failure. Backing
    // it with /tmp instead costs a little speed and removes that failure mode.
    launchOptions: { args: ['--disable-dev-shm-usage'] },
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Sandboxes and dev containers often ship a Chromium that does not match
        // the revision this Playwright pins, which makes every browser spec
        // unrunnable for a reason unrelated to the change under test. Pointing
        // PLAYWRIGHT_CHROMIUM_EXECUTABLE at the browser that *is* installed runs
        // the suite instead of skipping it. Unset everywhere else, so CI and
        // local machines keep using the pinned download.
        ...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
      },
    },
    /*
    ,
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] }
    }
    */
  ],

  /* Run your local dev server before starting the tests. In desktop mode the app
     is already running (we adopt it), so Playwright starts no server of its own. */
  webServer: e2eTarget.desktop
    ? undefined
    : [
        {
          command: serverCommand,
          url: 'http://localhost:3000',
          reuseExistingServer: !process.env.CI,
          // A dev server builds its Nitro bundle on every start, about a minute on four cores.
          timeout: (useBuiltServer ? 60 : 180) * 1000,
        },
        // Auth-enabled server used by reporter-with-auth.spec.ts.
        // Only started in CI; the corresponding tests are skipped when CI is not set.
        ...(process.env.CI
          ? [
              {
                command: serverCommand,
                url: 'http://localhost:3099/api/auth/me',
                env: {
                  ...authServerEnv('test-auth-secret-key-for-reporter-tests'),
                  PIWI_DATABASE_PATH: join(process.cwd(), '.test-temp', 'auth-test.db'),
                  PIWI_STORAGE_PATH: join(process.cwd(), '.test-temp', 'auth-test-storage'),
                  NITRO_PORT: '3099',
                  PIWI_BUILD_DIR: join(process.cwd(), '.test-temp', 'nuxt-build-auth'),
                  // Pin to isolated SQLite + local storage so the CI storage/db matrix
                  // (inherited via process.env) can't repoint this server's backend.
                  PIWI_DATABASE_URL: '',
                  PIWI_STORAGE_TYPE: 'local',
                },
                reuseExistingServer: false,
                timeout: 90 * 1000,
              },
              // Notifications server used by notifications.spec.ts.
              // Auth-enabled, no SMTP (channel test endpoint verifies SMTP-not-configured path).
              {
                command: serverCommand,
                url: 'http://localhost:3097/api/auth/me',
                env: {
                  ...authServerEnv('test-auth-secret-key-for-notifications-tests'),
                  PIWI_DATABASE_PATH: join(process.cwd(), '.test-temp', 'notif-test.db'),
                  PIWI_STORAGE_PATH: join(process.cwd(), '.test-temp', 'notif-test-storage'),
                  NITRO_PORT: '3097',
                  PIWI_BUILD_DIR: join(process.cwd(), '.test-temp', 'nuxt-build-notif'),
                  // Pin to isolated SQLite + local storage so the CI storage/db matrix
                  // (inherited via process.env) can't repoint this server's backend.
                  PIWI_DATABASE_URL: '',
                  PIWI_STORAGE_TYPE: 'local',
                },
                reuseExistingServer: false,
                timeout: 90 * 1000,
              },
            ]
          : []),
        // Auth+email server used by email-notifications.spec.ts.
        // Requires a Mailpit instance (docker run -p 1025:1025 -p 8025:8025 axllent/mailpit).
        // Set PIWI_MAILPIT_URL=http://localhost:8025 to opt in; tests are skipped otherwise.
        ...(process.env.PIWI_MAILPIT_URL
          ? [
              {
                command: serverCommand,
                url: 'http://localhost:3098/api/auth/me',
                env: {
                  ...authServerEnv('test-email-secret-key-for-mailpit-tests'),
                  PIWI_DATABASE_PATH: join(process.cwd(), '.test-temp', 'email-test.db'),
                  PIWI_STORAGE_PATH: join(process.cwd(), '.test-temp', 'email-test-storage'),
                  NITRO_PORT: '3098',
                  PIWI_BUILD_DIR: join(process.cwd(), '.test-temp', 'nuxt-build-email'),
                  PIWI_SMTP_HOST: 'localhost',
                  PIWI_SMTP_PORT: process.env.PIWI_MAILPIT_SMTP_PORT ?? '1025',
                  PIWI_SMTP_USER: 'test',
                  PIWI_SMTP_PASS: 'test',
                  PIWI_SMTP_FROM: 'noreply@piwi.test',
                  PIWI_SMTP_FROM_NAME: 'Piwi Test',
                  // Pin to isolated SQLite + local storage so the CI storage/db matrix
                  // (inherited via process.env) can't repoint this server's backend.
                  PIWI_DATABASE_URL: '',
                  PIWI_STORAGE_TYPE: 'local',
                },
                reuseExistingServer: !process.env.CI,
                timeout: 90 * 1000,
              },
            ]
          : []),
        // PostgreSQL-backed server used by postgresql.spec.ts.
        // Only started when PIWI_POSTGRES_TEST_URL is set; the corresponding tests are skipped otherwise.
        ...(process.env.PIWI_POSTGRES_TEST_URL
          ? [
              {
                command: serverCommand,
                url: 'http://localhost:3101',
                env: {
                  PIWI_DATABASE_URL: process.env.PIWI_POSTGRES_TEST_URL,
                  PIWI_STORAGE_PATH: join(process.cwd(), '.test-temp', 'pg-test-storage'),
                  NITRO_PORT: '3101',
                  // Keep this server on local storage regardless of the CI storage
                  // matrix; it exists to exercise the PostgreSQL backend in isolation.
                  PIWI_STORAGE_TYPE: 'local',
                },
                reuseExistingServer: false,
                timeout: 90 * 1000,
              },
            ]
          : []),
      ],
});

export default process.env.CI
  ? baseConfig
  : wrapConfig(baseConfig, {
      serverUrl: e2eTarget.baseUrl,
      // Stream this suite's own results to the desktop app too, authenticated
      // with its token. Left unset (and so no bearer) against the local server.
      ...(e2eTarget.token ? { apiKey: e2eTarget.token } : {}),
      projectName: 'Piwi Dashboard',
      projectDescription: 'The Piwi Dashboard project',
      streaming: true,
      uploadReport: false,
      uploadTraces: true,
      inspectOnFailure: false,
      pickLocatorOnFailure: false,
      // Off unless PIWI_CAPTURE_CODE_REACH=true; Nuxt's Vite root is app/.
      codeReachRoots: ['app'],
      verbose: true,
      reports: [{ type: 'html' }, { type: 'monocart' }, { type: 'blob', label: 'Blob Archive' }],
    });
