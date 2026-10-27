# Resource consumption: what to find and fix next

An analysis of where a Playwright suite still spends CPU, memory, disk, network and runner time that Piwi does not
yet name, ranked by what it would save and by how much of the data Piwi already holds, with the detection and the fix
for each. It extends [resource-leaks.md](resource-leaks.md), which covers the objects a suite leaves open and what a
run costs its machine.

**Status.** Proposed 2026-10-27. Nothing here is built. The detection work of 2026-10-26 (servers and child
processes at their line, piling up with a dip, attached DOM elements, the worker's descriptors and heap after a full
garbage collection, the resource rows of the failure timeline) is recorded in [resource-leaks.md](resource-leaks.md);
this record starts where it stops. PRs 5 (clues, flake suspect, editor) and 6 (waste findings) of that plan are not
started and come first here.

## Summary

Piwi already sees leaks and what a run cost its machine. What it does not say yet is **why a green run is expensive**:
tracing and video modes that record every test to keep none, a login replayed in every test, the same bundle
downloaded thousands of times, workers idle at the end of a run, a development server in CI, a browser installed on
every job. Most of these need no new capture: the network requests, the process command lines, the per-worker series
and the project config are stored already. The rest goes deeper: leaks of the application itself, regressions of one
test's cost, N+1 queries seen through the backend instrumentation, and fixes Piwi applies or proposes rather than only
lists.

The order below follows one rule: a finding that needs no new capture and names its fix comes before one that needs a
new reader, and a measured saving comes before an estimated one (D12 of [resource-leaks.md](resource-leaks.md):
units stay physical, never a counterfactual price).

## What this rests on

Numbers measured on a 4-vCPU Linux VM, Playwright 1.63 and 1.64, Chromium headless shell:

| Measure | Result | Source |
|---|---|---|
| `trace: 'retain-on-failure'` on a green run, a 1,500-row page | CPU ×4.5, wall ×2.9, 280 MB of scratch disk, nothing kept | resource-leaks.md |
| `trace: 'on-first-retry'`, same run | +0% | resource-leaks.md |
| Trace with `screenshots: false` | CPU ×5.8 → ×1.8, kept 145 → 2.4 MB, peak disk 430 → 12 MB | resource-leaks.md |
| Contexts left open, 32 tests on 4 workers | CPU 15 s → 36 s, CPU pressure 29% → 66%, run-queue wait 8 s → 73 s | resource-leaks.md |
| An API test that also asks for `page` | median 20 → 107 ms, a browser launched per worker | resource-leaks.md |
| Worker heap at test end, 60 clean tests | +30 MB, all of it garbage | 2026-10-26 |
| Worker heap after a forced collection, 80 clean tests | Playwright alone +1.6 MB; with Piwi's capture +2.7 MB, about 3 KB a test after warm-up | 2026-10-26 |
| A worker keeping 30 MB a test, heap after V8's own full collections | 143 → 602 → 1,852 MB, three collections in 60 tests | 2026-10-26 |
| CDP `Nodes` on a page that only replaces its content | 165 → 25,341, detached nodes not yet collected | 2026-10-26 |

## Ranked ideas

| # | Idea | Signal | Data already stored | Fix offered | Effort |
|---|---|---|---|---|---|
| 1 | Tracing and video waste | `use.trace` / `use.video` per project, tests recorded against artifacts kept, GPU and `ffmpeg` CPU | yes | `on-first-retry`, `screenshots: false` | S |
| 2 | Failure clues tied to consumption | pages open at start, run-queue wait, OOM kills, free disk | yes | names the leak or the setting behind a timeout | M |
| 3 | Login replayed in every test | the same authentication request at the head of many tests | yes (network) | a `setup` project with `storageState` | S |
| 4 | Workers idle at the end of a run, unbalanced shards | workers × wall time against the sum of test durations, per shard | yes | slow files first, `fullyParallel`, shard weights | S |
| 5 | Development server in CI | the `webServer` role's command line and CPU share | yes (sampler) | serve a production build | S |
| 6 | Static assets downloaded by every test | the same URL and `transferSize` across tests | partly (sizes) | a worker-scoped asset cache fixture | M |
| 7 | Third-party hosts | requests outside `baseURL`'s origin, by host | yes (network) | `context.route` to block them | S |
| 8 | Resource regressions per test | a test's CPU or peak memory against its median on the default branch | yes (per execution) | pull-request line, gate policy | M |
| 9 | Worker count from history | CPU pressure, run-queue wait, peak memory against the limit, per worker count | yes (per run) | a `workers` value | M |
| 10 | Worker restarts | worker processes started against `workers` | yes | read as a cost of red runs | S |
| 11 | Browsers installed on every job | the browser executable created minutes before the run on CI | no (one `stat`) | cache `~/.cache/ms-playwright` | S |
| 12 | Heavier headless mode than needed | the browser's command line (new headless, `channel`) | yes (sampler) | the headless shell in CI | S |
| 13 | Application memory leaks | retained heap and detached nodes after forced collections, one flow repeated | no | names the URL and the flow | L |
| 14 | N+1 queries during E2E | SQL commands per HTTP request, from the backend instrumentation | no | names the route and the query | L |
| 15 | Long-lived page connections and timers | WebSocket and EventSource per page, intervals on pages left open | no | close or stub them | M |
| 16 | Tracing, bindings and CDP sessions piling on long-lived contexts | `tracing.start` without stop, `exposeBinding`, `newCDPSession` per test | no | stop, detach, move to the fixture | M |
| 17 | Fixes Piwi applies | editor quick fixes, `leakCheck: 'close'` for servers and processes, MCP fix plans | n/a | the edit itself | M |

