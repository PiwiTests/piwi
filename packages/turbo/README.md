# @piwitests/turbo

Make a Playwright suite faster without forking Playwright: you keep `@playwright/test`, its browsers and its upgrades,
and every test still gets its own fresh browser context.

@piwitests/turbo has two layers:

- **Public levers**, applied to your config: sign in once and reuse the saved state, block third-party requests,
  record lighter traces and keep them only for failures, screenshot failed tests only, emulate reduced motion, run
  animations at once. Supported Playwright features, safe across upgrades.
- **Experimental hooks** into Playwright's internals: faster PNG encoding for Chromium screenshots, a shorter backoff
  for Playwright's retry loop, failing an assertion early once nothing can change the page, and pointer actions that
  skip the wait for the element to keep still. Off by default, pinned
  to the Playwright versions they were tested with, and they throw instead of falling back when anything differs.

Presets bundle them by how much a test can notice: `safe`, `fast` and `experimental`.

Measure before you keep any of them: `bench/` holds the benchmark that compares them on a realistic suite, and runs on
yours.

## Install

```sh
npm install --save-dev @piwitests/turbo
```

## Presets

```ts
export default withOptimizations(defineConfig({ ... }), { preset: 'fast' });
```

| Preset         | Turns on                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `safe`         | Nothing a test observes changes: traces kept for failures (`on-first-retry` when the config retries), failure screenshots, video on the first retry instead of `retain-on-failure` when the config retries. |
| `fast`         | `safe`, plus `reducedMotion` and `instantAnimations`, which change what the page does.                                                         |
| `experimental` | `fast`, plus the `fastScreenshots` and `retryIntervals` hooks.                                                                                 |

An option named beside the preset wins over it; one left `undefined` keeps the preset's. `signIn` and `blockRequests`
need your paths and URLs, so no preset sets them. On the package's reference suite, against a typical unoptimized
setup: `safe` took 5% off the wall time and 19% off the CPU time, `fast` 8% and 50%, `experimental` 19% and 51%.

