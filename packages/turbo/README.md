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
| `max`  | `fast`, plus every experimental hook but `keepStaticCache`: faster PNG encoding, a shorter retry backoff, assertions that fail once the page is idle, pointer actions that skip the wait for a still element, a lighter reset of the reused context, stack traces that look up source maps for your own code only, screenshot assertions that pass a known capture without decoding it, Playwright's injected script created while a page loads, and traces that do not request the script bodies they leave out. |

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

On one CI shard of Piwi's own dashboard suite, 244 tests run as its CI runs them (two workers, two retries), `max`
with `keepStaticCache` took the wall time from 178 s to 137 s and the CPU time from 518 s to 359 s, and raised peak memory from 3.2 GB to
5.6 GB (see [context reuse](#context-reuse)).

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
Reuse happens through `@piwitests/turbo/test`, or `PW_TEST_REUSE_CONTEXT`, and needs video off. Each worker keeps one
page, and so one browser renderer, for the whole run: on Piwi's own suite, whose pages are large, each grew to about
1.6 GB. Turn reuse off with `reuseContext: false` for a suite of very short tests, for very large pages, or on a
machine short of memory.

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
- **An early browser**: the spare launches the headless Chromium the last run's first worker launched from the same
  folder, with the same options, recorded in the cache folder when they can hold no credential (no proxy, `env` or
  logger). The worker's first launch takes it when it asks for the same options and the variables the browser reads
  (time zone, locale, home and temporary folders, display, fonts, proxies, certificates, paths, and Playwright's and
  Selenium's own) have not changed, as when the config sets `TZ`;
  otherwise the early browser is closed and the worker launches its own. One no launch takes is closed after a minute.
  A run of one test that opens a page took 542 ms in place of 600 ms.

The saving is per command, so it shows on short runs: an edit-and-run loop, or an agent that runs one test at a time.
IDE extensions and tools that start `playwright` themselves don't go through it. A test can see two differences
from `playwright test`: the worker's `process.execArgv` loads the code cache, and the processes of the run have
`NODE_COMPILE_CACHE` and `PIWI_TURBO_*` variables, and an early browser's launch is not a step of the
`browser` fixture. `PIWI_TURBO_CACHE=0` turns the caches off, `PIWI_TURBO_SPARE_WORKER=0` the spare worker,
`PIWI_TURBO_EARLY_BROWSER=0` the early browser, and `PIWI_TURBO_DEBUG=1` says whether the spare and its browser were
used and why not. Wall time of whole commands with `max`, on the same suites as above (median of 5 runs, 6 for one test, the first
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

### A warm runner: `--warm`

```sh
npx piwi-turbo --warm test tests/checkout.spec.ts
```

The first such command starts a process in the background that keeps one runner loaded, with its spare worker; the
next `test` commands go to it, one runner each, and it readies another after each. A runner takes a command only when
it loaded for the caller's terminal (its width, height and colors, or none), folder and `PIWI_TURBO_*` variables, and
for the variables it read or Node reads at start; otherwise the command runs in its own process, as without `--warm`,
and the next runner loads for it. Watch mode and Node options on the command (`node --inspect`) always run that way.
Ctrl+C reaches the run. The process exits after ten minutes with no run and no request, and
`npx piwi-turbo --warm-stop` stops it once its runs have stopped.

A request carries a token that the process writes, with its address, to a file only you can read, in a folder only you
can write to; on Windows it listens on a pipe with a name no one can guess, and relies on the temporary folder being
yours alone, as it is by default. On a run of one test, after a pause as when you edit between runs (median of 8, run
with `node` rather than `npx`): 539 ms without `--warm` and 212 ms with it, and 773 ms and 431 ms for a test that
opens a page. The runner's spare launches its early browser while the runner waits for a command: on another machine,
the test that opens a page took 307 ms in place of 352 ms.

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

`max` turns these on, all but `keepStaticCache`; name them under `experimental` to pick some, or set one for a file
with `test.use()`.

```ts
withOptimizations(config, {
  experimental: {
    fastScreenshots: true,
    retryIntervals: [10, 20, 40, 50],
    failFast: true,
    skipStabilityWait: true,
    fastReset: true,
    fastStackTraces: true,
    screenshotMatches: true,
    keepStaticCache: true,
    earlyInjection: true,
    fastTraces: true,
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
  that used Playwright's mouse or touchscreen: input a test sends through its own CDP session is not seen. The tab's
  own reset, which loads `about:blank` a second time and applies the viewport and media again, is left out when the test
  changed neither, left no fake clock or WebAuthn credentials installed, and the next test asks for the context options
  the last one had (a file's own `viewport` or `colorScheme` brings it back): a reset took 14 ms in place of 31 ms, and
  Flashwright's TodoMVC suite 3% less time.
- **`fastStackTraces`**: Playwright captures a stack of 50 frames for every API call, and source-map-support looks up
  a source map for each frame. The frames of Node and of `node_modules`, which have none, are formatted without the
  lookup; stack traces read the same. With another experimental hook on, which puts Playwright's server classes
  within reach, the server's race of every evaluation in a page against its context's destruction captures no stack:
  it formats one through source-map-support in case it must clone that error, but the client gives a failed call the
  test's own frames, so the test's errors read the same, and a trace records the server's error without Playwright's
  internal frames. Where Playwright shows them (`PWDEBUGIMPL`), the race keeps its stack. TodoMVC took 6% less time,
  SVGOMG 4%.
- **`screenshotMatches`**: Playwright decodes the capture and the baseline of every screenshot assertion to compare
  them, about 40 ms for a 1280×720 page. A capture whose bytes are the baseline's, or those of a capture that matched
  the same baseline with the same options before, passes without that; any other is compared as Playwright compares
  it. The captures that matched are remembered by hash in `node_modules/.cache/piwi-turbo` (the cache folder of
  [`piwi-turbo`](#a-faster-start-piwi-turbo)), so with `fastScreenshots`, whose bytes differ from the baseline's, an
  assertion gains from its second run on. A passing assertion took 33 ms in place of 81 ms with both hooks on.
- **`keepStaticCache`** (with `reuseContext`, not part of `max`): Playwright's reset clears the browser's HTTP cache, so
  each test downloads and compiles the app's scripts again. The reset leaves the cache when what the context received
  since the last reset holds nothing the browser could serve again without asking the server but static assets: a
  response marked `immutable`; an image, font, stylesheet, script, WebAssembly module or media file with no lifetime of
  its own or one of a week or more; any other response fresh for a week whose request carried no cookie or credentials;
  none of them private, setting a cookie or varying with one. Anything else the browser could reuse clears the whole
  cache, as stock: an API response or a stylesheet with a short lifetime, a permanent redirect, a page with an `Expires`
  date. A file the app changes at the same URL between tests, served with a `Last-Modified` date and no lifetime (an
  avatar, a stylesheet for each user), reaches the next test as it was: leave the hook off for such a suite. A request
  still waiting for its response at the reset clears the cache too, and so does a response the browser received that no
  page, worker or service worker received (a fetch aborted as its headers arrive, one a document makes as the reset
  replaces it), and a favicon the browser could serve again, which Playwright reports no event for. Only Chromium's own
  network events show those, so on other browsers the cache is always cleared. A request a document starts in
  `pagehide`, `unload` or `visibilitychange` shows in none of them: leave the hook off for a page that fetches a
  cacheable response then. On Piwi's own dashboard, a page load took 328–342 ms in place of 404–450 ms.
- **`earlyInjection`** (Chromium): Playwright's actions and assertions run through an injected script of about 180 KB,
  which it creates in each new document at the first call. The script and its utility script are created in the
  tab's new document as soon as it has a context, while the document loads: the first fill after a navigation took 9
  to 11 ms in place of 25 ms, the navigation a few milliseconds longer, and Flashwright's TodoMVC suite, whose tests
  each start on a new document, 7% less time. A document that gets no call pays for the script anyway. A selector
  engine or test id attribute registered after the navigation is seen, as without the hook; the script's listeners on
  the window are added before the page's own, which a page can tell apart only when an action's hit-target check
  stops an event.
- **`fastTraces`**: a trace that records DOM snapshots leaves out the bodies of scripts unless it is live, and Playwright
  requests each one from the browser before leaving it out, which holds up the page's load. Those bodies are not
  requested; the trace is the same, `response.body()` still reads them, and a HAR recording keeps them. On Chromium, the
  DOM snapshot a trace takes after each call, and before most actions, assertions and evaluations, is left in flight
  rather than awaited, unless the trace also records screenshots, aria snapshots or coverage. Navigation, closing a
  page or context, the page's keyboard, mouse and touchscreen, screenshots, viewport and media changes, CDP sessions
  and the trace's stop wait for the snapshots in flight, each for 3 s at most, and the snapshot right before an
  action's input is awaited as Playwright does. The trace holds the same calls and snapshots. TodoMVC with a trace of
  every test (`retain-on-failure` without retries) took 12% less time for the script bodies, and 8% less again for the
  snapshots; SVGOMG 6% less for the snapshots.

The hooks wrap Playwright's server inside each test worker: the server `Page.prototype.reportAsNew`,
`Page.prototype.expectScreenshot`, `Page.prototype.resetForReuse`, `BrowserContext.prototype.setStorageState` and
`BrowserContext.prototype.resetForReuse`, a context's `response` events, from the first page the frame class, the
element handle class, Chromium's CDP session and the trace recorder, from the first document the execution context
class, and the worker's `Error.prepareStackTrace`. They refuse to run, with an error that names the reason, on a `playwright-core` version they
were not tested with (`TESTED_VERSIONS`, currently 1.64.1), on an internal with another shape, or when the browser runs
outside the worker. `PIWI_TURBO_ALLOW_UNTESTED=1` runs them on another version, at your own risk. What each lever was
measured to save is in the
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
still element, a reused, reset browser context, a lighter reset of its tab, Playwright's injected script created while
a page loads, traces that skip the script bodies they leave out, a code cache of Playwright's modules and a worker
started before the runner needs it. @piwitests/turbo applies them to stock Playwright at runtime instead of forking it. It contains no
Flashwright or Playwright code; both are Apache-2.0.

@piwitests/turbo is part of [Piwi](https://github.com/PiwiTests/piwi), and neither is affiliated with or endorsed by
Microsoft or the Flashwright project. Playwright is a trademark of Microsoft Corporation.

## License

MIT
