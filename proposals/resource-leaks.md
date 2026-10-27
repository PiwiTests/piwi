# Resource leaks and waste

A plan to find the browsers, contexts and pages a Playwright suite keeps open for nothing, measure what they and the
rest of a run cost in CPU and memory, and hand back the line to change. Playwright closes what its own fixtures create
at the end of each test. Everything else a test, a hook or a fixture opens stays alive until its worker exits, and a
worker runs many files. Playwright also launches Chromium with background throttling turned off, so a forgotten page
that polls or animates keeps a CPU busy at full speed through every test that follows it.

Piwi already sits where these objects are born: the capture fixtures wrap `browser.newContext`, `context.newPage` and
every `close`, and their auto fixture tears down after Playwright's own `page` and `context`. This plan turns that
position into a **ledger** of every object's birth, use and death, a **measured cost** per test and per run, and
**findings** that name a call site, a fixture or a config line, each with its fix.

**Status.** Proposed 2026-10-01. A prototype of the ledger and of both samplers ran on Playwright 1.63 against a
deliberately leaky suite and a page closer to an application, and every metric source in Part 2 was read and timed on
the same machine; the results are in [What we measured](#what-we-measured). **PR 1 built 2026-10-01**: the ledger in
the capture fixtures and the dogfood mirror, the `piwi-resources` census, the verdicts and the end-of-run summary in the
reporter (also written to the GitHub job summary), the fixture-free tier, `captureResources` and `leakCheck`, a
Resource leaks docs page, and an integration suite where each leaky test must produce exactly its finding and the clean
ones none. What changed while building PR 1:

- The worker-end census is taken by the `piwiResources` worker fixture alone: it tears down after the `browser`
  fixture, so it sees what the worker's shutdown closed, and no `close` wrapper is needed. Each worker appends it to
  the file the reporter names in `PIWI_RESOURCES_RESULTS` before any worker starts.
- An object a later test or hook of the same file closes is handed on, not leaked; one closed by a test of another
  file is leaked. A describe-scope leak is held from the last test of the describe block of the test that ran its hook.
- What a failed test left open is not judged: Playwright shuts the worker down right after it, and `fail` would add a
  second error to a test that already failed.
- A page is used when it navigates or loads, when it runs an `evaluate`-family call the test made, or when a locator is
  built on it; Piwi's own reads are internal calls and never count.
- Node handles are servers and file watchers (`TCPServerWrap`, `FSEventWrap`, `StatWatcher`): sockets, child
  processes and timers move on every test with Playwright's own. A server reports a second handle until one timer tick
  after it starts listening, so a test whose count grew is read again a tick later.
- `leakCheck` judges a test when it ends, and Playwright exposes nothing there that tells a serial hand-over apart: a
  test that hands what it opened to the next one fails under `fail` and loses it under `close`. D8's "never shared"
  holds for `beforeAll` objects, which the gate leaves alone.
- A warning annotation at each leak's line waits for PR 4, where only the leaks a branch introduces are flagged.

**PR 2 built 2026-10-01**: the run sampler in the reporter, artifact sizes, the per-test reads in the workers, the CDP
reads of pages that outlive their test, and the machine panel after the summary, with a CPU, memory & disk docs page
and a `resources` rung in the bench. What changed while building PR 2:

- Nothing new leaves the machine: the machine facts feed the panel and travel with the run's profile in PR 3, rather
  than going into the run's metadata now.
- The sampler scans `/proc` every second (about 2 ms of CPU with a browser running) and reads PSS, the container
  and the disk every five (about 30 ms): under 1% of one core. A worker reads its process tree once per test, at its
  end (about 2 ms), and that read starts the next test's window; a worker that never started a browser skips it. macOS reads the tree through `ps` every five seconds and counts RSS. Windows measures the machine and the
  disk, and reads the tree through a PowerShell CIM query every fifteen seconds (built 2026-10-03).
- The web server is whatever the runner starts that is not a worker, a browser or ffmpeg: the runner does not expose
  the pid of `webServer`'s command, and a `globalSetup` server counts the same way.
- A leaked page's cost is its main thread's task time over CDP (`TaskDuration` in thread ticks), not its renderer's
  process CPU, which the pages a renderer hosts share. It is shown from half a second: a static page logs about
  0.1 s of background tasks over a few seconds.
- The container's peak counts from the container's start, so the panel names it only when the run raised it.
- Artifact sizes are what the tests attached: `preserveOutput` can delete them after the run.
- Each test's reads (the worker's CPU, event loop, switches, heap and descriptors; on Linux the CPU, run-queue wait
  and peak RSS of each browser process by role) go into its census for PR 3's wire; the panel prints the workers'
  event loop and switches.
- Not read yet: device I/O (`diskstats`, PSI `io`, `io.stat`), major faults and swap, descriptors of the browser
  processes, PSS by kind, bytes per page, CPU by role over CDP outside Linux, and `PIWI_CAPTURE_RESOURCES=full`.

**PR 3 built 2026-10-01**: the wire, storage, the run's Resources tab, each execution's cost, the `resources`
capability, a leaky run in the demo seed and in the run simulator, and the docs. What changed while building PR 3:

- A run stores its report as one JSON value, `test_runs.resource_report`, with one part per reporter: a sharded run
  gets one per shard, each measured on its own machine, and a retried finish replaces its shard's part. Finding rows
  with fingerprints wait for PR 4, which needs them for the history; until then `shared/resource-report.ts` rebuilds
  every incoming report field by field, bounded, and the server and the demo share it.
- An execution stores its cost in `test_runs_cases.resources`: the worker's CPU, event loop, switches and heap, the
  CPU, run-queue wait and peak RSS of each browser role (Linux), the pages already open when it started, what it left
  open, and its artifact sizes.
- The report travels with `finish` (and with a whole-run submit or upload), not as the run streams: the verdicts need
  every census, including each worker's last. Each execution's cost travels with its test.
- Bounded on the wire: 100 findings, most severe first, 240 points of the CPU series, 200 points of each worker's open
  pages.
- The execution's cost sits in its Performance evidence tab, above the Web Vitals.
- `resources` is a passive-data capability, as the Test Map is: declining it hides the tab and the cost even though the
  data still arrives.
- The demo's leaky run is Web Dashboard's newest: a login fixture leaves a context open per test, a page fixture is
  never used, listeners pile up on a worker-scoped page and a test leaves a server running. The run before it is clean,
  for comparison. The simulator's **Leaky run** replays the same story on `e2e-checkout`, from the same builder
  (`shared/demo/demo-resources.mjs`); its report lands with `finish`.

**PR 4 built 2026-10-01**: finding history and fix verification, the gate's leak rules, the pull-request line, two MCP
tools, and each finding's history on the Resources tab. What changed while building PR 4:

- A finding's identity is where it was opened, line included, so each opening line is its own finding and counts on
  its own in the gate. A finding that shows under a new identity while an open finding of the same identity without
  line numbers no longer shows has moved with an edit above its line: it takes that finding's history and is not new;
  the closest lines pair first. (A first version dropped line numbers, which folded every leak of a file into one.) A
  pull request that fixes one leak and opens another in the same file reads as a move. The identity is plain JS
  (`shared/resource-fingerprint.mjs`), so the demo seed writes the same rows the server does.
- Each shard's report is its own row (`test_run_resource_reports`), written whole by its finish. A first version kept
  one JSON value per run that each finish read, merged and wrote back, so two shards finishing at once could lose one
  shard's report.
- Runs are ordered by start time, not by id: an imported run can be older than runs stored before it.
- A clean run vouches for a finding only when it is a full run of the default branch (a run with no branch counts as
  one) whose report could have shown it: with the fixtures on, or any report for a probable leak. The first of the five
  is recorded as the run that fixed it.
- "New" is read against the base branch (the pull request's target, else the default branch) from the run's own report
  and earlier runs' occurrences, so the gate and the comment do not wait for the run's history to be recorded.
- `--max-leaks` and `--max-new-leaks` count leaked and probable findings, one per opening line. A leak rule on a run
  that sent no resource report is a violation.
- The pull-request comment lists new leaks only; idle pages and piling owners stay on the tab until PR 6's waste
  findings.
- The demo's three runs before the leaky one now carry the server a test leaves running, so that finding's history
  spans four runs while the leaky run's own findings are new.
- Not built: the daily rollups for analytics, and per-finding notifications.
- The bench's `resources` rung measured +15 ms and +0 ms per test over `full` in two runs of four rounds (1.3% and
  0%), inside the 3% the Verification section sets.

