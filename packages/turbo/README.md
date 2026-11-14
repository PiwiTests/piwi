# @piwitests/turbo

Make a Playwright suite faster without forking Playwright: you keep `@playwright/test`, its browsers and its upgrades.
Pick a preset, add your sign-in and the third-party URLs to block, and measure the result with the benchmark that
comes with it.

## Install

```sh
npm install --save-dev @piwitests/turbo
```

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
    preset: 'fast',
    signIn: { storageState: '.auth/user.json' },
    blockRequests: ['https://www.googletagmanager.com/**'],
  },
);
```

Then take `test` from `@piwitests/turbo/test`, in your tests or as the base of your own fixtures file:

```ts
import { test, expect } from '@piwitests/turbo/test';
```

## Presets

| Preset | Turns on                                                                                                                                                                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safe` | Nothing a test observes changes. Traces the config records are kept for failures (recorded on the first retry when it retries), screenshots are taken of failed tests only, video on the first retry. Node's compile cache shortens the start of the runner and its workers. |
| `fast` | `safe`, plus reduced motion and instant animations, which change what the page does, and one browser context per worker, reset between tests, in place of a new context for each test.                                                                                       |
| `max`  | `fast`, plus every experimental hook: faster PNG encoding, a shorter retry backoff, assertions that fail once the page is idle, pointer actions that skip the wait for a still element, and a lighter reset of the reused context.                                           |

A preset only lowers costs your config has: it never turns on traces, screenshots or video the config leaves off. An
option named beside the preset wins over it.

On the package's reference suite, against a typical unoptimized setup, `safe` took 5% off the wall time and 19% off
the CPU time, and `fast` 8% and 50%. Context reuse changed little there, a suite whose time is mostly waiting on its
API; on Flashwright's benchmark suites it took 5–25% off the app suites.

### Sign-in and third-party requests

These two need your paths and URLs, so no preset sets them.

- **`signIn: { storageState }`** adds a `setup` project that runs your `*.setup.ts` files, which save the signed-in
  state to `storageState`. Every other project depends on it and loads that state. Tests that change server-side state
  still need their own account or data. Keep the state file out of Git.
- **`blockRequests`** aborts the requests that match a glob, a regular expression or a predicate, typically
  third-party scripts that hold the `load` event. Routes a test adds with `page.route` run first. Never block a script
  the app needs.

## Context reuse

`fast` turns on Playwright's own context reuse (`reuseContext`), with a reset of what it leaves behind: offline mode,
extra HTTP headers, permissions and geolocation go back to the configured values, and on Chromium the Cache Storage
of every origin the test visited is cleared. Playwright resets the rest: pages, cookies, storage, the HTTP cache,
service workers, routes, init scripts, bindings, the clock, the viewport and emulated media.
`tests/e2e/reuse-isolation.ts` checks each of them. Reuse only happens through `@piwitests/turbo/test`, and needs
video off. Turn it off with `reuseContext: false`.

## Advanced: the levers one by one

Every preset is a set of these options; name one to override it.

