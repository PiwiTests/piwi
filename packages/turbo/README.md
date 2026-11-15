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

| Preset | Turns on                                                                                                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `safe` | Nothing a test observes changes. Traces the config records are kept for failures (recorded on the first retry when it retries), screenshots are taken of failed tests only, video on the first retry. Node's compile cache shortens the start of each test worker.                               |
| `fast` | `safe`, plus reduced motion and instant animations, which change what the page does, and one browser context per worker, reset between tests, in place of a new context for each test.                                                                                                           |
| `max`  | `fast`, plus every experimental hook: faster PNG encoding, a shorter retry backoff, assertions that fail once the page is idle, pointer actions that skip the wait for a still element, a lighter reset of the reused context, and stack traces that look up source maps for your own code only. |

A preset only lowers costs your config has: it never turns on traces, screenshots or video the config leaves off. An
option named beside the preset wins over it.

On the package's reference suite, against a typical unoptimized setup, `safe` took 4% off the wall time and 7% off the
CPU time, and `fast` 6% and 53%. Context reuse changed little there, a suite whose time is mostly waiting on its API. On
Flashwright's benchmark suites it took 15% and 4% off two app suites, changed nothing on one of very large pages, and
added 4% to a suite of trivial tests, where Playwright's reset of a context takes longer than a new context.

### Sign-in and third-party requests

These two need your paths and URLs, so no preset sets them.

- **`signIn: { storageState }`** adds a `setup` project that runs your `*.setup.ts` files, which save the signed-in
  state to `storageState`. Every other project depends on it and loads that state. Tests that change server-side state
  still need their own account or data. Keep the state file out of Git.
- **`blockRequests`** aborts the requests that match a glob, a regular expression or a predicate, typically
  third-party scripts that hold the `load` event. Routes a test adds with `page.route` run first. Never block a script
  the app needs. Like any route, it turns off Chromium's HTTP cache for the context.

## Context reuse

`fast` turns on Playwright's own context reuse (`reuseContext`), with a reset of what it leaves behind: offline mode,
extra HTTP headers, permissions, geolocation and HTTP credentials go back to the configured values, the CDP sessions
the test opened are detached, with what they set, and on Chromium the Cache Storage of every origin the test visited
is cleared as the next test starts. Playwright resets the rest: pages, cookies, storage, the HTTP cache, service
workers, routes, init scripts, bindings, the clock, the viewport and emulated media. `tests/e2e/reuse-isolation.ts`
checks each of them. The browser keeps the HTTP credentials it sent to an origin for the context's life: tests that
sign in to one origin with different credentials need `test.use({ reuseContextWithReset: false })` in their file.
Reuse happens through `@piwitests/turbo/test`, or `PW_TEST_REUSE_CONTEXT`, and needs video off. Turn it off with
`reuseContext: false`, for a suite of very short tests or very large pages.

## Advanced: the levers one by one

Every preset is a set of these options; name one to override it.

| Option               | What it does                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trace`              | The trace mode, e.g. `retain-on-failure` or `on-first-retry`.                                                                                                                                                                                                                                                                                                                                                    |
| `lightTraces`        | `true` keeps each action's DOM snapshot and leaves out the ARIA and screenshot snapshots and the screencast; `'actions'` leaves out the DOM snapshots too.                                                                                                                                                                                                                                                       |
| `failureScreenshots` | Screenshots a test's pages, and those of the contexts it opened, only when it fails, with the config's `fullPage` and `omitBackground`. With `only-on-failure`, Playwright captures every test and keeps the failed ones. It applies to the tests on `@piwitests/turbo/test`; a spec on `@playwright/test`'s `test` keeps Playwright's capture.                                                                  |
| `videoOnRetry`       | With retries, records video on the first retry instead of `retain-on-failure`, which records every test.                                                                                                                                                                                                                                                                                                         |
| `reducedMotion`      | Emulates `prefers-reduced-motion: reduce`. Leave it off for tests of animations.                                                                                                                                                                                                                                                                                                                                 |
| `instantAnimations`  | Chromium runs CSS and Web Animations 1000 times faster, whether or not the app honors reduced motion.                                                                                                                                                                                                                                                                                                            |
| `reuseContext`       | One browser context per worker, reset between tests (see above).                                                                                                                                                                                                                                                                                                                                                 |
| `compileCache`       | Node's compile cache for the test workers, in `node_modules/.cache/piwi-turbo-compile` (the temporary folder without `node_modules`) or the folder given; the web server and global setup the runner starts use it too. The runner loads Playwright before the config: set `NODE_COMPILE_CACHE` in the environment to cache its start too. Skipped when coverage is collected or a compile cache is already set. |

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
    fastStackTraces: true,
  },
});
```