## Public levers

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';
import { withOptimizations } from '@piwitests/turbo';

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
  },
);
```

Then import `test` from `@piwitests/turbo/test` in your tests (it is `@playwright/test`'s `test` with the fixtures below):

```ts
import { test, expect } from '@piwitests/turbo/test';
```

| Option          | What it does                                                                                                                                                                                                        | Trade-off                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `signIn`        | Adds a `setup` project that runs your `*.setup.ts` files, which save the signed-in state to `storageState`. Every other project depends on it and loads that state into each fresh context.                         | Tests that change server-side state still need their own account or data. Keep the state file out of Git.                       |
| `blockRequests` | Aborts requests matching a glob, a regular expression or a predicate, in every context of every test.                                                                                                              | Any route turns on request interception for the whole context. A script the app depends on must not be blocked.                 |
| `trace`         | Sets the trace mode, e.g. `retain-on-failure` or `on-first-retry`.                                                                                                                                                  | `on-first-retry` records nothing without retries.                                                                               |
| `reducedMotion` | Emulates `prefers-reduced-motion: reduce`.                                                                                                                                                                          | Changes the app's behavior when it honors the preference: do not use it for tests of animations.                                |
| `lightTraces`   | `true` keeps each action's DOM snapshot and leaves out the ARIA and screenshot snapshots and the screencast, the costliest parts of a trace; `'actions'` leaves out the DOM snapshots too.                           | The trace viewer shows less: no screencast, and with `'actions'` no page at each step.                                          |
| `failureScreenshots` | Screenshots of a test's open pages when it fails, and none when it passes, in place of `screenshot: 'only-on-failure'`, which captures every test's pages and keeps the failed ones.                            | Pages of a context the test closed itself are not captured. A config that asks for every test's screenshots keeps them.          |
| `instantAnimations` | Chromium: CSS transitions and animations, and Web Animations, run 1000 times faster, whether or not the app honors reduced motion.                                                                           | Changes the timing of the app's animations. Other browsers are left alone.                                                       |
| `videoOnRetry`  | With retries, records video on the first retry instead of `retain-on-failure`, which records every test.                                                                                                           | Without retries a failure has no video.                                                                                         |

Each option is off unless named or part of the preset, and a project's own settings win over them (`use.storageState`
set on a project stays). `blockRequests`, `failureScreenshots` and `instantAnimations` are fixtures: they need `test`
from `@piwitests/turbo/test`. Routes a test adds with `page.route` run before `blockRequests`, which routes the context.

## Experimental hooks

```ts
withOptimizations(config, {
  experimental: {
    fastScreenshots: true,
    retryIntervals: [10, 20, 40, 50],
    failFast: true,
    skipStabilityWait: true,
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
- **`failFast`**: a failing web-first assertion ends once nothing can change the page before its timeout: no request
  in flight, and in the page no timer due, interval, animation frame, idle callback, open socket or worker, running
  animation, playing media or loading font. An init script keeps count of that work; the assertion fails on two idle
  polls in a row, and its call log says so. It does nothing for passing tests, and nothing on a page that polls (an
  interval keeps it busy). A test that changes the page from its own Node code while an assertion waits must leave it
  off.
- **`skipStabilityWait`**: clicks, hovers, taps and drags stop waiting for the element to keep still for two animation
  frames. The visible, enabled and hit-target checks stay, so an element still moving under the pointer is retried.
  Leave it off for apps that ignore input while they animate. On Flashwright's benchmark suites it took 5–20% off a
  run with one worker.

How they work: Playwright's server runs inside each test worker for a browser the worker launches. @piwitests/turbo wraps
the server `Page.prototype.reportAsNew`, and from the first page it reaches the frame class
(`retryWithProgressAndBackoff`, `expect`, `_expectInternal`, `isNonRetriableError`, `_retryWithProgressIfNotConnected`),
the element handle class (`evaluateInUtility`) and Chromium's CDP session (`send`) and wraps those. A worker runs one test at a time,
so a test that enables a hook gets it on every page it opens, and no other test does.

They refuse to run, with an error that names the reason, when:

- the installed `playwright-core` is not a version they were tested with (`TESTED_VERSIONS`, currently 1.64.1),
- a patched internal does not have the shape they expect,
- the browser runs elsewhere (`connectOptions`, a remote endpoint), or `fastScreenshots` meets a browser other than
  Chromium.

Upgrading Playwright: run the compatibility suite and the benchmark with `PIWI_TURBO_ALLOW_UNTESTED=1`, then add the
version to `TESTED_VERSIONS`.

```sh
npm run turbo:test:e2e
```

## The benchmark

`bench/` compares configurations by running whole commands of a suite, interleaved in rotating rounds, and reports
each against a baseline round by round with an interval, along with CPU (every process, Chromium included), peak
memory (PSS of the process tree), artifact size, failures and where the test time went. It ships a realistic
workload: an orders console with a slow API, third-party scripts, animations and a large table, tested by a 43-test
suite that uses @piwitests/turbo for every lever.

```sh
npm run turbo:bench:profile # where the workload's test time goes
npm run turbo:bench         # every variant in bench/workload/bench.config.mjs
```

See [`bench/README.md`](https://github.com/PiwiTests/piwi/blob/main/packages/turbo/bench/README.md) to run it on your
own suite. The benchmark lives in the repository and is not part of the npm package.

## Credits

The experimental hooks follow techniques from [Flashwright](https://github.com/xcodebeast/flashwright), a fork of
Playwright that makes them its defaults: faster PNG encoding with the same pixels, and less waiting between the checks
of actions and assertions, failure screenshots taken only when a test fails, instant animations, and assertions that
fail once the page is idle, and pointer actions that skip the wait for a still element. @piwitests/turbo applies a subset of them to stock Playwright at runtime instead of forking
it. It contains no Flashwright or Playwright code; both are Apache-2.0.

@piwitests/turbo is part of [Piwi](https://github.com/PiwiTests/piwi), and neither is affiliated with or endorsed by
Microsoft or the Flashwright project. Playwright is a trademark of Microsoft Corporation.

## License

MIT
