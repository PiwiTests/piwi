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

### What it measured

Each configuration ran interleaved with stock Playwright, round by round, and the figures are medians of 5 runs on a
4-CPU Linux machine with Chromium. What a suite gains depends on where its time goes: measure yours with
[the benchmark](#the-benchmark).

Wall time against stock Playwright, on the suites of Flashwright's benchmark, one worker:

| Suite                                      | `fast` | `max` |
| ------------------------------------------ | -----: | ----: |
| 15 trivial tests                           | +10%   | −12%  |
| TodoMVC                                    | −14%   | −34%  |
| A shop with a saved sign-in and a slow API | −10%   | −27%  |
| An inventory page of 8,500 elements        | −2%    | −9%   |

On the trivial tests, `fast` is slower than stock: resetting a reused context takes longer than creating one when a test
does almost nothing. Turn reuse off for such a suite with `reuseContext: false`.

On the package's reference suite, 42 tests of an orders console against a typical unoptimized setup (a sign-in through
the form in every test, a trace of every test, the default worker count):

| Configuration                                                                  | Wall time   | CPU time, every process | Artifacts |
| ------------------------------------------------------------------------------ | ----------: | ----------------------: | --------: |
| `safe`                                                                         | −4%         | −7%                     | −100%     |
| `fast`                                                                         | −6%         | −53%                    | −100%     |
| `lightTraces` alone                                                            | −3%         | −46%                    | −97%      |
| `reducedMotion` alone                                                          | −4%         | −46%                    | −76%      |
| `signIn`, `blockRequests`, reduced motion, traces of failures and four workers | 80 s → 16 s | 84 s → 30 s             | −100%     |

What each experimental hook measured on its own, and how every figure was measured, are in the
[decision record](https://github.com/PiwiTests/piwi/blob/main/adr/turbo.md).

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

## A faster start: `piwi-turbo`

Playwright loads its own modules before it reads the config, and each test worker loads them again: most of a second
before the first test starts, however short the suite. `piwi-turbo` runs the Playwright of the current folder with that
start cut down, and passes every command and option on unchanged:

```sh
npx piwi-turbo test tests/checkout.spec.ts
```

- **Caches**: Node's compile cache, and a V8 code cache of Playwright's own modules that each process writes as it
  exits, so it holds the functions the run compiled as well as the top-level code. Both serve the runner and the Node
  processes it starts, from `node_modules/.cache/piwi-turbo` (`PIWI_TURBO_CACHE_DIR` names another folder). The first
  run fills them; the code cache of another Playwright or Node version is deleted. A folder other users can write to
  is not used.
- **A spare worker** (`test` only, not with `--ui`, `--list` or `--debug`): a Node process that loads Playwright while
  the runner reads the config and the tests, and becomes the first test worker. Playwright forks that worker as usual
  when the fork differs from what the spare was started with: other Node options or folder, or a change to a variable
  Node reads at start or Playwright read as it loaded, such as a config that sets `CI` or `NODE_OPTIONS`.

The saving is per command, so it shows on short runs: an edit-and-run loop, or an agent that runs one test at a time.
IDE extensions and tools that start `playwright` themselves don't go through it. A test can see two differences
from `playwright test`: the worker's `process.execArgv` loads the code cache, and the processes of the run have
`NODE_COMPILE_CACHE` and `PIWI_TURBO_*` variables. `PIWI_TURBO_CACHE=0` turns the caches
off, `PIWI_TURBO_SPARE_WORKER=0` the spare worker, and `PIWI_TURBO_DEBUG=1` says whether the spare was used and why
not. Wall time of whole commands with `max`, on the same suites as above (median of 5 runs, 6 for one test, the first
with an empty cache):

| Run                                 | `playwright test` | `piwi-turbo test`, caches only | `piwi-turbo test` |
| ----------------------------------- | ----------------: | -----------------------------: | ----------------: |
| One trivial test                    | 1,179 ms          | 902 ms                         | 722 ms            |
| 15 trivial tests                    | 1,792 ms          | 1,470 ms                       | 1,307 ms          |
| TodoMVC                             | 4,458 ms          | 4,296 ms                       | 4,128 ms          |
| A shop with a saved sign-in         | 6,431 ms          | 6,086 ms                       | 5,865 ms          |
| An inventory page of 8,500 elements | 12,180 ms         | 11,798 ms                      | 11,805 ms         |

An agent or a script that runs `node node_modules/@piwitests/turbo/dist/cli.js test` instead of
`npx piwi-turbo test` also saves the start of `npx`, about 200 ms on the same machine.

## Advanced: the levers one by one

Every preset is a set of these options; name one to override it.

| Option               | What it does                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trace`              | The trace mode, e.g. `retain-on-failure` or `on-first-retry`.                                                                                                                                                                                                                                                                                                                                                 |
| `lightTraces`        | `true` keeps each action's DOM snapshot and leaves out the ARIA and screenshot snapshots and the screencast; `'actions'` leaves out the DOM snapshots too.                                                                                                                                                                                                                                                    |
| `failureScreenshots` | Screenshots a test's pages, and those of the contexts it opened, only when it fails, with the config's `fullPage` and `omitBackground`. With `only-on-failure`, Playwright captures every test and keeps the failed ones. It applies to the tests on `@piwitests/turbo/test`; a spec on `@playwright/test`'s `test` keeps Playwright's capture.                                                               |
| `videoOnRetry`       | With retries, records video on the first retry instead of `retain-on-failure`, which records every test.                                                                                                                                                                                                                                                                                                      |
| `reducedMotion`      | Emulates `prefers-reduced-motion: reduce`. Leave it off for tests of animations.                                                                                                                                                                                                                                                                                                                              |
| `instantAnimations`  | Chromium runs CSS and Web Animations 1000 times faster, whether or not the app honors reduced motion.                                                                                                                                                                                                                                                                                                         |
| `reuseContext`       | One browser context per worker, reset between tests (see above).                                                                                                                                                                                                                                                                                                                                              |
| `compileCache`       | Node's compile cache for the test workers, in `node_modules/.cache/piwi-turbo-compile` (the temporary folder without `node_modules`) or the folder given; the web server and global setup the runner starts use it too. The runner loads Playwright before the config: [`piwi-turbo`](#a-faster-start-piwi-turbo) caches its start too. Skipped when coverage is collected or a compile cache is already set. |

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
your own risk. What each lever was measured to save is in the
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
still element, a reused, reset browser context, a code cache of Playwright's modules and a worker started before the
runner needs it. @piwitests/turbo applies them to stock Playwright at runtime instead of forking it. It contains no
Flashwright or Playwright code; both are Apache-2.0.

@piwitests/turbo is part of [Piwi](https://github.com/PiwiTests/piwi), and neither is affiliated with or endorsed by
Microsoft or the Flashwright project. Playwright is a trademark of Microsoft Corporation.

## License

MIT
