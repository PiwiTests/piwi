# Faster Playwright runs without a fork

- Status: accepted
- Date: 2026-11-15

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
   `failFast`, `skipStabilityWait`, `fastReset`, `fastStackTraces`, `screenshotMatches`, `keepStaticCache`,
   `earlyInjection` and `fastTraces`. They
   install only on the Playwright versions they were tested with, check the shape of every internal they wrap, and
   throw instead of falling back.
5. **Context reuse is Playwright's own `reuseContext` plus a reset of what it leaves**: offline mode, extra headers,
   permissions, geolocation and Cache Storage. A pair of end-to-end tests per kind of state a test can leave checks the
   next test starts without it, under Playwright's reset and under `fastReset`. Reuse stays in `fast` although it costs
   a suite of very short tests; the docs say when to turn it off.
6. **A command for the start: `piwi-turbo`.** Playwright loads its own modules before it reads the config, so no
   config reaches the runner's start. `piwi-turbo` runs Playwright's CLI in its own process once it has set up Node's
   compile cache and a V8 code cache of Playwright's modules, written as each process exits so it holds the functions
   the run compiled, for the runner and the Node processes it forks. For `test`, it also starts a spare worker that
   loads Playwright's bundles while the runner starts and stands in for the first worker fork, unless the fork's
   options, the Node options, the folder, or a variable Node reads at start or Playwright read while the spare loaded
   have changed by then. The spare also launches the headless Chromium the last run's first worker launched from the
   folder, with the options it recorded when they hold no credential, and the worker's first launch takes it when it
   asks for the same options and the variables the browser reads are unchanged. It changes the command, not the
   config, so it sits outside the presets. With `--warm`
   first, a daemon keeps one such runner loaded between commands, prepared for the caller's terminal, and gives a
   `test` command to it only when the variables the runner read as it loaded, the folder it read and Node's start-up
   variables are the caller's, its terminal included; requests carry a token from a file only the user can read.
7. **Keep only what measures well.** Every lever was measured before it shipped, and what did not pay was removed
   rather than documented. The list below is the record of what was tried.

### How it was measured

- **The package's benchmark** (`packages/turbo/bench`) runs whole commands, interleaves the configurations in the
  rounds of a balanced Latin square, and compares each with a baseline round by round, with a bootstrap interval. It reports wall time, the CPU
  time of every process (Chromium included), peak memory (PSS), artifact size, and where the test time went. Its
  reference workload is an orders console with a slow API, third-party scripts, animations and a 1,200-row table,
  tested by 42 tests.
- **Piwi's own suite**: one CI shard (shard 1 of 5: 242 tests at first, 244 by the last series), run as its CI runs
  it, 4 or 5 runs per configuration, with a local change to its fixtures that was not committed: turbo's `test` under
  Piwi's capture fixtures.
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
one noted. On Piwi's suite only `max` as a whole was measured again (below): the earlier series' CPU figures are left
out.

### What shipped, and what it measured