**Part of PR 7 built 2026-10-02 and 03** (optional): each worker row of the run's timeline draws its sampled CPU,
memory and open pages, and the Resources tab's open pages point at it. **Live bands built 2026-10-26**: while a run
is open on the dashboard, the same bands and strips fill in as it runs, instead of waiting for its end, and each
running test on the Tests tab shows its worker's last cores, memory and open pages beside its step (D13). **The
failure timeline's resource rows built 2026-10-26**: a failed execution's Timeline tab draws, behind a **Resources**
switch kept per browser and off by default, the CPU and memory of the worker that ran it with its browsers and the
pages open in that worker, sliced from the run's stored report (`shared/timeline-resources.ts`), with the pages
earlier tests left open and its browsers' wait for a CPU. Not built: the leak tails, the pressure strip, the
machine's CPU on the failure timeline, and the lane of the births and closes inside the test. PRs 5 and 6 are not
started.

**Detection extended 2026-10-26**, measured on a 60-test suite on one worker before each rule was set:

- Servers and child processes are tracked one by one: the ledger wraps `net.Server.prototype.listen` and
  `ChildProcess.prototype.spawn` in each worker (put back at its end) and records the line and the runnable as it
  does for a context. This fixed a false positive: a worker-scoped fixture that starts a server is set up inside the
  census window of the first test that asks for it (auto fixtures come first), and the handle count blamed that test.
  A child process a test leaves running (`spawn`, `exec`, `fork`; Playwright's browsers and `ffmpeg` left out) is a
  new `handle` finding, named by the line that started it. File watchers keep the count.
- Piling up allows a dip: besides the series that never goes down, a series whose floor (the lowest reading from
  each census on) rose by the rule's amount by three quarters of it, a quarter of that by its middle.
- New piling series: attached DOM elements of a page that outlives its test (`document.getElementsByTagName('*')`
  over its DevTools session; CDP's `Nodes` counts detached nodes until Blink collects them, and climbed from 165 to
  25,341 on a page that only replaced its content), and per worker its open file descriptors and its heap after a
  full garbage collection, read from V8's own `gc` performance entries. The heap at the end of a test is no signal:
  it rose 30 MB over 60 clean tests, while after a forced collection plain Playwright kept 1.6 MB over 80 tests and
  Piwi's capture 2.7 MB. A worker keeping 30 MB a test showed 143 → 602 → 1,852 MB over the three full collections
  V8 ran in 60 tests. What tests that left something open added is left out of the worker's series, since each of
  those is a finding already. Wire: `growth.what` gains `elements`, `heapMb` and `descriptors`, `kind` gains `worker`.
- The ledger drops a closed object once a census reported it (about 0.7 KB of worker heap per test).

## What the reader gets

At the end of a local or CI run, from the reporter alone:

```
[Piwi Dashboard] Resources · 3 leaks · 41 idle pages · peak 1.4 GB · 96 CPU-s on 4 cores
  leaked  context  tests/cart.spec.ts:18           12 tests · open 6 m 10 s after them · 38 CPU-s after their tests ended
  leaked  browser  tests/export.spec.ts:9          chromium.launch() · 212 MB until worker 2 exited
  piling  page     popup after locator.click        worker fixture "adminPage" (tests/fixtures.ts:30) · 1 → 31 pages
                   tests/admin.spec.ts:44
  idle    page     auto fixture "consoleCollector"  41 API tests opened a page they never used (tests/fixtures.ts:12)
  Details: https://piwi.example.com/test-runs/1842?tab=resources
```

On the run page, a Resources tab:

```
Run #1842 · Resources                         peak 1.4 GB (PSS) at 04:12 · 96 CPU-s · 4 workers · 4 cores · 16 GB
  Open pages per worker   w0 ▁▂▃▄▅▆▇█ 1 → 14    w1 ▁▁▁▁▁▁▁▁ 1    w2 ▁▁▂▂▃▃▄▄ 1 → 8    w3 ▁▁▁▁▁▁▁▁ 1
  Leaks                              kind     tests   open after test   CPU after test   first seen
    tests/cart.spec.ts:18            context  12      6 m 10 s          38 s             4 runs ago
    tests/export.spec.ts:9           browser  1       3 m 02 s          4 s              this run
  Piling up
    worker fixture "adminPage"       pages 1 → 31 · page.route handlers 1 → 31 · listeners 2 → 33
  Waste
    41 tests opened a page they never used — auto fixture "consoleCollector" (tests/fixtures.ts:12)
    project "api": chromium launched in 4 workers for 120 tests; 112 never opened a page
    trace: 'retain-on-failure' traced 640 tests to keep 2
  CPU by role   renderer 41 s · browser 22 s · worker 18 s · webServer 11 s · gpu 3 s · ffmpeg 1 s
```

On the same tab, the machine the run had:

```
Machine · 4 vCPU · 16 GB · container limit 14 GB · steal 1.5%
  CPU      ▁▃▆█████▇▆▃▁  busy 92% · a task waited for a CPU 79% of the time · renderers waited 39 s in total
  Memory   peak 1.6 GB (PSS) at 00:21 · 11% of the limit · largest process: worker 251 MB · no memory pressure
  Disk     145 MB kept (traces) · 430 MB in use at the peak · 13.9 GB free at the low point
  Worker   event loop busy 28% · p99 delay 181 ms · 2,100 involuntary context switches per test
```

On a failing execution, a clue:

```
⚠ Pages left open in this worker                                              medium
  14 pages earlier tests left open were alive while this test timed out; their renderers used 2.1 s of CPU
  during it. 12 of them come from tests/cart.spec.ts:18, a context that is never closed.
```

In the editor, at the line that creates the leak:

```
18 │   const context = await browser.newContext();
   │         ~~~~~~~ Never closed: open about 6 minutes after its test in each of the last 5 runs (Piwi)
   │                 Quick fix: Close it at the end of the block (await using)
```

In CI:

```
$ npx @piwitests/reporter gate --max-new-leaks 0
✗ 1 new leak on this branch: a context created at tests/cart.spec.ts:18 is never closed
```

- Part 1 gives the ledger and its findings in the console, with the capture fixtures only. No server change.
- Part 2 adds the metrics: CPU, memory and disk for the run (from the reporter alone), for each test and each page
  (from the fixtures), with what each costs to read on each platform.
- Part 3 adds the waste findings: idle pages, browser projects that run browserless tests, tracing and video modes,
  the web server, worker restarts, machine size.
- Part 4 stores findings with a history and puts them where Piwi already speaks: the run page, the failure clues, the
  flake profile, the gate, the pull-request comment, the editor and MCP.

## What we measured

The prototype is a worker-scoped auto fixture that adds one listener to Playwright's client instrumentation, a test
auto fixture that takes a census at each test boundary, and a reporter that stitches the censuses and samples the
process tree. It ran on a 4-vCPU, 16 GB Linux VM with Node 22, Playwright 1.63.0 and Chromium 153 (headless shell).

**Every planted pattern was found, at its line.** One file per pattern, one worker, run in order:

| Planted pattern | What the ledger reported |
|---|---|
| `browser.newContext()` never closed | context and page outlived their test (`b-context.spec.ts:4`, `:5`) |
| `browser.newPage()` never closed | the page and the context it owns (`c-newpage.spec.ts:4`) |
| `beforeAll` context, no `afterAll` | context and page outlived their describe block (`d-beforeall.spec.ts:8`, `:9`) |
| `beforeAll` context closed in `afterAll` | nothing |
| `request.newContext()` never disposed | API request context outlived its test (`e-request.spec.ts:5`) |
| `chromium.launch()` never closed | a second browser, its context and page (`f-launch.spec.ts:5`, `:6`) |
| test asks for `page`, calls only `request` | idle page, made by fixture `page` |
| auto fixture on `page`, three API tests | three idle pages; the culprit named: fixture `consoleCollector` (`h-auto-fixture.spec.ts:5`) |
| popups from a worker-scoped page | "popup of page #3 after `locator.click` at `i-shared-page.spec.ts:24`"; open pages 2 → 5, Node-side listeners 3 → 6, `page.route` handlers 1 → 4 over four tests |
| HTTP server and interval left in the worker | `+1 TCPServerWrap`, `+1 Timeout` after the test |
| `setContent` page; `evaluate`-only page | not idle |

**Leaked pages keep burning CPU after their test.** Three clean one-second tests ran last in the worker. The browser
used 420–480 ms of CPU during each, and 340–360 ms of that went to the renderers of pages earlier tests had left open,
mostly the polling page from about fifteen tests before. The worker's browser processes grew from 123 MB to 346 MB
(PSS) as the leaks accumulated. At worker teardown, 11 objects were still open; 4 of them (the launched browser, its
context and page, the API request context) were still alive after every worker fixture had torn down, and Playwright
killed them on exit.

**What leaks and idle pages cost a run.** The same 32 tests on 4 workers, two rounds each (ranges across rounds):

| Variant | Wall | Median test | CPU, all processes | Peak memory (PSS) | Renderers |
|---|---|---|---|---|---|
| context closed at the end of each test | 7.2–7.3 s | 727–753 ms | 15.0–15.1 s | 893–906 MB | 4 |
| context left open (ends on a polling page) | 10.7–11.5 s | 981–1101 ms | 35.5–38.1 s | 1405–1412 MB | 32 |
| API test, `request` only | 1.3–1.5 s | 20–21 ms | 3.5–4.0 s | 484–521 MB | 0 |
| API test that also asks for `page` | 2.1–2.2 s | 106–108 ms | 5.6–6.0 s | 788–807 MB | 3–4 |
| `page` fixture flow | 7.3–7.6 s | 728–762 ms | 15.0–15.7 s | 903–907 MB | 4 |
| … with `trace: 'on'` | 8.5–8.7 s | 851–857 ms | 19.8–20.5 s | 961–970 MB | 4 |
| … with `trace: 'retain-on-failure'` | 8.3–8.4 s | 825–841 ms | 18.2–19.0 s | 957–959 MB | 4 |
| … with `trace: 'on-first-retry'` | 7.4–7.5 s | 749–789 ms | 15.1 s | 906–907 MB | 4 |
| … with `video: 'on'` | 8.6 s | 873–899 ms | 18.7–18.8 s | 1027–1029 MB | 4 |
| … with `video: 'retain-on-failure'` | 8.3–8.9 s | 834–937 ms | 18.7–20.0 s | 1020 MB | 4 |

Leaving contexts open more than doubled the CPU, added half to the wall time and 500 MB to the peak. An unused `page`
made an API test five times slower and launched a browser in every worker. On a green run, `retain-on-failure` costs
most of what `on` costs, because both record every test; `on-first-retry` costs nothing.

**How to measure, and how not to.**

- Summed RSS over the tree read 1345 MB in the sample where PSS read 522 MB: Chromium's processes share most of their
  memory, and RSS counts it once per process. Memory is reported as PSS.
- Shell `time` (the rusage of reaped children) reported 11.1 s of CPU for the closed variant and 13.0 s for the leaky
  one; sampling `/proc` reported 15.0 s and 35.5–38.1 s on the same workload. Chromium's renderers are not all reaped
  through the tree, so CPU is sampled, never read from exit accounting.
- In the prototype, a census at test end took 22 ms (median). Measured apart: reading PSS (`smaps_rollup`) for 11
  processes 10 ms, opening a CDP session on a page with `Performance.enable` 21 ms (once per page),
  `Performance.getMetrics` on an open session 1.7 ms, `SystemInfo.getProcessInfo` 1.3 ms, the `/proc` scan 1.5 ms. The
  design below keeps PSS in the reporter's background sampler and opens CDP sessions only on pages that outlive their
  test, which brings a boundary to a few milliseconds.

**Which metrics see contention.** The same two variants, with every source of [Part 2](#part-2--metrics) sampled:

| Metric | Contexts closed | Contexts left open |
|---|---|---|
| machine CPU busy (`/proc/stat`) | 60.7% | 90.5% |
| CPU pressure, PSI `some`: share of the wall time a task waited for a CPU | 28.6% | 66.3% |
| time runnable but waiting for a CPU (`/proc/<pid>/schedstat`), all processes | 8.3 s | 72.8 s |
| … of which renderers | 2.3 s | 58.6 s |
| worker event-loop delay, p99 of the worst test | 54 ms | 82 ms |
| peak memory (PSS) | 911 MB | 1373 MB |
| steal (`/proc/stat`) | 1.9% | 1.6% |

"Busy" says the machine was used; pressure and run-queue wait say work was waiting, and for whom. The largest single
process was the Node worker (173–180 MB peak RSS), not a renderer (98–101 MB).

**What artifacts cost on a page closer to an application.** A 1,500-row table, a 400 KB API response, an animation
and a re-sort on click; 32 tests on 4 workers, two rounds unless noted:

| Mode | Wall | CPU | Kept after the run | Peak disk in use during the run |
|---|---|---|---|---|
| no artifacts | 9.7–9.9 s | 22–23 s | 0 | 0 |
| `trace: 'on'` | 35–38 s | 122–134 s | 145–148 MB | 412–430 MB |
| `trace: 'retain-on-failure'`, every test passing | 28–30 s | 101–108 s | 0 | 279–286 MB |
| `trace: 'on-first-retry'` | 9.6–10.0 s | 22–24 s | 0 | 0 |
| `trace` with `screenshots: false` (one round) | 14.8 s | 41 s | 2.4 MB | 12 MB |
| `trace` with `snapshots: false` (one round) | 22.4 s | 76 s | 89 MB | 252 MB |
| `video: 'on'` | 21–24 s | 73–86 s | 5.6–6.1 MB | 10–12 MB |
| `video: 'retain-on-failure'`, every test passing | 21–24 s | 74–86 s | 0 | 5 MB |
| `screenshot: 'on'` (one round) | 10.4 s | 24 s | 0.8 MB | — |

Tracing's cost grows with the page: on the trivial page it added a third to the CPU, here it multiplied it by about
5.5 to 6. Most of it is the screencast frames. In one run of each, the GPU process, which renders them in software on
a machine without a GPU, went from 0.8 s of CPU to 37.6 s with tracing and to 30.2 s with video (plus 13 s of
`ffmpeg`). Turning the frames off cut what a tracing run keeps from 145 MB to 2.4 MB; turning the DOM snapshots off
left 89 MB. A run needs about three times the disk it keeps while it writes and zips its traces, and a green
`retain-on-failure` run keeps nothing yet needs 280 MB of scratch. With tracing on, the worker's event loop was busy 28% of the time (12% without), its p99 delay reached
181 ms, and it was switched out involuntarily about 2,100 times per test (70 without): the process that drives the
browser was starved as well.

**Where disk and memory numbers mislead.**

- `write_bytes` in `/proc/<pid>/io` counts pages when they are dirtied. With no artifacts at all, the browser
  processes dirtied about 480 MB per run and 265 MB of it was deleted before writeback: Chromium keeps its shared
  memory in deleted `/tmp/.org.chromium.Chromium.*` files, because Playwright launches it with
  `--disable-dev-shm-usage`. A browser's `write_bytes` is not disk usage.
- `wchar` counts every `write()`, pipes included: the worker's 22 MB per run was protocol traffic to the browser.
- `/proc/diskstats` counts what reached the device, through the page cache, so it lags: by `onEnd` the device had
  received 202–310 MB in the tracing runs and 2–12 MB in the others. The disk numbers worth reporting are space:
  kept, peak in use, free at the low point.
- The container's counters give an exact peak with no sampling (`memory.max_usage_in_bytes` on cgroup v1,
  `memory.peak` on v2), page cache included, and Node reports the container's limit (`process.constrainedMemory()`,
  14.3 GB on a 16 GB host here), which `os.totalmem()` does not.
