# suitetune

Make a Playwright suite faster without forking Playwright. Fresh browser contexts stay the default: nothing here
reuses a context between tests.

suitetune has two layers:

- **Public levers**, applied to your config: sign in once and reuse the saved state, block third-party requests,
  keep traces only for failures, emulate reduced motion, Node's compile cache. Supported Playwright features, safe
  across upgrades.
- **Experimental hooks** into Playwright's internals: faster PNG encoding for Chromium screenshots, and a shorter
  backoff for Playwright's retry loop. Off by default, pinned to the Playwright versions they were tested with, and
  they throw instead of falling back when anything differs.

Measure before you keep any of them: `bench/` holds the benchmark that compares them on a realistic suite, and runs on
yours.

## Install

```sh
npm install --save-dev suitetune
```

## Public levers

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';
import { withOptimizations } from 'suitetune';

export default withOptimizations(
  defineConfig({
    testDir: './tests',
    fullyParallel: true,
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  }),
  {
    signIn: { storageState: '.auth/user.json' },
    blockRequests: ['https://www.googletagmanager.com/**', /\/\/widget\.example\.com\//],
    trace: 'retain-on-failure',
    reducedMotion: true,
    compileCache: true,
  },
);
```

Then import `test` from `suitetune/test` in your tests (it is `@playwright/test`'s `test` with the fixtures below):

```ts
import { test, expect } from 'suitetune/test';
```

| Option          | What it does                                                                                                                                                                                                        | Trade-off                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `signIn`        | Adds a `setup` project that runs your `*.setup.ts` files, which save the signed-in state to `storageState`. Every other project depends on it and loads that state into each fresh context.                         | Tests that change server-side state still need their own account or data. Keep the state file out of Git.                       |
| `blockRequests` | Aborts requests matching a glob, a regular expression or a predicate, in every context of every test.                                                                                                              | Any route turns on request interception for the whole context. A script the app depends on must not be blocked.                 |
| `trace`         | Sets the trace mode, e.g. `retain-on-failure` or `on-first-retry`.                                                                                                                                                  | `on-first-retry` records nothing without retries.                                                                               |
| `reducedMotion` | Emulates `prefers-reduced-motion: reduce`.                                                                                                                                                                          | Changes the app's behavior when it honors the preference: do not use it for tests of animations.                                |
| `compileCache`  | Turns on Node's compile cache for the runner and the workers (`true` caches in `node_modules/.cache/suitetune-compile`). Skipped when `NODE_V8_COVERAGE` is set.                                                    | Pays off on repeated local runs; in CI only if the cache directory is restored.                                                 |

Each option is off unless named, and a project's own settings win over them (`use.storageState` set on a project
stays).

## Experimental hooks

```ts
withOptimizations(config, {
  experimental: {
    fastScreenshots: true,
    retryIntervals: [10, 20, 40, 50],
  },
});
```

or for one file: `test.use({ fastScreenshots: true })`.

- **`fastScreenshots`** (Chromium): adds CDP's `optimizeForSpeed` to `Page.captureScreenshot` for PNGs. The decoded
  pixels are the same; the files are larger (often 2–3×), which costs storage and upload time. It is off in runs
  that write snapshots (`--update-snapshots`), so baselines keep stock encoding. Baselines a hooked run writes because
  they were missing come out larger: rewrite them with `--update-snapshots`.
- **`retryIntervals`**: the waits between the checks of Playwright's retry loop (web-first assertions, waits, finding
  the element of an action). Stock is `[20, 50, 100, 100, 500]` ms, then 500 ms until the timeout; `[10, 20, 40, 50]`
  checks every 50 ms. Each check costs a round trip to the page, so the gain shows only where UI settles between stock
  checks, and the extra checks cost CPU.

How they work: Playwright's server runs inside each test worker for a browser the worker launches. suitetune wraps
the server `Page.prototype.reportAsNew`, and from the first page it reaches the frame class
(`retryWithProgressAndBackoff`) and Chromium's CDP session (`send`) and wraps those. A worker runs one test at a time,
so a test that enables a hook gets it on every page it opens, and no other test does.

They refuse to run, with an error that names the reason, when:

- the installed `playwright-core` is not a version they were tested with (`TESTED_VERSIONS`, currently 1.64.1),
- a patched internal does not have the shape they expect,
- the browser runs elsewhere (`connectOptions`, a remote endpoint), or `fastScreenshots` meets a browser other than
  Chromium.

Upgrading Playwright: run the compatibility suite and the benchmark with `SUITETUNE_ALLOW_UNTESTED=1`, then add the
version to `TESTED_VERSIONS`.

```sh
npm run test:e2e
```

## Not here, on purpose

- **Skipping actionability checks**: it saves a frame or two per action and changes what an action means. Use
  `force: true` on the specific calls where the target is known to be static.
- **Reusing browser contexts or a warm browser**: no measured gain worth the lost isolation.

## The benchmark

`bench/` compares configurations by running whole commands of a suite, interleaved in rotating rounds, and reports
each against a baseline round by round with an interval, along with CPU (every process, Chromium included), peak
memory (PSS of the process tree), artifact size, failures and where the test time went. It ships a realistic
workload: an orders console with a slow API, third-party scripts, animations and a large table, tested by a 43-test
suite that uses suitetune for every lever.

```sh
npm run bench:profile   # where the workload's test time goes
npm run bench           # every variant in bench/workload/bench.config.mjs
```

See [`bench/README.md`](bench/README.md) to run it on your own suite.

## License

MIT
