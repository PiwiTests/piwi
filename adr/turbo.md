# Faster Playwright runs without a fork

- Status: accepted
- Date: 2026-11-14

## Context

A Playwright suite in CI pays on every test for defaults that only some tests need: a trace, a screenshot and a video
recorded for every test and thrown away when it passes, a new browser context per test, animations played at their
real speed, a backoff between the checks of every assertion, a sign-in through the form per test, and third-party
scripts that hold the `load` event. [Flashwright](https://github.com/xcodebeast/flashwright), an Apache-2.0 fork of
Playwright 1.64.1, changes several of these defaults inside Playwright and reports 3.5× on its benchmark. A fork means
leaving `@playwright/test`, its browsers and its upgrades.

The question was how much of that a package can reach on stock Playwright, what it costs in test isolation, and how to
tell a real gain from noise.

## Decision

1. **A package, not a fork.** `@piwitests/turbo` (MIT, released with the monorepo) wraps a config with
   `withOptimizations(config, options)` and gives tests a `test` from `@piwitests/turbo/test`. It contains no Playwright
   or Flashwright code; the techniques it takes from Flashwright are credited in its README.
2. **Presets first, levers second.** `safe` changes nothing a test observes and only lowers costs the config already
   has; `fast` adds reduced motion, instant animations and context reuse; `max` adds every experimental hook. An option
   named beside a preset wins, and one left `undefined` keeps the preset's value.
3. **Public levers**: `trace`, `lightTraces`, `failureScreenshots`, `videoOnRetry`, `reducedMotion`,
   `instantAnimations`, `reuseContext` and `compileCache`. `signIn` and `blockRequests` need the suite's own paths and
   URLs, so no preset sets them.
4. **Experimental hooks** wrap Playwright's server inside the test worker: `fastScreenshots`, `retryIntervals`,
   `failFast`, `skipStabilityWait`, `fastReset` and `fastStackTraces`. They install only on the Playwright versions
   they were tested with, check the shape of every internal they wrap, and throw instead of falling back.
5. **Context reuse is Playwright's own `reuseContext` plus a reset of what it leaves**: offline mode, extra headers,
   permissions, geolocation and Cache Storage. A pair of end-to-end tests per kind of state a test can leave checks the
   next test starts without it, under Playwright's reset and under `fastReset`. Reuse stays in `fast` although it costs
   a suite of very short tests; the docs say when to turn it off.
6. **Keep only what measures well.** Every lever was measured before it shipped, and what did not pay was removed
   rather than documented. The list below is the record of what was tried.

### How it was measured

- **The package's benchmark** (`packages/turbo/bench`) runs whole commands, interleaves the configurations in the
  rounds of a balanced Latin square, and compares each with a baseline round by round, with a bootstrap interval. It reports wall time, the CPU
  time of every process (Chromium included), peak memory (PSS), artifact size, and where the test time went. Its
  reference workload is an orders console with a slow API, third-party scripts, animations and a 1,200-row table,
  tested by 42 tests.
- **Piwi's own suite**: one CI shard of 242 tests, 4 or 5 runs per configuration, with a local change to its fixtures
  that was not committed.
- **Flashwright's benchmark suites** (generated workloads such as 15 trivial tests, TodoMVC, a shop with saved
  sign-in and a slow API, and an inventory page of about 8,500 elements), run with Flashwright's own harness from its
  repository and an adapter kept outside this repository: 5 or 6 interleaved runs per configuration, each reported as
  its median against stock Playwright. Below, "1.20× vs 1.01×" compares a change with the build before it, both
  against stock.
- **Profiles**, for what remained: V8 CPU profiles (`--cpu-prof`) of the runner and the worker, timestamped CDP logs
  (`DEBUG=pw:protocol`) and Chromium traces.

The review before the first release found two flaws in the package's benchmark. Its CPU column left out Chromium's
renderers: the browser process exits before its zygotes, which the kernel then hands to PID 1 with every renderer's
CPU, and the full reference run measured 37 s of the at least 85 s its processes used. And with an even number of
configurations, its rotating rounds never changed their order. The benchmark now runs the command under a subreaper
and follows a balanced Latin square; the reference-workload figures below were measured again with it, but for the
one noted. Piwi's suite was not run again, so its CPU figures are left out.

### What shipped, and what it measured