- A process's peak RSS can be reset: writing `5` to `/proc/<pid>/clear_refs` took `VmHWM` from 341 MB back to the
  current 41 MB, so a worker can read an exact per-test peak for each of its browser processes.

## What exists

### In Playwright (1.63)

- **Only fixture contexts are closed per test.** `_contextFactory` closes the contexts it created when the test ends,
  and the `request` fixture disposes its API context. A context from `browser.newContext()`, a page from
  `browser.newPage()` (whose implicit context closes only with that page, `_ownerPage`), a browser from
  `chromium.launch()`, an API context from `request.newContext()`, and every page of a context that outlives a test
  stay open until something closes them (`node_modules/playwright/lib/index.js`).
- **Workers live long.** A worker runs test after test, across the files that share its project and worker fixtures,
  until a test fails or the run ends. On exit it tears down test fixtures, then worker fixtures, then kills any browser
  still running (`gracefullyCloseAll`, `playwright/lib/worker/workerProcessEntry.js`). A leak in an early file is paid
  by every later test on that worker, and the greener the suite, the longer its workers live.
- **Teardown order.** After the test body: `afterEach` hooks, then test-scoped fixtures in reverse setup order (auto
  fixtures are set up first, so they tear down last), then `afterAll` for the describe blocks that are ending.
  `beforeAll` hooks run with worker fixtures and `all-hooks-included` auto fixtures only.