- **`fastScreenshots`** (Chromium): adds CDP's `optimizeForSpeed` to PNG screenshots. The decoded pixels are the same;
  the files are larger (often 2–3×). `toHaveScreenshot` writes its baselines in the stock encoding, and a run with
  `--update-snapshots` keeps it throughout; a `page.screenshot()` a test compares with `toMatchSnapshot` is encoded for
  speed, also when it becomes the baseline.
- **`retryIntervals`**: the waits between the checks of Playwright's retry loop. Stock is `[20, 50, 100, 100, 500]` ms.
  Shorter waits pay where the UI settles between stock checks, and cost a round trip each.
- **`failFast`**: a failing web-first assertion ends once nothing can change the page before its timeout: no request
  in flight, and in no page of the context a timer due, interval, animation frame, socket, worker, broadcast channel,
  service worker it listens to, running animation or playing media, nor pending WebCrypto, IndexedDB, Cache Storage,
  file system, decoding or WebAssembly work. It shortens red runs and does nothing on a page that polls. It must stay
  off for a test that changes the page from its own Node code while an assertion waits, and for a page that waits on
  something else, such as another browser context or a browser prompt.
- **`skipStabilityWait`**: clicks, hovers, taps and drags stop waiting for the element to keep still. The visible,
  enabled and hit-target checks stay. Leave it off for apps that ignore input while they animate.
- **`fastReset`** (Chromium, with `reuseContext`): between tests, the storage of every origin the test visited, the
  tab's session storage included, is cleared through CDP once Playwright's reset has moved the tab to `about:blank`,
  where Playwright's reset loads each origin again to clear it. The mouse is moved away from the tab only after a test
  that used Playwright's mouse or touchscreen: input a test sends through its own CDP session is not seen.
- **`fastStackTraces`**: Playwright captures a stack of 50 frames for every API call, and source-map-support looks up
  a source map for each frame. The frames of Node and of `node_modules`, which have none, are formatted without the
  lookup; stack traces read the same.

The hooks wrap Playwright's server inside each test worker: the server `Page.prototype.reportAsNew` and
`BrowserContext.prototype.resetForReuse`, from the first page the frame class, the element handle class and Chromium's
CDP session, and the worker's `Error.prepareStackTrace`. They refuse to run, with an error that names the reason, on a
`playwright-core` version they were not tested with (`TESTED_VERSIONS`, currently 1.64.1), on an internal with another
shape, or when the browser runs outside the worker. `PIWI_TURBO_ALLOW_UNTESTED=1` runs them on another version, at
your own risk. What each lever was measured to save, and what was tried and dropped, is in the
[decision record](https://github.com/PiwiTests/piwi/blob/main/adr/turbo.md).

## The benchmark

`bench/` compares configurations by running whole commands of a suite, interleaved in rotating rounds, and reports
each against a baseline round by round with an interval, along with CPU (every process, Chromium included), peak
memory, artifact size, failures and where the test time went. Its reference workload is an orders console with a slow
API, third-party scripts, animations and a large table, tested by a suite of 42 tests.

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