S: a few days, M: a week or two, L: a project of its own.

## A. Finish what resource-leaks.md plans

### 1. Tracing and video waste

The largest measured saving. The reporter reads each project's `use.trace` and `use.video` in `onBegin`, counts the
tests each mode recorded and the artifacts kept, and reads the GPU and `ffmpeg` CPU from the sampler. A finding:
`trace: 'retain-on-failure' recorded 640 tests to keep 2; on this run the GPU process used 38 s of CPU`. The fix names
`on-first-retry`, or `screenshots: false` when traces must stay on. A context created by hand records no video whatever
`video` says: a second finding when the mode is set and no fixture context was created.

### 2. Failure clues tied to consumption

The four clues of PR 5 (`pages-left-open`, `cpu-starved`, `out-of-memory`, `disk-full`) read data already stored with
each execution and run: pages open when it started, its browsers' run-queue wait, the container's OOM kills, the lowest
free disk. They turn a timeout into "this test ran next to 14 pages an earlier test left open, at
`tests/cart.spec.ts:18`". The failure timeline's resource rows now show the same facts; the clue makes them the
headline when they explain the failure. The flake suspect (failure rate against pages open at start) and the lab's
`hold` condition prove it.

## B. Waste in data already captured

### 3. Login replayed in every test

Every execution stores its network requests. A request to the same authentication route (a `POST` whose path matches
`login`, `signin`, `auth`, `token`, `session`, or the first `POST` of most tests) at the head of many tests of one
project is a login replayed per test. The finding gives the share of each test's time before the first request after
it, and the fix: a `setup` project that signs in once and saves `storageState`, the dependent projects loading it. No
saving is printed until measured on the project's own runs.

### 4. Workers idle at the end of a run, unbalanced shards

The run's workers timeline has every test's span. Workers × wall time, minus the sum of test durations, is machine
time paid to wait: usually one long file finishing alone at the end. Per shard, the same against the slowest shard.
Fixes: run the slow files first (Piwi knows each file's duration), `fullyParallel`, split a long file, and the
duration-balanced `--shard` of [test-selection.md](test-selection.md).

### 5. Development server in CI

The sampler already reads the command line of every process under the runner. A `webServer` role whose command holds
`vite`, `next dev`, `nuxt dev`, `webpack serve` or `ng serve` on CI, with its CPU share, is one finding: serve a
production build.

### 6. Static assets downloaded by every test

Each browser context starts with an empty HTTP cache, so every test downloads the application's bundle again. The
captured requests carry their URL; a URL with an immutable look (a hash in its name) fetched by most tests, with its
size, gives the bytes per run. The fix Piwi can ship: an opt-in worker-scoped fixture that answers those URLs from
memory through `context.route` after the first download, which also takes that load off the web server. Its cost and
its saving are measured by the bench before it is offered.

### 7. Third-party hosts

Requests per host outside `baseURL`'s origin (analytics, fonts, maps, chat widgets), counted without bodies. The fix:
block them with `context.route`, or stub them.

### 8. Resource regressions per test

Each execution stores its worker CPU, its browsers' CPU and peak memory. Against the test's median over the default
branch's last runs, a test whose cost doubled on a branch is named in the pull-request comment, and a
`--max-resource-regressions` gate policy enforces it. Thresholds start high (×2 and a floor in seconds) to stay clear
of machine noise.

### 9. Worker count from history

Runs of one project with different `workers` values, or on runners of different sizes, already exist in the history
with their wall time, CPU pressure, run-queue wait and peak memory against the limit. The cheapest setting that did
not slow the run is a recommendation; the profile states the runs it compared. Entry: a project with runs on at least
two settings.

### 10. Worker restarts

Each failure restarts its worker, which relaunches its browsers. Worker processes started against `workers`, with the
launch time they cost, read as a cost of red runs on the Resources tab.

### 11. Browsers installed on every job

On CI, the browser executable created within minutes before the run means `playwright install` ran on that job. One
`stat` in the reporter; the fix is a cache of `~/.cache/ms-playwright` keyed on the Playwright version.

### 12. Heavier headless mode than needed

The browser's command line says whether it is the headless shell or the full browser in new headless mode (or a
`channel`). On CI, a run that does not need the full browser can use the shell; the saving is measured by the bench
before Piwi states one.