- **No background throttling.** Chromium is launched with `--disable-background-timer-throttling`,
  `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding` (`chromiumSwitches`).
- **Client instrumentation.** `playwright._instrumentation.addListener()` takes `runAfterCreateBrowserContext`,
  `runBeforeCloseBrowserContext`, `runAfterCreateRequestContext`, `runBeforeCloseRequestContext`, `onApiCallBegin` and
  `onApiCallEnd`. One instance is shared by every object on the worker's connection, so a listener sees fixture
  contexts, `browser.newContext()`, `launchPersistentContext`, the default context of `connectOverCDP`, the contexts of
  a browser the test launched itself, and every API request context. `onApiCallBegin` carries the user's stack frames
  (the ones Playwright places steps with). Playwright's own trace and screenshot recorder (`_setupArtifacts`) is built
  on these hooks. They are internal.
- **The current runnable.** `testInfo._timeoutManager._running.runnable` is `{ type, fixture? }`: the test, a hook
  (`beforeAll`, `beforeEach`, …) or a fixture's `setup`/`teardown` with its title and, for a user fixture, its
  location. A fixture's scope is not on it; worker fixtures (and fixtures with their own timeout) carry a timeout slot
  at setup. Internal.
- **Public lifecycle API.** `browser.contexts()`, `context.pages()`; events `browser` `disconnected`, `context`
  `page`/`close`, `page` `close`/`popup`/`framenavigated`/`request`/`load`.
- **Explicit resource management.** `Browser`, `BrowserContext`, `Page` and `APIRequestContext` implement
  `Symbol.asyncDispose`, and Playwright's Babel transform includes the explicit-resource-management plugin, so
  `await using context = await browser.newContext()` closes the context at the end of its block.
- **Step titles.** The reporter receives user calls as `pw:api` steps with locations: `Create context`, `Create page`,
  `Create request context`, `Launch browser`, `Close context` (inside the `afterAll` hook when closed there).
- **Video records fixture contexts only.** `recordVideo` is added by `_contextFactory`; a context a test creates by
  hand records nothing whatever `video` says.
- **Temp profiles.** A launched browser's profile is `os.tmpdir()/playwright_<browser>dev_profile-*`, removed on a
  graceful close.

### In Piwi

- **The wrappers.** `patchBrowser`, `instrumentContext` and `instrumentPage` (`internal/capture/capture-fixtures.ts`)
  wrap `browser.newPage/newContext/close`, `context.newPage/close` and `on('page')`, and `page.close`, idempotently
  (`INSTRUMENTED_*`), to drain probes and take the page reads before a close. They see the fixture browser only.
- **The auto fixture.** `piwiCapture` has no dependencies, opens a sink per test and flushes it after Playwright's
  `page` and `context` fixtures tore down. There is no sink during `beforeAll` and `afterAll`.
- **Invisible capture.** Page reads go through `internalCall` (no step, no trace action), and `boxCaptureFrames`
  keeps wrapper frames out of step locations (`internal/capture/quiet-capture.ts`).
- **Transport.** Workers hand data to the reporter through `piwi-*` attachments (`internal/capture/attachments.ts`);
  flake mode adds a results file that workers append whole lines to (`internal/flake/mode.ts`).
- **Run data.** Each attempt carries `workerIndex`, `shardIndex`, `startedAt`, hook and fixture `stepEvents`, and
  network requests. Run metadata has `config.workers` and `fullyParallel`, nothing about the machine or its processes
  (`internal/collect/metadata-collector.ts`).
- **Time already has a price.** The wasted-time lens counts wait steps and failed attempts, priced with the CI minute
  cost (`PIWI_CI_MINUTE_COST`, `shared/ci-cost.ts`, `shared/handlers/analytics/wasted-time.ts`); timeout hygiene
  proposes tighter timeouts.
- **Neighbors already explain failures.** The clue engine has `worker-pollution` (the previous test on this worker
  failed, `shared/failure-clues.ts`); the flake profile has a load suspect and the lab has `cpu`, `after` and
  `alongside` conditions ([`flake-lab.md`](../adr/flake-lab.md)).
- **Delivery routes.** The gate takes `--max-*` policies (`packages/reporter/src/cli/gate.ts`), the editor service
  publishes diagnostics with quick fixes and hovers (`packages/editor/src/server.ts`), MCP lists tools in
  `shared/mcp-tools.ts`, and every optional surface is a capability in `shared/capabilities.ts`.
- **The bench.** `packages/reporter/tests/bench/` measures what each capture layer costs a suite.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Objects are tracked by one listener on Playwright's client instrumentation, installed by a worker-scoped auto fixture, feature-detected; browsers by wrapping `launch`, `launchPersistentContext`, `connect` and `connectOverCDP` on the three browser types; pages and closes through public events. Without the hook, the existing wrappers keep tracking the fixture browser. | One listener sees every context and API context in the worker, however it was made. It must exist before the first `beforeAll`, which runs before test fixtures. |
| D2 | Provenance is the runnable Playwright is executing plus the user frame of the API call (`onApiCallBegin` frames). A popup records its opener and the last user call before it appeared. | It is how Playwright itself places steps; the call site is what a fix edits. |
| D3 | Verdicts are taken at Playwright's scope boundaries, never after a delay: test end (after test-scoped teardown), describe end (the first test outside it), worker end (before the fixture browser closes). An object leaks when it outlives the scope that created it. | Timing heuristics produce false positives; scopes are what Playwright and the reader both reason in. |
| D4 | Workers report facts, the reporter reaches verdicts. Each test's attachment lists what was born, closed and used, and what is open; the reporter stitches lifetimes per worker. | An object a serial describe hands from one test to the next and closes in `afterAll` is shared, not leaked, and only a later census can tell. |
| D5 | Five verdicts: **leaked** (outlived its scope, closed by nothing but worker exit), **shared** (outlived its test, closed within its describe), **idle** (created, never used), **piling** (a long-lived owner that grows: pages, Node-side listeners, route handlers), **held** (worker-scoped: cost only, never flagged). | Each verdict has a different fix; held objects are a choice, not a bug. |
| D6 | Cost is measured from the operating system, not estimated. The reporter samples its process tree; workers read their subtree at test boundaries; Chromium pages add renderer CPU and heap through CDP. Memory is PSS or the container's own count, labeled RSS where neither exists; disk is space, not per-process writes. | Measured: summed RSS overcounted memory 2.6×, exit accounting undercounted CPU nearly 3×, browsers dirtied 480 MB of "writes" that were their shared memory. |
| D7 | Off the test's path. Reads happen at boundaries, through `internalCall`; PSS only in the reporter's background sampler; CDP sessions only on pages that outlive their test. The budget is a few milliseconds per boundary, held by a `resources` rung in the bench. | The capture must cost far less than what it finds, and stay out of steps and traces. |
| D8 | Report by default. `PIWI_LEAK_CHECK=fail` fails a test that leaked an object it created, naming the call site; `close` closes what a test leaked (never shared or held objects) and still reports it. A `beforeAll` or worker leak is judged after its tests finished, so only the gate can enforce it. | Teams choose their own strictness; closing for them saves the memory today without hiding the bug. |
| D9 | A finding's identity is its kind, verdict and creation call site (or creating fixture), like a failure cluster's fingerprint: it has a first run, a last run, held time per run, and is recorded fixed after five runs without it. | "Did my fix hold?" is Piwi's first question for failures; it is the same question here. |
| D10 | No new channel for per-test data: it rides on a `piwi-resources` attachment. The worker-end census, which has no test to attach to, is one line per worker appended to a results file whose path the reporter sets in `onBegin`, before workers start, and reads in `onEnd`: the flake mode pattern. | Attachments already reach every submit path; the results file already solves output with no test. |
| D11 | The reporter alone gives a fixture-free tier: `Create …`/`Launch browser` steps without a matching close in the same scope are **probable** leaks, with their locations. Popups, use and per-page cost need the fixtures. | Users who never adopted the fixtures still see the commonest leaks. |
| D12 | Units stay physical: CPU-seconds, MB of PSS, page-seconds. Runner minutes are priced only where they are measured: a run's wall time, never a counterfactual. | CPU-seconds are not runner minutes; a made-up saving would undermine every other number. |
| D13 | A live run's resources travel apart from its test events: while someone has the run open (the `watched` flag the stream already returns), the reporter posts what its sampler and the censuses added since its last post to `POST /api/test-runs/:id/live-resources` every five seconds. The server keeps each reporter's series in memory, capped, replays them to a page that opens mid-run and drops them when the run ends; the stored report stays what `finish` sends. A server that lost them asks for the whole series again; a server without the route (404) ends the posts. Only the bands and open pages are live: verdicts, tails and the machine panel wait for the end. | The sampler runs anyway, so a live view costs a few hundred bytes every five seconds, and only while watched. Kept out of the event queue, a lost post costs one gap in a chart, never a test result, and needs neither the disk buffer nor crash recovery. |