| Lever | Measured |
|---|---|
| `signIn`, `blockRequests` | Reference workload: each took a run from 81 s to 48 s, measured before the benchmark's fixes. With trace `retain-on-failure`, reduced motion and four workers (`tuned`): 80 s to 16 s, CPU 84 s to 30 s, peak memory +39%. |
| `reducedMotion` | Reference workload: −3.9% wall, −46% CPU, −76% artifacts. |
| `lightTraces` | Reference workload, which traces every test: −3.0% wall, −46% CPU, −97% artifacts. |
| `trace: 'on-first-retry'`, `failureScreenshots` | Piwi's suite, measured before the benchmark's fixes: −13% wall with reduced motion, then −5% with failure screenshots. |
| Presets `safe`, `fast` | Reference workload against an unoptimized setup: −4.3% wall and −6.9% CPU; −5.8% and −53%. |
| `compileCache` | A single-test run started about 55 ms sooner with the cache set from the config, and 143 ms with `NODE_COMPILE_CACHE` set in the environment, which also reaches the runner. |
| `piwi-turbo`, caches | Flashwright's suites with `max`, one worker, median of 5 runs (6 for one test) whose first starts with an empty cache: one trivial test 1,179 to 902 ms, 15 trivial tests 1,792 to 1,470, TodoMVC 4,458 to 4,296, Shop 6,431 to 6,086, Inventory 12,180 to 11,798. |
| `piwi-turbo`, spare worker | The same runs, against the caches alone: 902 to 722 ms, 1,470 to 1,307, 4,296 to 4,128, 6,086 to 5,865; Inventory unchanged (11,798 and 11,805). On a one-test run with a page, outside the harness (10 rounds): 1,295 ms stock, 907 with the caches, 651 with the spare. |
| `piwi-turbo`, early browser | One test that opens a page, `max`, 8 alternating runs: 600 to 542 ms; with `--warm` after a 1.5 s pause, 352 to 307 ms. A fresh process launches the headless shell in 40 to 48 ms, and creates its first context and page in 35 to 126 ms, which the early browser leaves to the test. |
| `screenshotMatches` | A passing `toHaveScreenshot` of a 1280×720 page spent about 40 ms of its 81 ms decoding the capture and the baseline. Median of 15 assertions: 81 ms stock, 88 ms with `fastScreenshots`, 39.5 ms with `screenshotMatches` (the stock capture has the baseline's bytes), 33.5 ms with both once the store knows the capture; on a page of gradients, 132, 101.5, 82 and 35 ms. Flashwright's screenshot suite, 15 tests against one baseline: `max` 3,658 ms without it and 3,019 ms with it (stock 4,611, 5 runs). |
| `keepStaticCache` | Piwi's own dashboard, built for production (a 490 KB entry script, 283 static responses on its home page, two public logos with a `Last-Modified` date only, requested with its cookie), 11 tests that each load its home page with a reused context: median page load 404–450 ms with Playwright's reset and 328–342 ms with the hook, over four rounds. A rule that took a cookie on the request as a sign of content tied to the user kept nothing there: the logos cleared the cache every time. |
| `piwi-turbo --warm` | The prototype, on Flashwright's suites with `max` after an untimed pause of 1.5 s before each run (5 runs, 6 for one test): one test 776 ms without it and 485 ms with it (stock 1,333, Flashwright 438); 15 trivial tests 1,460 and 1,119; on the app suites the saving, about 200 to 300 ms per command, was within run-to-run noise. As shipped, one test after the same pause (median of 8): 539 and 212 ms, and 773 and 431 ms for a test that opens a page. |
| `retryIntervals` | Reference workload: −6.0% wall, lower in all five rounds, for +3.2% CPU. |
| `fastScreenshots` | Flashwright's screenshot suite: `max` 1.34× against 1.14× without it. No measurable change on the reference workload, where screenshots are 2% of the test time. |
| `failFast` | Reference workload, red run of six failing assertions: −22% (25.2 s to 19.6 s), with the same failures and no false one. |
| `skipStabilityWait` | One worker: TodoMVC 1.11× vs 1.03×, Shop 1.20× vs 1.10×, Inventory 1.06× vs 0.99×. |
| `fastReset` | noop 0.93× vs 0.83×, TodoMVC 1.41× vs 1.21×, Shop 1.28× vs 1.27×. |
| `fastStackTraces` | noop 1.04× vs 0.96×, TodoMVC 1.37× vs 1.30×, Shop 1.28× vs 1.29×. |
| `fastReset`, the tab's second reset left out | On Flashwright's TodoMVC, Playwright's reset of a reused context took 31 ms, 17 of them in the tab's own reset: a second load of `about:blank`, then the viewport and media applied again, then the mouse moved away. Without the first two when the test changed neither, left no fake clock or WebAuthn credentials installed (their scripts leave the context only after its reset loaded `about:blank`, so that document still runs them), and the next test asks for the same context options: 14 ms, and the suite (one worker, 5 runs, `max`) 4,285 to 4,148 ms. |
| `earlyInjection` | Same app, one tab: the first fill after a navigation took 25 ms and the next 6 ms, the difference being Playwright creating its injected script in the document's utility world. Created as soon as the document's utility context exists: 9 to 11 ms, with the navigation 2 to 8 ms longer. TodoMVC (as above) 4,148 to 3,860 ms. |
| `fastTraces` | TodoMVC with `trace: 'retain-on-failure'` and no retries, so every test records: 6,030 to 5,303 ms (5 runs, `max`). |
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

On Piwi's own suite, as merged: one CI shard of 244 tests with its CI settings (two workers, the built server, two
retries), 5 interleaved rounds, each change the median of the per-round ratios against stock:

| | stock | `max` | `max` through `piwi-turbo` |
|---|---:|---:|---:|
| Wall time | 178 s | 137 s (−29%) | 126 s (−30%) |
| CPU time, every process | 518 s | 359 s (−32%) | 350 s (−33%) |
| Peak memory (PSS) | 3.2 GB | 5.6 GB (+79%) | 6.3 GB (+92%) |
| Flaky tests, over 5 runs | 0 | 3 | 1 |

Summed across the workers, navigation went from 121 s to 65 s, actions from 102 s to 74 s and the creation of browser
contexts from 6.8 s to 0.3 s. `piwi-turbo`'s saving, about half a second per process start, is within the noise of a
two-minute run: most of the 11 s between the two `max` medians is their flaky runs, each of which waited out a 30 s
assertion. The four flaky results were one test, which failed its first attempt in 4 of the 10 `max` runs and in none
of stock's: its page asked for a branch's newest coverage in the second between the server marking the branch's
earlier commit superseded and storing the newer commit's totals (issue #1464). A reused context with its static assets
cached loads the page fast enough to land in that window; a new context did not. At the run's peak, sampled by
process, the two Chromium renderers held 3.3 GB: with a reused context, each worker keeps one page, and so one
renderer, for the whole run. What `piwi-turbo` adds to the peak was not broken down.

### Tried and dropped

- **A new tab for each test in place of the reset of the old one**, as Flashwright's recycled context does: the reset
  took 27 ms, but the next navigation 82 to 90 ms instead of 30, in a renderer that had compiled nothing yet.