## C. Deeper detection

### 13. Application memory leaks

A lab mode: one test's flow repeated in one context, a forced collection between rounds
(`HeapProfiler.collectGarbage` over CDP), then the retained heap and the detached DOM nodes. Steady growth points at
the application, with the URL and the step. The attached-element count added on 2026-10-26 already sees DOM growth on
long-lived pages; this mode sees what the application keeps between two visits of the same page. Entry: a team asks.

### 14. N+1 queries during E2E

The backend instrumentation (Nitro, ASP.NET Core, Serilog) already ties log lines to the request that produced them.
Counting the SQL commands per HTTP request (through EF Core's `DiagnosticListener` on .NET, the database driver's
hooks on Nitro) and the allocated bytes per request turns the E2E suite into a check of the backend's own consumption:
a route that runs one query per row is named with the test that called it. Entry: the instrumentation packages gain a
query counter behind an option.

### 15. Long-lived page connections and timers

A page left open keeps its WebSocket and EventSource connections and its intervals. Per page that outlives its test,
the open connections (CDP `Network.webSocketCreated` and closes) and the main thread's busy time while the test waits,
so a polling page is named by what it polls.

### 16. Tracing, bindings and CDP sessions piling on long-lived contexts

A worker-scoped context gains a binding (`exposeBinding`, `exposeFunction`), an init script or a CDP session per test,
or a `tracing.start` with no stop, whose buffers grow until the worker ends. Wrapping these methods on the contexts the
ledger tracks gives the same piling finding as the route handlers, at the line that adds them. Playwright's own
artifact recorder calls `tracing` internally, so only calls with a user frame count.

## D. Fixes Piwi applies

### 17. From finding to edit

- **Editor quick fixes** (PR 5): `await using` when the object lives in the test's block, a `close()` at its end, an
  `afterAll` for a `beforeAll` object, removing an unused `page` argument. The language server already publishes
  diagnostics with quick fixes.
- **`leakCheck: 'close'` for servers and child processes**: they are tracked one by one now; closing a server and
  killing a process a test left running, with the same report as for contexts.
- **MCP fix plans**: `list_resource_findings` returns the edit with each finding, so an agent applies it.
- **Back-pressure, experimental**: an opt-in auto fixture that waits before a test while the machine's CPU pressure
  stays above a threshold, trading wall time for fewer starved timeouts, and reporting the time it waited.

## Delivery

| Step | Content | Visible result |
|---|---|---|
| 1 | Ideas 1, 5, 10, 11, 12: findings from the config and the process tree, in the reporter's summary and the Resources tab's Waste section | waste named at the end of every run |
| 2 | Idea 2 and the flake suspect (PR 5 of resource-leaks.md) | consumption behind a failure |
| 3 | Ideas 3, 4, 7: findings from stored requests and spans, server-side | login, idle workers, third parties |
| 4 | Ideas 8, 9: history over runs, pull-request line, gate policy | regressions and runner advice |
| 5 | Ideas 6, 16, 17: the asset cache fixture, piling bindings, fixes applied | fewer bytes, edits ready |
| 6 | Ideas 13, 14, 15: memory lab, query counter, page connections | the application's own consumption |

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | A waste finding names a setting or a line, and states a saving only when one was measured on the project's own runs or by the bench | D12 of resource-leaks.md: a made-up saving would undermine every other number |
| D2 | Findings from stored data are computed server-side, on the history; findings from the run's own config and processes, in the reporter | each where its data is, and the reporter's summary stays useful without a dashboard |
| D3 | Nothing Piwi changes in a suite is on by default: the asset cache, back-pressure and closing servers are opt-in | a test tool that changes behavior silently loses trust |

## Open questions

- Should the asset cache fixture ship in the reporter, or as a recipe in the docs first?
- How long a history do resource regressions need before the median is trusted: five runs, as fix verification, or
  more on a noisy runner?
- Is an opt-in forced collection every N tests (for small worker heap leaks) worth its pause, or does the memory lab
  cover the need?

## Not in this plan

- Pricing CPU-seconds or energy: units stay physical.
- Changing a suite or a runner without the user asking.
- Other test frameworks.