## Part 1 — The ledger

### 1.1 What is tracked

| Object | Born through | Seen by | Closed through |
|---|---|---|---|
| browser | `launch`, `connect`, `connectOverCDP`, Playwright's `browser` fixture | wrapped `launch*`/`connect*`; the first context of an unseen browser | `disconnected` |
| context | `browser.newContext()`, the `context` fixture, `browser.newPage()` (implicit, flagged), `launchPersistentContext` | `runAfterCreateBrowserContext` | `close` event |
| page | `newPage`, popups, `window.open`, `target=_blank` | `context.on('page')` | `page.on('close')` |
| API request context | `request.newContext()`, the `request` fixture | `runAfterCreateRequestContext` | `runBeforeCloseRequestContext` |

Per open page, the census also counts the Node-side listeners (`listenerCount` over Playwright's page events) and
route handlers (`page._routes`, `context._routes`, internal). Per test, it counts the `addInitScript` and
`newCDPSession` calls seen through `onApiCallBegin`, which name the object type but not the instance: a long-lived
owner that gains one per test piles up. A context reused on purpose (`_forReuse`, UI mode and `--reuse-context`) is
held, never leaked.

### 1.2 Provenance

Each object records: the phase (`test`, `beforeEach`, `afterEach`, `beforeAll`, `afterAll`, or a fixture's setup or
teardown with its title and location), the test and its describe path, the call site, and for a popup its opener and
the call that triggered it. A fixture's scope is inferred: Playwright gives worker fixtures (and fixtures with their
own timeout) a timeout slot at setup, and an object a worker fixture made survives the test-scoped teardown, which
confirms it.

### 1.3 Use

A page is **used** when its main frame navigated, it fired `load`, it made a request, a locator was built on it
through the wrapped factories, or an `evaluate`-family call ran on it. A context is used when one of its pages was, a
browser when one of its contexts was. Idle is a fact about one test, so it is reported per test and summed per
creator: the fixture that made the page, or the user fixture set up after it in the test's `Before Hooks` (the
prototype named `consoleCollector` this way).

### 1.4 Censuses and verdicts

| When | Where | What is judged |
|---|---|---|
| Test end | the auto fixture's teardown, after `afterEach` and the test-scoped fixtures | objects the test body, its each-hooks or a test-scoped fixture created and that are still open; idle pages |
| Describe end | the setup of the first test outside the describe (its `afterAll` has run) | objects its `beforeAll` created that are still open |
| Worker end | the fixture browser's `close` wrapper, before Playwright closes it; then the worker fixture's teardown | everything still open, and what the worker's last describe left |

The reporter applies D5 in `onEnd`: an object that outlived its test and closed before its describe ended is
**shared**; one that stayed open to the worker-end census is **leaked**, held for the time from its scope's end to the
worker's exit. **Piling** is an owner whose open pages, listeners or route handlers grew over at least three
consecutive censuses without coming back down.

### 1.5 The worker process

`process.getActiveResourcesInfo()` is diffed at each boundary. Types that grew and did not come back down by the next
boundary are reported against the test: `TCPServerWrap` (a server left listening), `TCPSocketWrap`, `FSEventWrap`, a
`ProcessWrap` that is not a tracked browser, and a `Timeout` that persists over three tests (an interval). Node keeps no
creation site for these, so the test is the attribution.

### 1.6 Without the fixtures