| Option               | What it does                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trace`              | The trace mode, e.g. `retain-on-failure` or `on-first-retry`.                                                                                                                               |
| `lightTraces`        | `true` keeps each action's DOM snapshot and leaves out the ARIA and screenshot snapshots and the screencast; `'actions'` leaves out the DOM snapshots too.                                  |
| `failureScreenshots` | Screenshots a test's pages only when it fails. With `only-on-failure`, Playwright captures every test and keeps the failed ones.                                                            |
| `videoOnRetry`       | With retries, records video on the first retry instead of `retain-on-failure`, which records every test.                                                                                    |
| `reducedMotion`      | Emulates `prefers-reduced-motion: reduce`. Leave it off for tests of animations.                                                                                                            |
| `instantAnimations`  | Chromium runs CSS and Web Animations 1000 times faster, whether or not the app honors reduced motion.                                                                                       |
| `reuseContext`       | One browser context per worker, reset between tests (see above).                                                                                                                            |
| `compileCache`       | Node's compile cache for the runner and its workers, in `node_modules/.cache/piwi-turbo-compile` or the folder given. Skipped when coverage is collected or a compile cache is already set. |

### Experimental hooks

`max` turns these on; name them under `experimental` to pick some, or set one for a file with `test.use()`.

```ts
withOptimizations(config, {
  experimental: {
    fastScreenshots: true,
    retryIntervals: [10, 20, 40, 50],
    failFast: true,
    skipStabilityWait: true,
    fastReset: true,
  },
});
```

- **`fastScreenshots`** (Chromium): adds CDP's `optimizeForSpeed` to PNG screenshots. The decoded pixels are the same;
  the files are larger (often 2–3×). Runs that write snapshots keep stock encoding, so baselines do too.
- **`retryIntervals`**: the waits between the checks of Playwright's retry loop. Stock is `[20, 50, 100, 100, 500]` ms.
  Shorter waits pay where the UI settles between stock checks, and cost a round trip each.
- **`failFast`**: a failing web-first assertion ends once nothing can change the page before its timeout: no request
  in flight, and in the page no timer due, interval, animation frame, socket, worker, running animation or playing
  media. It shortens red runs, does nothing on a page that polls, and must stay off for a test that changes the page
  from its own Node code while an assertion waits.
- **`skipStabilityWait`**: clicks, hovers, taps and drags stop waiting for the element to keep still. The visible,
  enabled and hit-target checks stay. Leave it off for apps that ignore input while they animate.
- **`fastReset`** (Chromium, with `reuseContext`): between tests, the storage of the origins the test visited is
  cleared from the frames still on them and through CDP, where Playwright's reset loads each origin again to clear
  it. After a test that left an origin it visited, Playwright's reset runs as it is.

The hooks wrap Playwright's server inside each test worker: the server `Page.prototype.reportAsNew` and
`BrowserContext.prototype.resetForReuse`, and from the first page the frame class, the element handle class and
Chromium's CDP session. They refuse to run, with an error that names the reason, on a `playwright-core` version they
were not tested with (`TESTED_VERSIONS`, currently 1.64.1), on an internal with another shape, or when the browser runs
outside the worker. To try a new Playwright version, run `npm run turbo:test:e2e` and the benchmark with
`PIWI_TURBO_ALLOW_UNTESTED=1`, then add it to `TESTED_VERSIONS`.

## The benchmark

`bench/` compares configurations by running whole commands of a suite, interleaved in rotating rounds, and reports
each against a baseline round by round with an interval, along with CPU (every process, Chromium included), peak
memory, artifact size, failures and where the test time went. Its reference workload is an orders console with a slow
API, third-party scripts, animations and a large table, tested by a 43-test suite.

```sh
npm run turbo:bench:profile # where the workload's test time goes
npm run turbo:bench         # every variant in bench/workload/bench.config.mjs
```

See [`bench/README.md`](https://github.com/PiwiTests/piwi/blob/main/packages/turbo/bench/README.md) to run it on your
own suite. The benchmark lives in the repository and is not part of the npm package.

## Credits

Several levers follow techniques from [Flashwright](https://github.com/xcodebeast/flashwright), a fork of Playwright
that makes them its defaults: faster PNG encoding, less waiting between checks, failure screenshots taken only on
failure, instant animations, assertions that fail once the page is idle, pointer actions that skip the wait for a
still element, and a reused, reset browser context. @piwitests/turbo applies them to stock Playwright at runtime
instead of forking it. It contains no Flashwright or Playwright code; both are Apache-2.0.

@piwitests/turbo is part of [Piwi](https://github.com/PiwiTests/piwi), and neither is affiliated with or endorsed by
Microsoft or the Flashwright project. Playwright is a trademark of Microsoft Corporation.

## License

MIT