- **The injected script created early in both worlds**: the navigation took 13 ms longer than with the utility world
  alone, for no shorter first call; the main world is not where actions and assertions run. Running one selector query
  as well, to compile the paths an action takes, changed nothing measurable.

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

- **The workers' code cache switched on from the config**, which would have kept `playwright test` as the command:
  one trivial test 1,296 against 1,234 ms with `max` alone, 15 trivial tests 1,809 against 1,871. No measurable
  change: the saving is in the runner, which loads Playwright before any config.
- **A cheaper end of run for the HTML reporter**: it reads, hashes and copies every attachment, and copies the trace
  viewer, as the run ends. That took 82 ms of a 17 s run of the reference workload with a trace of every test (42
  traces, a 9.1 MB report), and 13 ms (46 ms with a trace) of a one-test run. Not worth a hook.
- **Returning before the teardown**: a one-test run spends about 65 ms between its last test's end and its exit. Most
  of it, about 52 ms, is Playwright stopping its workers, which it does before the reporters end and print the
  summary; a command that returned sooner would leave the summary out. What follows the reporters is about 13 ms.
- **`keepStaticCache` reading each response in the test's process**: a `response` listener on the context makes
  Playwright send every response of the run to the worker's client, 291 for one load of the dashboard, and that cost
  as much as the kept cache saved (median page load 412–486 ms with it, 424–472 ms without). The hook records the
  responses in Playwright's server instead.
- **Probing an element through `evaluateAll`**, in Piwi's capture fixtures: one locator resolution in place of the
  probe's own `locator.evaluate`, which takes 6–8 protocol commands. Locator healing cost 204 ms per test before and
  208 ms after, over three rounds of the reporter's capture benchmark alternating the two builds: the test does not
  wait on those commands.
- **A larger young generation** (`--max-semi-space-size=64`) for the runner and its workers: single-test runs came out
  slower.

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
- **Context reuse trades memory for time.** Each worker keeps one page, and so one renderer, for the whole run: on
  Piwi's suite, whose pages are large, each grew to about 1.6 GB, and `max` raised the run's peak memory by 79%. A
  suite whose machines are short of memory turns `reuseContext` off.
- **`fast` is slower than stock on a suite of very short tests**, where Playwright's reset of a context (three
  navigations and a mouse move that waits for a frame) takes longer than a new context. Without the experimental hooks
  turbo cannot shorten that reset.
- **The gap to Flashwright narrows on short runs only.** Flashwright measured 1.8× to 3× stock on its suites here,
  turbo's `max` 1.1× to 1.5×. Per run of 15 trivial tests, most of the remaining CPU difference was Node loading
  Playwright's bundles: 409 against 189 ms in the runner and 283 against 138 ms in the worker. A package cannot change
  how Playwright is bundled; `piwi-turbo` caches the compiled bundles and loads the first worker's ahead. In the
  series that measured it (stock 2,074 ms for 15 trivial tests and 1,152 ms for one), it took `max` from 1.16× to 1.59×
  stock on the 15 tests and from 0.98× to 1.59× on one, where Flashwright measured 2.3× and 3.1×. Its saving is per
  command, so a long suite gains a few percent. Starting it through `npx` adds about 200 ms (`npx playwright
  --version` 770 to 932 ms against 564 to 690 ms with `node`, 3 runs each).
- **An early browser is used only when nothing it was launched with has changed**: the launch options, and the
  variables the browser reads (time zone, locale, home and temporary folders, display, fonts, proxies, certificates,
  paths, and the Playwright variables that change how it finds or launches the browser). Variables outside that list
  are not compared, since the browser does not read them. Its launch is not a step of the `browser` fixture, and a
  worker that never launches closes it after a minute.
- **`piwi-turbo` helps only the runs that go through it**: IDE extensions and tools that start `playwright`
  themselves do not. The spare worker relies on Playwright's worker entry (`lib/worker/workerProcessEntry.js`), the
  options of its worker fork and the variables it adds (`PLAYWRIGHT_TEST`, `FORCE_COLOR`, `DEBUG_COLORS`); when one of
  them differs, Playwright forks as usual. The code cache replaces `Module.prototype._compile` for Playwright's own
  files, with a `require` built as Node builds it.
- **`failFast` sees only what its tracker counts**: requests, timers, frames, sockets, workers, channels, animations,
  media, and pending crypto, storage, decoding and WebAssembly work in every page of the context. It must stay off for
  a test that changes the page from its own Node code while an assertion waits, or a page that waits on another
  browser context or a prompt. The hooks gain little on a suite whose time is mostly waiting on its API.
- **`earlyInjection` creates the injected script before the page's own scripts run**: its listeners on the window come
  before the page's, which a page sees only when an action's hit-target check stops an event, and a document no call
  reaches pays for the script. A selector engine or test id attribute registered after the navigation and before the
  first call gets a new script at that call, as Playwright creates it then.
- **`failureScreenshots` applies to the tests on turbo's `test`**: a spec on `@playwright/test`'s keeps Playwright's
  capture, and Piwi's capture fixtures over turbo's `test` lose their screenshot of the page a failed test last acted
  on unless it is off.
- The benchmark lives in the repository, not in the npm package.