| Lever | Measured |
|---|---|
| `signIn`, `blockRequests` | Reference workload: each took a run from 81 s to 48 s, measured before the benchmark's fixes. With trace `retain-on-failure`, reduced motion and four workers (`tuned`): 80 s to 16 s, CPU 84 s to 30 s, peak memory +39%. |
| `reducedMotion` | Reference workload: −3.9% wall, −46% CPU, −76% artifacts. |
| `lightTraces` | Reference workload, which traces every test: −3.0% wall, −46% CPU, −97% artifacts. |
| `trace: 'on-first-retry'`, `failureScreenshots` | Piwi's suite, measured before the benchmark's fixes: −13% wall with reduced motion, then −5% with failure screenshots. |
| Presets `safe`, `fast` | Reference workload against an unoptimized setup: −4.3% wall and −6.9% CPU; −5.8% and −53%. |
| `compileCache` | A single-test run started about 55 ms sooner with the cache set from the config, and 143 ms with `NODE_COMPILE_CACHE` set in the environment, which also reaches the runner. |
| `retryIntervals` | Reference workload: −6.0% wall, lower in all five rounds, for +3.2% CPU. |
| `fastScreenshots` | Flashwright's screenshot suite: `max` 1.34× against 1.14× without it. No measurable change on the reference workload, where screenshots are 2% of the test time. |
| `failFast` | Reference workload, red run of six failing assertions: −22% (25.2 s to 19.6 s), with the same failures and no false one. |
| `skipStabilityWait` | One worker: TodoMVC 1.11× vs 1.03×, Shop 1.20× vs 1.10×, Inventory 1.06× vs 0.99×. |
| `fastReset` | noop 0.93× vs 0.83×, TodoMVC 1.41× vs 1.21×, Shop 1.28× vs 1.27×. |
| `fastStackTraces` | noop 1.04× vs 0.96×, TodoMVC 1.37× vs 1.30×, Shop 1.28× vs 1.29×. |
| Per-test calls on a reused context (below) | `max`: noop 1.20× vs 1.01×, TodoMVC 1.44× vs 1.38×, Shop 1.32× vs 1.29×. |
| Context reuse in `fast` | TodoMVC 1.16× vs 0.99×, Shop 1.12× vs 1.07×, Inventory 1.02× vs 1.03×, trivial tests 0.91× vs 0.95×. |

The per-test calls came out of the profiles. Instant animations opened a CDP session on the kept tab for every test
with the Animation domain on; a reused context's sessions stay attached between tests, so they piled up, each
receiving every animation event. The rate is now set once per tab, with the domain off, through a session that stays
attached for the tab's life (a detach resets the rate). `fastReset` skips Playwright's mouse move away from a tab no
pointer acted in, a move that waits for the next frame.
`fastStackTraces` came from the same profiles: Playwright captures a 50-frame stack on every API call, and
source-map-support cloned and looked up a source map for every frame, those of Node and `node_modules` included.

As merged, after the review's fixes, each against stock on Flashwright's suites (5 runs):

| Suite | `max` | `max` without `fastReset` | `fast` | `fast` without reuse |
|---|---:|---:|---:|---:|
| 15 trivial tests | 1.14× | 1.02× | 0.91× | 0.95× |
| TodoMVC | 1.52× | 1.38× | 1.16× | 0.99× |
| Shop | 1.36× | 1.32× | 1.12× | 1.07× |
| Inventory | 1.10× | 1.07× | 1.02× | 1.03× |

### Tried and dropped

- **Differential DOM snapshots in traces**, from a fork of Playwright, shipped for a while as a vendored Apache-2.0
  script: no clear difference on the reference workload (+0.8%) or on Piwi's suite (−2.5% wall, interval −8.5% to
  +3.7%). Removed with the script and its license files.
- **Blocking images, fonts and media by resource type**: +12% CPU. Removed; blocking third-party URLs stays.
- **Running the longest test files first**: at four workers, Inventory 1.02× against 0.91× in one run and no change on
  TodoMVC, Shop and SVGOMG. The same build without it measured 0.91× and 1.02× on Inventory in two runs, so the one
  gain sits inside that spread. Not shipped.
- **`fastReset` that closes the tab after each test**: TodoMVC 1.14× against 1.29× with Playwright's reset. A new page
  per test costs most of what reuse saves.
- **`fastReset` that clears storage through CDP while the test's page is still loaded**: one TodoMVC test failed in 1
  of 6 runs, because the app saved to storage after the clear. `DOMStorage.clear` cannot reach session storage without
  a frame of its origin ("Frame not found").
- **`fastReset` that moves the tab to `about:blank` before clearing**: correct, but Playwright's reset navigates there
  again, and the gain was gone (noop 0.93× against 0.95×, TodoMVC 1.31× against 1.33×).