From the `pw:api` steps it already receives, the reporter counts `Create context`, `Create page`,
`Create request context` and `Launch browser` against their close and dispose steps per scope (the test with its
hooks, a describe's `beforeAll`/`afterAll`). An excess is a **probable** leak at the step's location.

## Part 2 — Metrics

### 2.1 Who reads what

Four collectors, each where its numbers are cheapest and can be attributed:

| Collector | Runs in | When | Reads |
|---|---|---|---|
| Run sampler | the reporter (main process), on a background timer | CPU and pressure every second; PSS and disk space every five seconds | the process tree under Playwright (workers, browsers, `webServer`, global setup), the machine, the container |
| Test boundary | the capture fixtures, in each worker | test start and end | its own subtree (CPU, run-queue wait, switches, peak RSS after a reset), the Node worker, the ledger |
| Page reads | the capture fixtures, over CDP (Chromium) | test end, for pages that outlive their test (every page with `PIWI_CAPTURE_RESOURCES=full`) | renderer CPU, JS heap, DOM nodes, listeners, layout and script time |
| Artifact sizes | the reporter, in `onTestEnd` | each test | the size of each trace, video, screenshot and attachment the test produced (`stat` of its paths) |

Each process gets a role from its command line: `worker`, `browser`, `renderer`, `gpu`, `utility`, `zygote`
(Chromium's `--type=`), `ffmpeg` (video), `webServer` (the subtree of `config.webServer`'s command), and a browser
parented by the main process (global setup or teardown). A remote browser (`connectOptions`) is outside the tree and is
reported as not measured. The worker's attachment carries its PID, so the reporter can place its samples in the
worker's subtree and inside a test's span.

### 2.2 CPU

| Metric | Source | Scope | What it answers |
|---|---|---|---|
| CPU time by role | `/proc/<pid>/stat` (user + system); on any OS for Chromium, CDP `SystemInfo.getProcessInfo` | run, test (worker subtree) | which processes the suite pays for: renderers, browser, GPU, worker, `ffmpeg`, `webServer` |
| Machine busy, iowait, steal | `/proc/stat` | run, test span | how full the machine was; steal is CPU the hypervisor took from a cloud VM |
| CPU pressure | PSI `/proc/pressure/cpu`, or `cpu.pressure` per cgroup on v2 | run, test span | the share of time work waited for a CPU: oversubscription, measured directly |
| Run-queue wait | `/proc/<pid>/schedstat` | run by role, test | who waited: renderers, the worker, the browser |
| Involuntary context switches | `/proc/<pid>/status`; the worker's own `process.resourceUsage()` on any OS | test | a starved process, where `schedstat` is missing |
| Container throttling | cgroup `cpu.stat` (`nr_throttled`, `throttled_usec`), quota in `cpu.max` | run | a CPU quota (Kubernetes, Docker) holding the run back |
| Worker event loop | `perf_hooks`: `monitorEventLoopDelay`, `eventLoopUtilization` | test | whether the process that drives the browser was free to answer it |
| Page main thread | CDP `Performance.getMetrics`: `ProcessTime`, `TaskDuration`, `ScriptDuration`, `LayoutDuration`, `RecalcStyleDuration` | page, URL | which page of the application burns the CPU, and on what |
| Capacity | cgroup `cpu.max`, `os.availableParallelism()` | run | the cores the run really had |

### 2.3 Memory

| Metric | Source | Scope | What it answers |
|---|---|---|---|
| Peak memory, total | PSS from `/proc/<pid>/smaps_rollup`, summed over the tree | run, test span | the honest total, shared memory counted once |
| Container memory and its peak | cgroup `memory.current` and `memory.peak` (v2), `memory.max_usage_in_bytes` (v1); `memory.stat` splits anonymous memory from page cache | run | how close the run came to the limit the OOM killer uses, exactly, with no sampling |
| Peak per process | `VmHWM` in `/proc/<pid>/status`, reset per test through `clear_refs` | run, test | the largest single process; whether one test spiked a renderer |
| Kind of memory | `Pss_Anon`, `Pss_File`, `Pss_Shmem` in `smaps_rollup` | run by role | heaps, mapped binaries, or Chromium's shared memory |
| Memory pressure | PSI `/proc/pressure/memory`, major faults (`/proc/vmstat`), swap, lowest `MemAvailable` | run, test span | whether memory slowed the run before it killed anything |
| Kills | cgroup `memory.events` (`oom_kill`); a browser process that disappears during a test | run, test | an out-of-memory death behind a "Target closed" error |
| Page memory | CDP `Performance.getMetrics`: `JSHeapUsedSize`, `Nodes`, `JSEventListeners`, `Documents` | page, URL | the application's weight per page; a DOM that grows across tests in a reused page |
| Worker memory | `process.memoryUsage()`: heap, external, array buffers | test | test code or fixtures holding on to data |
| Limit | `process.constrainedMemory()`, `process.availableMemory()`, cgroup `memory.max` | run | the memory the run really had |

### 2.4 Disk

| Metric | Source | Scope | What it answers |
|---|---|---|---|
| Artifacts kept | each test's attachment sizes (`stat`); the output directory at the end | run, test | what the run leaves to upload and store: traces, videos, screenshots, reports |
| Peak disk in use | the output directory with its `.playwright-artifacts-<worker>` folders, and the browser profiles, walked every few seconds | run | the space a run needs while it writes and zips: about three times what it keeps |
| Free space at the low point | `statfs` on the output directory and `os.tmpdir()` | run, test span | how close the run came to `ENOSPC` |
| Device I/O | `/proc/diskstats` (bytes, busy time), PSI `io`, cgroup `io.stat` on v2 | run | whether the run waited on the disk |
| Leftovers | `playwright_*dev_profile-*` and `.playwright-artifacts-*` that outlive the run | run | the disk a crashed or killed run leaves on a runner |
| Upload and storage | bytes the reporter sends; bytes the dashboard stores for the run | run | what keeping the history costs |

Per-process `write_bytes` and `wchar` are not used for browsers ([What we measured](#what-we-measured)).

### 2.5 Processes, handles and network

| Metric | Source | Scope | What it answers |
|---|---|---|---|
| Processes by role, threads | the sampler's tree | run | how many renderers a run kept alive at once |
| Open files and sockets | `/proc/<pid>/fd` | test | a worker that accumulates descriptors |
| Node handles | `process.getActiveResourcesInfo()` | test | servers, sockets and intervals a test left in the worker ([1.5](#15-the-worker-process)) |
| Worker starts and browser launches | `workerIndex`, the ledger | run | what red tests cost in relaunches |
| Bytes per page | resource timing `transferSize`, read once per page; CDP `Network` with `full` | page, URL | heavy pages and third-party weight |

### 2.6 Read cost and cadence

Measured under load on the 4-vCPU VM, with 40 to 130 processes on the machine:

| Read | Cost | When |
|---|---|---|
| `stat`, `status`, `schedstat`, `io` of one process | 6–40 µs each | every second in the sampler; at boundaries in the worker |
| a full `/proc` scan to find the tree | 4–5 ms | every second, or follow the tree from known PIDs |
| `smaps_rollup` (PSS) of one process | 1.2–2 ms | every five seconds; never at a test boundary |
| `/proc/<pid>/fd` of one process | 0.1–0.2 ms | every five seconds |
| PSI, `/proc/stat`, `meminfo`, `diskstats`, `statfs` | 36–260 µs | every second |
| walking the output directory (about 100 files) | 1.5–5 ms | every few seconds, capped by file count |
| CDP `SystemInfo.getProcessInfo`, `Performance.getMetrics` | 1.3 ms, 1.7 ms | at boundaries |
| opening a CDP session on a page | 21 ms | once per page, only for pages that outlive their test |

Computed from these costs, with 40 processes in the tree the cadences above take the sampler about 2% of one core,
most of it PSS; following the tree from known PIDs and reading PSS every ten seconds bring it under 1%. A test boundary
costs about a millisecond, plus 1.7 ms for each page read over CDP.

### 2.7 Platforms

| | Linux | macOS | Windows | Containers (cgroup v2) | Chromium, any OS |
|---|---|---|---|---|---|
| CPU by process | `/proc` | `ps` | CIM `Win32_Process` | — | CDP `SystemInfo.getProcessInfo` |
| Waiting for a CPU | PSI, `schedstat` | the worker's involuntary switches | — | `cpu.pressure`, throttling | — |
| Honest memory | PSS | physical footprint (to verify) | private working set | `memory.current`, `memory.peak` | page heap only |
| Disk space | `statfs`, directory walks | the same | the same | — | — |
| Device I/O | `diskstats`, PSI `io` | — | CIM transfer counts | `io.stat`, `io.pressure` | — |

Linux, where most CI runs, gets everything. Elsewhere a missing metric is reported as not measured, never as zero.

### 2.8 Attribution and honest numbers

- A test's cost is what its worker's subtree spent during its span: CPU, run-queue wait, peak RSS per process after a
  reset, artifact bytes. Machine-wide numbers over the same span (pressure, steal, free space) are its context, never
  its cost: tests running at once share them.
- A run's peak is the peak of the sum (PSS samples, or the container's own peak), never the sum of per-process peaks.
- Memory is PSS or the container's count; CPU is sampled, never read from exit accounting; disk is space, plus device
  I/O over a window that includes writeback.
- Capacity comes from the container's limits, not from the host.
- A process born after the first sample counts from zero.

## Part 3 — Waste

Each finding names what to change and, where the lab measured it, what it costs.

| Finding | Signal | Fix | Measured |
|---|---|---|---|
| Idle page or context | a fixture made it, nothing used it; named by creator | drop `page` from the test's arguments; make an auto fixture depend on nothing it does not use, or opt tests out of it | API test 20 → 107 ms median, a browser per worker (+300 MB on 4 workers) |
| Browserless tests in browser projects | a test that used no page in any project, over its history | run it once, in a project with no browser fixture | — |
| Tracing and video modes | tests traced or recorded versus artifacts kept, per run, with the run's own CPU and disk | `trace: 'on-first-retry'`, `video: 'on-first-retry'` | on a 1,500-row page, a green `retain-on-failure` run: CPU ×4.5, wall ×2.9, 280 MB of scratch, nothing kept; `on-first-retry` +0% (on a trivial page `retain-on-failure` cost +20–26% CPU) |
| Trace screencast frames | tracing on, the GPU process's CPU and the trace bytes | `screenshots: false` in the trace options keeps the DOM snapshots and the action log | CPU ×5.8 → ×1.8, kept 145 → 2.4 MB, peak disk 430 → 12 MB (one round) |
| Disk headroom | peak disk in use and free space at the low point, against the runner's disk | fewer or lighter artifacts; remove leftovers | peak in use ≈ 3× kept with tracing |
| Video that records nothing | `video` set while the tests create their contexts by hand | record through the `context` fixture, or drop the option | — |
| The web server | the `webServer` role's share of CPU; a dev-server command (`dev`, `vite`, `next dev`, `nuxt dev`, `webpack serve`) | serve a production build in CI | — |
| Worker restarts | worker processes started against `workers`; each start relaunches the browser | fix the failures; read as a cost of red runs | — |
| Machine size | CPU pressure and run-queue wait; peak memory against the container's limit; per-worker peaks | fewer workers on a runner where work waits for a CPU most of the run, more where memory and CPU sit idle | leaked contexts: CPU pressure 29% → 66%, run-queue wait 8 s → 73 s |
| Third-party hosts | requests per host outside `baseURL`'s origin, all resource types, counted without bodies | block them with `context.route` | — |

Hard waits already have a lens (wasted time); the Resources tab links to it rather than counting them twice.

## Part 4 — Explain, enforce, fix

- **Clues.** Four rules read the failing attempt's span. Their thresholds start from the lab's numbers and are tuned
  on stored history:
  - `pages-left-open` (medium): the worker held pages other tests left open; the detail names the leak's call site.
    Strong when the failure is a timeout and those pages' renderers used at least half of the browser's CPU during
    the attempt.
  - `cpu-starved` (medium, strong on a timeout): CPU pressure stayed high, the test's renderer or worker spent a large
    share of the attempt waiting for a CPU, the worker's event loop stalled, or the container was throttled. The detail
    says who waited and what else ran: leaked pages, tracing, more workers than cores, steal.
  - `out-of-memory` (strong): the container recorded an OOM kill, or a browser process disappeared during the attempt;
    the detail gives the peak and the limit.
  - `disk-full` (strong): free space fell under a floor during the attempt, or the error carries `ENOSPC`; the detail
    gives what was in use: traces, videos, leftovers.
- **Flakiness.** A flake profile suspect: the failure rate rises with the pages left open in the worker when the
  attempt started (and with its position in the worker). The lab proves it with the `after` condition (run behind the
  leaking test) or a new `hold` condition (keep N polling pages open in the worker before the target runs).
- **Gate.** `--max-leaks <n>` and `--max-new-leaks <n>` (findings never seen on the base branch), like the other
  `--max-*` policies.
- **Pull-request comment.** One line per new leak the branch introduces, with its call site.
- **Editor.** A diagnostic at the creation line (warning for leaked, information for idle), a hover with held time
  and after-test CPU over recent runs, and quick fixes: `await using` when the variable lives in the test's block, a
  `close()` or `dispose()` at the end of the test, an `afterAll` close for a `beforeAll` object, removing an unused
  `page` from the arguments.
- **MCP.** `list_resource_findings` and `get_resource_profile`; the fix plan carries the same edit as the quick fix.
- **Local strict mode.** `PIWI_LEAK_CHECK=fail` turns a test's own leak into a fixture-teardown error on that test;
  `close` closes it and reports `leaked (closed by Piwi)`.
- **Timelines** (optional). Both timelines already draw time on the run's clock. Censuses and samples are epoch
  milliseconds from the reporter's machine, like the tests' start times, so resources line up with the bars without
  translation (one clock per shard, placed by shard as the rows are).
  - *The run's workers timeline* (a row per worker, a bar per test). A leaked object becomes a hatched **tail** on
    its worker's row, from the end of the test that opened it (of its describe block, for a `beforeAll` object) to
    its close or the worker's exit; the hover gives the opening line, the held time and the CPU it used after its
    test, and a click opens the finding. Under each row, a thin **open pages** step line counts the contexts and pages
    open at each test boundary: a staircase over a worker's tests is a leak you can see, a sawtooth is normal. With
    the run sampler, a **CPU and memory band** under each row draws the worker's subtree (cores busy, PSS), and a
    strip above the rows draws the machine's CPU pressure and steal, with a mark where the container hit its memory
    limit. A leaked page's renderer that keeps a core busy past its test's bar, and the tests that ran on a starved
    machine, are then visible without a table. A new worker process (already drawn) shows where memory came back.
  - *The execution's failure timeline* (lanes for steps, console, network, backend, dialogs). A **resources** lane
    marks when the test opened or closed a context, page or popup and spans each one's life inside the test, ending
    with what was still open; a chip says how many pages earlier tests left open in the worker when this one started.
    Behind the lanes, the **CPU band** of the worker's subtree and the machine's pressure over the test's span, with
    the failure moment on top, answers "was it starved when it timed out?" next to the `cpu-starved` clue.
  - Data: the lane reads the births and closes of the test's own census (a few objects, stored with the execution);
    the tails read `resource_occurrences`; the step line reads the open counts at each boundary; the bands need
    per-worker series, two values every two seconds, about 14,400 numbers for an hour-long run on four workers. A live
    run draws the bands and the open pages as it runs (D13), and the tails once it finishes, since a leak verdict needs
    the censuses that follow it (D3, D4). Without the fixtures only the machine's bands remain; outside Linux the bands
    are as coarse as [2.7](#27-platforms) says.

## Part 5 — Further out, each with an entry condition

[resource-consumption-next.md](resource-consumption-next.md) ranks what comes after this plan: waste in data already
stored, deeper detection and fixes Piwi applies.

- **Memory lab** (application leaks). A lab mode that runs one test's flow repeatedly in one context, forces a garbage
  collection between rounds (`HeapProfiler.collectGarbage`) and reads the retained heap and detached DOM nodes:
  steady growth points at the application, not the test. The approach of MemLab, on tests the team already has. Entry:
  Part 2 shipped and a team asks.
- **`piwi doctor`.** Lists browser processes left by earlier runs on a self-hosted runner (a
  `playwright_*dev_profile-*` profile and no Playwright parent) and leftover profile directories, with their memory and
  disk; `--clean` removes them after asking. Entry: a self-hosted user reports runner degradation.
- **Runner advice from history.** Runs of one project on different runner sizes or worker counts already exist in
  the history; comparing their wall time, CPU pressure and peak memory gives the cheapest setting that does not slow
  the run. Entry: a project with runs on at least two configurations.
- **Upstream.** Ask Playwright for public lifecycle hooks and the fixture scope on the runnable, which would retire
  most of Risk 1.

## Storage and wire

- **Attachment** `piwi-resources` (per test, JSON): objects born, closed and still open (ids, kinds, provenance), idle
  pages, handler counts, Node handle growth, CPU per role, after-test CPU of leaked pages.
- **Per case** `resources` on `WireTestCase`: CPU per role, run-queue wait, peak RSS of its browser processes,
  `leakedCpuMs`, `openAtStart` (contexts, pages), the worker's event-loop utilization and p99 delay, artifact bytes by
  kind, the pressure, steal and free space over its span, and the findings this test produced.
- **Per run** `resourceProfile`: machine facts (cores, memory, container limits, platform and which metrics it could
  read), peak PSS and its time, the container's own peak, CPU and run-queue wait per role, PSI and steal averages,
  artifacts kept and peak disk in use, the lowest free space, per-worker starts and peaks, a series downsampled to
  one point every two seconds and capped (CPU busy, CPU pressure, PSS, disk in use), and the stitched findings.
- **Tables.** `resource_findings` (project, fingerprint, kind, verdict, call site, creator, first and last run, status,
  fixed run) and `resource_occurrences` (finding, run, execution, held ms, after-test CPU, pages, tests). Runs gain
  `peak_pss_mb`, `cpu_ms`, `cpu_pressure_pct`, `artifact_bytes`, `peak_disk_bytes` and the profile JSON; executions
  gain `browser_cpu_ms`, `run_queue_wait_ms`, `leaked_cpu_ms`, `peak_rss_mb`, `artifact_bytes` and
  `open_pages_at_start`. Daily rollups carry CPU-seconds, leaked CPU-seconds, peak memory, artifact bytes and idle
  pages for analytics.
- **Capability** `resources` (module `workflow`, instance and project levels, passive data), so a team that does not
  want the tab declines it like any other.

## Delivery

| PR | Content | Visible result |
|---|---|---|
| 1 | The ledger in the capture fixtures (worker auto fixture `piwiResources`), the `piwi-resources` attachment, stitching and verdicts in the reporter, the fixture-free tier, the console summary, `PIWI_LEAK_CHECK` | leaks and idle pages at the end of every run, no server change |
| 2 | The metrics of Part 2: the run sampler (CPU, pressure, memory, disk, container) and artifact sizes in the reporter, which need no fixtures; the test-boundary reads (subtree, run-queue wait, peak RSS reset, event loop) and CDP reads for pages that outlive their test in the fixtures; machine facts | the machine panel in the console summary, for every reporter user |
| 3 | Wire, storage, the Resources tab, per-execution cost on the execution page, the capability, a leaky run in the demo (simulator scenario and seeded run) | the run page, and the demo |
| 4 | Finding history and fix verification, gate policies, the pull-request line, MCP tools | CI and agents |
| 5 | The clue, the flake suspect and the `hold` condition, editor diagnostics and quick fixes | failures and the editor |
| 6 | The waste findings of Part 3 | the Waste section |
| 7 (optional, after 3) | Tails, the open-pages line and the CPU and memory bands on the run's workers timeline; the resources lane and the CPU band on the execution's failure timeline | the timelines |

## File-by-file checklist

### PR 1 — the ledger

- `packages/reporter/src/internal/capture/resource-ledger.ts` (new): the listener, provenance, use counters, censuses.
- `packages/reporter/src/internal/capture/capture-fixtures.ts`: the `piwiResources` worker auto fixture (depends on
  `playwright` only, so it never launches a browser); census calls in `piwiCapture`; the worker-end census in the
  `browser` close wrapper. `PiwiFixtures` gains the reserved name.
- `packages/reporter/src/internal/capture/attachments.ts`: `piwi-resources`.
- `packages/reporter/src/internal/collect/resource-verdicts.ts` (new, pure): stitching, D5, the fixture-free tier from
  steps.
- `packages/reporter/src/public/reporter.ts`, `internal/support/ci-output.ts`: collection and the summary.
- `packages/reporter/src/internal/config/env.ts`, `public/options.ts`: `PIWI_CAPTURE_RESOURCES`, `PIWI_LEAK_CHECK`,
  `captureResources`, `leakCheck`.
- `packages/reporter/tests/integration/`: the leaky suite of [What we measured](#what-we-measured) with its expected
  verdicts, plus a clean suite that must produce none.
- `apps/application/tests/fixtures.ts`: the dogfood mirror installs the same fixture.

### PR 2 — metrics

- `packages/reporter/src/internal/collect/process-sampler.ts` (new): the `/proc`, `ps` and CIM readers, roles, the
  cadences of [2.6](#26-read-cost-and-cadence), PSI, steal, `diskstats`, `statfs`, directory walks, cgroup v1 and v2
  counters; every reader feature-detected and reported as not measured when missing.
- `packages/reporter/src/internal/capture/worker-metrics.ts` (new): the test-boundary reads (subtree counters,
  `clear_refs` reset and `VmHWM`, `perf_hooks` event loop, `resourceUsage`, descriptors) and the CDP page reads.
- `packages/reporter/src/public/reporter.ts`: the sampler's lifetime, artifact sizes in `onTestEnd`, the machine
  panel.
- `metadata-collector.ts`: machine facts and container limits.
- `packages/reporter/tests/bench/`: the `resources` rung.

### PR 3 — storage and the tab

- `packages/reporter/src/types/wire.ts`, `internal/submit/serializer.ts`, `packages/core/src/wire.ts`; the matching
  `apps/application/shared/types.ts` change (the drift test pins them).
- `apps/application/server/database/schema.sqlite.ts`, `schema.pg.ts` and generated migrations.
- `apps/application/shared/resource-findings.ts` (new, pure: fingerprints, verdict summaries), handlers, routes, demo
  handlers and seed rows (`app:check:demo`).
- The Resources tab and the execution cost block; `shared/capabilities.ts`.
- The demo, both ways the tab can be met:
  - *A "Leaky run" scenario* in the run simulator (`app/demo/simulator.ts`), on `e2e-checkout` like the others:
    `tests/cart.spec.ts` opens a context in each test and never closes it, popups pile up on a worker-scoped page, and
    an API test asks for `page`. Its tests stream their censuses, so the Resources tab fills as the run arrives, the
    machine panel lands with `finish`, and the run is slower than the seeded baseline, with renderers waiting for a CPU.
  - *A seeded run* (`scripts/generate-demo-seed.mjs`) in `web-dashboard`: the `adminPage` worker fixture piling up
    pages, listeners and route handlers, a browser `tests/admin/export.spec.ts` launches and never closes, and idle
    pages from an auto fixture, with a profile whose memory nears the container's limit. A `demo-examples.mjs` entry
    links its Resources tab from the docs page.
- `apps/docs/`: a features page, the configuration reference entries.

### PR 4 to 6

- `shared/handlers/` finding history and fix verification; `packages/reporter/src/cli/gate.ts`; the pull-request
  comment builder; `shared/mcp-tools.ts`.
- `shared/failure-clues.ts` (`pages-left-open`, `cpu-starved`, `out-of-memory`, `disk-full`); the flake profile and
  `@piwitests/core/flake-plan` (`hold`).
- `packages/editor/src/analysis.ts`, `server.ts`: diagnostic, hover, quick fixes.
- The waste findings, each with a unit test on stored fixtures.

### PR 7 — the timelines (optional)

- `apps/application/app/composables/useTimelineModel.ts`, `app/components/run/WorkersTimeline.vue` and
  `run/timeline/`: tails, the open-pages line, the bands and the pressure strip.
- `apps/application/shared/failure-timeline.ts` (a `resources` lane, built by the server route and the demo mirror
  alike), `FailureTimelineCard.vue`, `TimelineTypeFilter.vue`; demo seed rows.
- Storage: the per-worker series in the run's profile, and the census births and closes in the execution's
  `resources`.
- Live (D13): `packages/reporter/src/internal/streaming/live-resources.ts` (the posts and their cursors) and
  `RunSampler.liveMemory()`; `apps/application/server/api/test-runs/[id]/live-resources.post.ts`, the `resources`
  event and its catch-up in `stream.get.ts`, the state in `run-events.ts`; `shared/live-resources.ts` (merging a post
  into a reporter's series, for the server, the demo and the run page); `WorkersTimeline.vue` draws the merged parts
  while the run is live; `app/utils/live-worker-resources.ts` and `TestRow.vue` show each worker's last values on its
  running test; the demo simulator posts its timeline after each test.

## Verification

- The leaky suite reports exactly its planted findings at their lines; the clean suite (fixture pages, worker
  fixtures that close, `beforeAll` with `afterAll`, a serial describe handing a page on and closing it, `setContent`
  and `evaluate`-only pages, a reused context) reports none.
- The bench `resources` rung stays within 3% of `full` on the default workload.
- The A/B of [What we measured](#what-we-measured) reproduces in direction and rough size on CI's Linux runner, and
  the run profile matches outside tools on the same run within 10%: `pidstat` for CPU per process, `vmstat` and the
  PSI files for pressure, `du` for disk in use, the container's counters for peak memory.
- The package smoke job (Linux, macOS, Windows) runs with the sampler on and checks the profile is present and labeled
  per platform.
- Playwright 1.61 through the newest release: each internal hook is feature-detected and the degraded signal is the
  one the risk table names.

## Risks

1. **Internals.** `_instrumentation`, `_timeoutManager._running`, `_routes`, `_ownerPage` and `_forReuse` are private.
   Each is feature-detected and degrades one signal: no listener → the existing wrappers, fixture browser only; no
   runnable → call sites without phase; no `_routes` → no route-handler piling. A test over the supported Playwright
   range pins which are present.
2. **False positives.** An object kept in a module variable on purpose across files reads as leaked; a page used
   only through an API the ledger does not count reads as idle. Idle never fails a test or the gate by default, and
   a finding can be marked intended.
3. **Overhead.** Bounded by D7 and measured by the bench; censuses carry ids and counts, not objects; CDP sessions are
   capped per census.
4. **Shared machines.** Another job on the runner is outside the tree and does not count, while still slowing the run.
   The profile reports capacity from cgroup limits, not from the host.
5. **Privacy.** Page URLs are stored without query or hash, as the page inventory does; nothing from page content.
6. **Kernels and runners differ.** PSI can be compiled out or disabled at boot, `smaps_rollup` needs Linux 4.14,
   `memory.peak` needs 5.19, and cgroup v1 and v2 name things differently. Each reader is feature-detected, and the
   profile lists the metrics it could read, so a missing one never reads as zero.

## Open questions

- Should `PIWI_LEAK_CHECK=fail` apply per kind (fail on leaked contexts and browsers, never on popups)?
- Should the run profile be on by default for reporter-only users, given that it reads `/proc` every second?
- Per-test cost on every execution, or only on failures and a sample of passes, for storage on large suites?
- How fine the run's series should be, and how long it is kept: one point every two seconds is about 1,800 points for
  an hour-long run.
- Can leaked CPU-seconds ever be priced honestly (D12), for example when the run was CPU-saturated the whole time?
- Should Piwi's own capture overhead appear in the profile? Measuring it per run needs a control run; the bench may be
  the only honest place.

## Not in this plan

- Killing processes or deleting files on a machine without asking (`piwi doctor` lists first).
- Performance budgets for the application (web vitals already exist).
- Resources outside Playwright and the process tree: databases, containers, cloud services a global setup starts.
- Per-page cost in Firefox and WebKit, which have no CDP.
- Other test frameworks.