- **`fastReset` that seals the storage of the frames still on the visited origins before Playwright's reset** (clears
  their session storage and stops their writes), clears the rest in the reset's storage step, and hands a test that
  left an origin to Playwright's reset: it measured noop 0.93× against 0.83×, TodoMVC 1.41× against 1.21×. Review
  found that `Storage.clearDataForOrigin` with `local_storage` clears the tab's session storage too, also for an origin
  it left. The merged version clears everything in the reset's storage step, after its navigation, with no seal and no
  fallback.
- **Keeping `failFast`'s page script in a reused context for its life**: two round trips a test fewer, but a later test
  without `failFast` kept the wrapped timers and requests. Added for each test again.
- **Clearing Cache Storage as a test ends**: the test's page, or a service worker caching what Playwright's reset
  loaded, could write to it again before the next test, and a test that closed its last page left no page to clear it
  from. It is cleared as the next test starts, after Playwright's reset.
- **Skipping the page reset's second navigation to `about:blank`**: about 1.5 ms per test. The context reset navigates
  before it uninstalls a test's fake clock, whose init script then runs in that first `about:blank` document, which a
  next test that calls `setContent` without navigating would use. Not done.
- **Launch flags against the reset's mouse move** (`--disable-frame-rate-limit`, `--disable-gpu-vsync`): a move on
  `about:blank` takes one frame, 16.7 ms median, with or without them in headless Chromium, which has no switch left
  for frame-aligned mouse input.
- **A context pool**, in place of context reuse: while a test runs, the worker creates the context and page of the
  next test out of sight of Playwright's artifacts recorder, and hands them out as the next test starts, so every test
  still gets a new context with no reset. Traces, failure screenshots and isolation came out right. Against stock, on
  Flashwright's suites (5 runs): `fast` 1.14× with the pool against 1.00× with reuse on 15 trivial tests, 1.15×
  against 1.09× on the shop, but 1.05× against 1.18× on TodoMVC and 1.02× against 1.07× on the inventory page; `max`
  with the pool came out lower on three suites of four (TodoMVC 1.18× against 1.56×). Not profiled; the likely causes
  are that a new context loads the app again in a new renderer each test, where a reused tab keeps it, and that
  creating the next context competes with the running test for the CPU. Not shipped.
- **Clearing Cache Storage from a document of each origin** instead of through a CDP session: no measurable change on
  four suites (noop 0.89× vs 0.90×, TodoMVC 1.18× vs 1.16×, Shop 1.07× vs 1.08×, Inventory 0.95× vs 0.94×).
  Reverted to the simpler CDP session.

## Consequences

- **The hooks tie the package to the Playwright versions they were tested with** (1.64.1). A new version needs the
  hooks' end-to-end suite and the benchmark before it joins `TESTED_VERSIONS`; `PIWI_TURBO_ALLOW_UNTESTED=1` lets a
  user try one.
- **Context reuse widens what a test can leak to the next one.** The isolation pairs cover storage of every kind,
  Cache Storage a page or a service worker writes after the test, permissions, headers, offline mode, HTTP
  credentials, routes, init scripts, bindings, CDP sessions and what they emulate, the clock, the viewport, media,
  pages, service workers, hover state and animation speed; a new kind of state needs a new pair. The browser keeps the
  HTTP credentials it sent to an origin for the context's life, and `fastReset` does not see mouse input a test sends
  through its own CDP session.
- **`fast` is slower than stock on a suite of very short tests**, where Playwright's reset of a context (three
  navigations and a mouse move that waits for a frame) takes longer than a new context. Without the experimental hooks
  turbo cannot shorten that reset.
- **The gap to Flashwright stays.** Flashwright measured 1.8× to 3× stock on its suites here, turbo's `max` 1.1×
  to 1.5×. Per run of 15 trivial tests, most of the remaining CPU difference is Node loading Playwright's bundles: 409
  against 189 ms in the runner and 283 against 138 ms in the worker. A package cannot change how Playwright is
  bundled; a compile cache set in the environment shortens the runner's share.
- **`failFast` sees only what its tracker counts**: requests, timers, frames, sockets, workers, channels, animations,
  media, and pending crypto, storage, decoding and WebAssembly work in every page of the context. It must stay off for
  a test that changes the page from its own Node code while an assertion waits, or a page that waits on another
  browser context or a prompt. The hooks gain little on a suite whose time is mostly waiting on its API.
- **`failureScreenshots` applies to the tests on turbo's `test`**: a spec on `@playwright/test`'s keeps Playwright's
  capture, and Piwi's capture fixtures over turbo's `test` lose their screenshot of the page a failed test last acted
  on unless it is off.
- The benchmark lives in the repository, not in the npm package.
