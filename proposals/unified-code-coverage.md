# Unified code coverage: browser and server, per test

A study of how to record which **server** code each test executes (ASP.NET Core first), in addition to the browser
code that [code reach](../apps/docs/features/code-reach.md) records today, and to store both **the same way**: one
model, one wire field, one set of tables, read by the same consumers. It answers three questions: how to capture
server coverage **per test** while Playwright runs tests in parallel against one shared backend, what each level
costs, and what the editors can do with the result later. Every cost below was measured on a prototype, not
estimated; [Appendix A](#appendix-a-measurements) gives the method and the raw numbers.

**Status.** Proposed 2026-10-13. Delivery PRs 1 to 5 are built: the core model, browser code reach on V8 function
coverage, the dashboard's storage and endpoints, the .NET coverage package, and the reporter's collection of server
coverage, checked end to end on eShopOnWeb (each test's server files, functions and lines stored with their git blob
ids, and the run-level coverage with executable lines). Suspect lines (part 6) are built too: the API, the AI
context, the fix plan and the failure pages, checked on eShopOnWeb with a planted bug. The editors (part 5, delivery
PR 8) are built on 2026-10-14: line marks, a lens per function, the tests behind a line on hover, `.cs` files and
local runs that record server coverage, in VS Code and the JetBrains IDEs, reading `GET /api/projects/:id/coverage`
(which gained the executable lines and an ETag); their uncovered changed lines mark followed on 2026-10-24, with
[`editor-extensions-audit.md`](../adr/editor-extensions-audit.md) (L2). So are, from part 4, the MCP tool `get_coverage`, and from part 6 a
failure's path against its last pass, a test's path varying with the tests before it (the `order` flaky root cause),
what quarantining tests leaves uncovered and whether a new test reached its target lines, with the missing-test skill
checking them (see [`test-coverage-view.md`](../adr/test-coverage-view.md), "Built beyond the plan"). API tests through the
`request` fixture record server coverage. Browser functions are built (`coverage.browser: 'functions'`, 2026-10-16),
and the LCOV and Cobertura export came with [`combined-code-coverage.md`](../adr/combined-code-coverage.md), as the
export of a commit's combined coverage (2026-10-17). From part 4, uncovered changed lines and the gate's line form
are built on 2026-10-21 with [`coverage-and-the-test-map.md`](../adr/coverage-and-the-test-map.md): every changed file
the head commit's combined coverage counts carries the changed lines no suite ran, named in the pull-request comment
and returned by `get_change_coverage`, and the gate's line form is `--min-patch-coverage`, warn-only, with no new
flag. Line-level impact (part 4) is built on 2026-10-24: `piwi run impact` and `piwi preflight` send each modified
file's base blob and changed base lines, and a test that reaches the file only through coverage is kept when its
coverage of that version ran a changed statement or a function around a changed line; a change outside every known
function or crossing from one into the next, coverage of another version or with no ranges, and an incomplete or
unknown capture stay at file level. The MCP tool
`get_impacted_tests` takes a diff and returns the same answer per file, with the changed lines no test ran. Not built
yet: browser lines (PR 6), the Istanbul adapter (D13) and the rest of part 6. Part 3b, added 2026-10-26 in answer to
open question 5, gives Nitro backends the same server coverage: built the same day (delivery PR 9) and checked on the
sample application, whose Nitro backend now records what its ASP.NET Core one does, unit tests and combined coverage
included; a Nuxt application's server rendering (PR 10) is not built. Part 2b, CSS rule coverage, is measured and not
built (PR 11).
Each test's coverage is shown on the execution page and per file on a page of its own
([`test-coverage-view.md`](../adr/test-coverage-view.md)). The study's measurements came from
a prototype built outside the repository, on Microsoft's eShopOnWeb reference application and on a small application
written to spend its CPU in business logic (the **pricing application**). New wire fields, options and endpoints
freeze at 1.0 and need an entry in [`1.0-stabilization.md`](1.0-stabilization.md).

**Summary.** The C# compiler can instrument code for coverage by itself: building with `-p:Instrument=TestCoverage`
inserts a statement marker in every method and calls a method the application supplies,
`Microsoft.CodeAnalysis.Runtime.Instrumentation.CreatePayload`, to get the array those markers write into. Supplying
that method from a NuGet package lets Piwi decide, at run time, **whose** array a method writes into: a shared one
(coverage for the whole run) or the one of the HTTP request being served, found through the request's `AsyncLocal`
the existing log capture already uses. A request's coverage is named on its response (`X-Piwi-Coverage`), the reporter
collects the names a test's pages received and asks the backend for their coverage once the test ends. Attribution
is exact under concurrency (300 requests on 16 connections: no foreign file, no missing file). On eShopOnWeb, per-test
server coverage added **under 2% to test duration** (+3.5% to +4.3% with the collection call inside the test, which
the design moves out of it); on the pricing application, where most of the CPU is business logic, it added **+24% to
+26% server CPU**. On the browser, Playwright's `page.coverage` always uses V8's block coverage; function coverage,
which is all file and function reach need, reports the same executed functions for **+7% to +13% of test time
instead of +37% to +42%** on a script-heavy page. The study proposes four levels (routes, functions per test, lines
per test, lines per run), one storage model keyed by repository-relative path and line ranges, and what to build on
it: suspect lines for a failure (on eShopOnWeb, the failing test executed only the bug's 3 lines of a 13-line
change), gap detectors at the code level, and the editor features.

## What the reader gets

- **Per test, the server files, functions and lines it executed**, next to the browser ones, in the same lists and
  the same tables. A change to `src/Web/Services/BasketService.cs` maps to the tests that ran it, not only to the
  tests that called a route whose handler sits in another file.
- **Suspect lines for a failure**: the changed lines the failing test executed, in the cluster page, the AI
  diagnosis and the fix plan. On eShopOnWeb, a 13-line change narrowed to the bug's 3 lines (part 6).
- **Gaps behind the surface**: error paths, branches and functions no test executes, per feature (part 6.3).
- **Line-level test selection.** `piwi run impact` can select the tests that executed the changed lines, not every
  test that touched the file.
- **Uncovered changed lines** in the pull-request comment: "12 of the 40 lines this change touches in
  `OrderService.cs` were executed by no test". Today an ASP.NET Core file shows as *no evidence* unless it is a route
  handler, because the uncovered-changes join only knows Nitro and Nuxt file conventions.
- **A run-level coverage report** of the server code the end-to-end suite executes, exportable as LCOV or Cobertura.
- **Later, in the editors**: line marks for executed and never-executed code, a lens per function ("Reached by 6
  tests · Run them"), and the tests behind a line on hover, in VS Code and in JetBrains IDEs including Rider.

## Vocabulary

Each term below is used with this meaning only.

| Term | Meaning |
|---|---|
| **Coverage** | Which source code ran, measured by instrumentation (V8 in the browser, compiler-inserted markers on the server). |
| **Code reach** | The existing feature and its table: per test, the list of files whose code ran. Kept as the file-level view of coverage. |
| **Attribution** | Assigning executed code to the test that caused it. **Per-test** coverage is attributed; **run-level** coverage is the union over a run, attributed to no test. |
| **Granularity** | What a coverage record names: **files**, **functions** (with their files) or **lines**. |
| **Level** | A granularity with an attribution, the unit costs are given for: routes, functions per test, lines per test, lines per run. |
| **Backend** | The server process of the application under test, the repository's existing term (as in backend logs). |
| **Runtime** | Where the code ran: `browser`, or `server` for code running in the backend. |
| **Statement marker** | The store the compiler inserts before each statement: `payload[i] = true`. |
| **Payload** | The compiler's term: the `bool[]` an instrumented method writes into, one entry per statement span, entry 0 meaning "the method was entered". |
| **Span table** | The compiler's list of statement spans (file, start and end line and column) per method, embedded in the assembly as the `<DynamicAnalysisData>` resource. |
| **Request id** | The value of the `X-Piwi-Coverage` response header that names one request's coverage on the backend. |
| **Collection** | The reporter asking a backend for the coverage of the request ids a test received. |
| **Fragment** | One file's coverage as one test recorded it, stored once per project and shared by every test that recorded the same. |
| **Suspect lines** | The lines changed since a failing test's last passing run that the failing tests executed, ranked by how many passing tests executed them too. |

## What exists

- **Browser code reach** (`packages/reporter/src/internal/capture/code-reach.ts`, `packages/core/src/code-reach.ts`):
  opt-in (`captureCodeReach`), Chromium only, the test's first page only. It starts `page.coverage.startJSCoverage`,
  resolves each script to source files (served by path, or through its source map) and keeps a file when one of its
  functions, not its top-level code, ran. The wire carries a `string[]` per test attempt (`codeReach`, untyped in
  `packages/core/src/wire.ts`), capped at 2,000 files.
- **Storage**: `code_reach` (`project_id, test_case_id, branch, file, origin, last_seen_run_id, last_seen_at`, unique
  on `test_case_id, branch, file`). A run replaces a test's rows on its branch; the default branch stands in for the
  others. Each execution's list is also stored content-addressed (`test_runs_cases.code_reach_payload_id`), which no
  feature reads yet.
- **Server reach is inferred, never measured**: `serverReachPairs` (`apps/application/server/utils/code-reach.ts`)
  joins, at read time, the Test Map's test → route `reaches` edges with route → handler file `handled-by` edges. For
  ASP.NET Core the handler file comes from the route manifest (`/__piwi/manifest`, read from the portable PDB).
- **Consumers**, all at file granularity with a suffix path match: impact-from-diff (`selection-impact.ts`), change
  coverage and uncovered changes (`shared/handlers/change-coverage.ts`, browser rows only plus Nitro/Nuxt
  conventions), locator preflight (`reachOfIndex`), the code index the editors read (`GET
  /api/projects/:id/code-index`, ETag), and the Test Map (`file` nodes with origin `coverage`).
- **The ASP.NET Core package** brackets each request with an `AsyncLocal` capture buffer
  (`PiwiTestLogCapture.Begin/Stop`), writes `X-Piwi-Logs` when the response starts, serves `/__piwi/manifest`, and is
  active only in Development and Test by default. **No test id ever reaches the backend**: the reporter attributes a
  response to a test because the response arrived on that test's page.
- **Playwright's `page.coverage` always uses block coverage**: `Profiler.startPreciseCoverage({ callCount: true,
  detailed: true })` (playwright-core 1.63), with no option to turn it off. Code reach reads only each function's
  first range, so it pays for block counters it never uses.
- **The editors** show code reach as one "Reached by N tests" line at the top of a file, from the code index. Neither
  client handles `.cs` files (`apps/vscode/src/glue.ts`, `apps/jetbrains/.../Glue.kt`), although `.cshtml` and
  `.razor` are listed.

## How server coverage works

### The compiler inserts the markers

Roslyn has a built-in instrumentation kind, `TestCoverage` (`Microsoft.CodeAnalysis.Emit.InstrumentationKind`, a
public API of the compiler, with no user documentation). The SDK's `Csc` task passes the MSBuild property
`Instrument` to it, so `dotnet build -p:Instrument=TestCoverage` is enough. For each method with source spans the
compiler emits, in substance:

```csharp
bool[] payload = PayloadRoot[methodRow];
if (payload == null)
    payload = Instrumentation.CreatePayload(mvid, methodRow, fileIndex, ref PayloadRoot[methodRow], spanCount);
payload[0] = true;          // the method was entered
...
payload[3] = true;          // before each statement
```

`CreatePayload` is looked up by name in the compilation's references, so a referenced package supplies it. The span
table goes into the assembly as a manifest resource, `<DynamicAnalysisData>`, whose layout Roslyn's own reader
documents (MIT, `src/Compilers/Test/Core/Metadata/DynamicAnalysisDataReader.cs`).

What the prototype confirmed on eShopOnWeb (net8.0, built with the .NET 10 SDK's compiler):

- **C# sources and Razor views are instrumented**: the views compile into `Web.dll`, and their spans point at the
  `.cshtml` lines through the Razor `#line` mapping. `Web.dll`: 972 instrumented methods, 5,779 spans, 149
  documents. The Razor generator's own files under `obj/` also appear and are dropped, like build output in the
  browser.
- **Async methods, lambdas and local functions** write into the payload of the source method that
  declares them: an `async` method's spans belong to the method, not to its state machine's `MoveNext`, and a lambda
  captures its enclosing method's payload.
- **Auto-property accessors are instrumented** by this compiler version, so they cost a call each (see the cost
  section) and an instrumented getter is no longer inlined.
- **A primary constructor's span covers the whole type declaration** (`PricingEngine(Catalog catalog)`: lines 131 to
  182). Line conversion must not read that span as "every line of the type ran" (D9).

### Attribution to a request, then to a test

The supplied `CreatePayload` decides which array a method writes into:

| Backend mode | What `CreatePayload` does | Cost after the first call |
|---|---|---|
| `run` | Returns the method's shared payload and stores it in the slot, so the compiler's code never calls back. | A load and a null check per call, a store per statement. |
| `test` | Leaves the slot empty, so it is called on every method call, and returns the payload of the request being served, or the shared one outside a request. | One call per method call. |

The request being served is an `AsyncLocal<RequestCoverage>` set by the middleware, the same mechanism as
`PiwiTestLogCapture`. To keep the per-call read cheap, the `AsyncLocal` is created with a value-changed handler that
mirrors it into a `[ThreadStatic]` field on every execution context switch; the hot path reads the thread-static
field only. Work a request starts (`Task.Run`, fire-and-forget tasks) inherits the execution context and is
attributed to that request.

The middleware gives each request a request id (`X-Piwi-Coverage: <process>.<sequence>`, written when the response
starts), keeps the request's payloads after it ends, and serves them on `POST /__piwi/coverage/collect` (a JSON array
of request ids; the answer merges them and forgets them). Kept requests are capped (5,000 in the prototype), the
oldest going first. `GET /__piwi/coverage/run` serves the run-level coverage. The reporter, which already reads
`X-Piwi-Logs` from every response a test's page receives, records the request ids per test and collects them once the
test ends. **No test id is sent to the backend and no request header is added**, so cross-origin requests trigger no
CORS preflight.

Measured isolation: 300 requests to three different pages over 16 concurrent connections, each collected alone: **0
requests contained another page's files, 0 missed their own**, and every request of the same page returned the same
file count.

### Why not an existing tool

| Option | Per-test under parallel workers | Notes |
|---|---|---|
| Coverlet (`coverlet.console`, IL rewriting with Mono.Cecil, MIT) | No: one hit array per module per process | Writes results at process exit, so a server must stop to report. Measured on the pricing application: +19% server CPU with hit counts, about +2% with `--single-hit`. |
| `dotnet-coverage` (Microsoft, profiler or static instrumentation) | Only with one worker: `snapshot --reset` per test | Closed source; collects telemetry since 18.10. Snapshots are files written through a separate process. |
| AltCover `--callContext` | No: tracks test methods running in the same process | Designed for unit tests, not for HTTP requests coming from a browser. |
| A native CLR profiler (ICorProfiler, ReJIT) | Yes, with effort | C++ per OS and architecture, `CORECLR_PROFILER` setup, conflicts with APM profilers. |
| Post-build IL rewriting of our own (Mono.Cecil) | Yes | Fixes the startup-lambda gap (below) but owns PDB rewriting and every compiler pattern. Kept as the fallback (open question 3). |
| **Compiler instrumentation + our `CreatePayload`** | **Yes** | No rewriting, no profiler; the compiler handles async methods, lambdas and Razor. C# and Visual Basic only. |

### Known gaps of compiler instrumentation

- **Lambdas created outside the request.** A lambda writes into the payload of the call that created it. An inline
  minimal API handler (`app.MapGet("/x", (…) => …)`), inline middleware or a DI factory lambda is created at startup,
  so its own lines land in run-level coverage, not in the test's. The services it calls are attributed normally.
  Measured: `/quote` (a method group handler) records `Program.cs` lines 28 to 30 per request; `/quote-inline` records
  none, and its lines appear in the run-level report. The handler file still counts as reached through the existing
  route → handler inference.
- **Work outside a request's execution context**: hosted services, queue consumers, timers started at startup. It
  counts at run level only.
- **Requests the browser never sees**: server-to-server calls behind a front-end server (BFF) are attributed only if
  that server forwards the `X-Piwi-Coverage` header, which nothing does today.
- **API tests** through Playwright's `request` fixture keep their last response's coverage only: a redirect's earlier
  responses, and a response `failOnStatusCode` turns into an error, name none. (Closed 2026-10-14: the fixtures record
  every `APIRequestContext` call and read its header, as they do a page's.)
- **SignalR and WebSocket** traffic runs inside the connection's request, so it is attributed to the test that opened
  the connection, and collected even while the connection is still open.

## What each level costs

### Server

Server CPU per request, from `/proc` over 15 to 20 seconds of closed-loop load, after a warm-up, order rotated
between rounds, the server pinned to two cores and the load generator to the other two (medians of 4 rounds):

| Application | Baseline | `run` | `test`, functions only | `test`, lines |
|---|---|---|---|---|
| eShopOnWeb, mixed pages | 7.31 ms | 6.50 ms (-11%) | 6.93 ms (-5%) | 7.51 ms (+3%) |
| Pricing application, 40-line quotes | 0.183 ms | 0.194 ms (+6%) | 0.227 ms (+24%) | 0.230 ms (+26%) |

- **eShopOnWeb spends its CPU in the framework**: Razor rendering, EF Core's in-memory provider and query
  compilation (about 80,000 methods JIT-compiled and 9.5 s spent in the JIT since startup, read during the load
  test). All variants fall within the noise, and the instrumented `run` build measured consistently cheaper than the
  baseline, which a build with the middleware but no instrumentation does not reproduce. That difference is not
  explained; read eShopOnWeb's numbers as "no measurable overhead", not as a speedup.
- **The pricing application is the upper bound**: a pricing engine of small methods, rule classes and property
  accessors, serialized to JSON, where most of the CPU is user code.
- **Per call** (one core, 50 million calls of a small non-inlined method and of an auto-property getter):

  | Mode | Method call | Getter |
  |---|---|---|
  | Not instrumented | 3.4 ns | 0.3 ns (inlined) |
  | `run` | 9.3 ns | 3.7 ns |
  | `test`, functions, inside a request | 17.7 ns | 8.2 ns |
  | `test`, lines, inside a request | 15.6 ns | 7.6 ns |

  The cost of `test` is the call to `CreatePayload` on every method call, not the statement markers: recording only
  functions costs the same as recording lines.
- **Memory**: under the eShopOnWeb load test, where nothing is collected and the store sits at its 5,000-request cap,
  resident memory was 626 MB (baseline), 629 MB (`run`), about 680 MB (functions) and about 790 MB (lines). With
  per-test collection the store holds only the requests of tests still running.

**End to end** (the number that matters): 14 Playwright tests against eShopOnWeb (browsing, filters, paging, basket,
login, checkout with a freshly registered user, order history), 5 repetitions each, 2 workers, 4 rounds, all 70 runs
passing every round:

| Backend | Wall time (median) | Sum of test durations | Change |
|---|---|---|---|
| Not instrumented | 33.9 s | 51,968 ms | |
| `run` | 33.8 s | 52,074 ms | +0.2% |
| `test`, functions | 35.2 s | 54,213 ms | +4.3% |
| `test`, lines | 35.1 s | 53,778 ms | +3.5% |

The prototype collected inside the test's teardown: 17 to 22 ms per test, 2.4% to 3.1% of a 700 ms median test. That
accounts for most of the difference, so the instrumentation itself costs between 0.4% and 1.9% of test time here;
collecting from the reporter process after the test ends (D7) takes the rest off the test's critical path.

### Browser

A script-heavy page: Vue's development build rendering a 1,000-row table of row components 30 times, plus 400
small ES modules like a dev server serves; one new browser context per run (one test), Chromium headless, medians of
7 runs after a warm-up:

| Capture | Page JavaScript | Coverage stop | Test time |
|---|---|---|---|
| None | 492 to 523 ms | | 1,330 to 1,361 ms |
| Function coverage through CDP (`detailed: false`) | +2% to +5% | 78 to 88 ms | +6.6% to +8.7% |
| Function coverage, script sources read at stop, cached per worker | +5% | 128 ms | +12.6% |
| Function coverage as shipped (debugger on from the start, see below) | about +0% to +6% | | +8% (+16% on a worker's first test) |
| Block coverage through CDP (`detailed: true`, counts) | +74% to +85% | 89 to 104 ms | +28.6% to +34.5% |
| `page.coverage`, what code reach uses today | +78% | 66 to 74 ms | +37.1% to +41.9% |

- **Function coverage reports exactly the same executed functions** as block coverage on this page (833 functions,
  no difference either way), so moving code reach to it changes no result.
- Code reach needs each script's source to apply its source map. The debugger stays on from the start of the test,
  with every pause skipped: each `Debugger.scriptParsed` event gives the script's URL and V8 content hash, and the
  source is read at that moment only when the worker has not resolved that version: 403 sources on a worker's first
  test, none after. Enabling the debugger only at stop is cheaper but wrong: it replays only the current documents'
  scripts, so an iframe's earlier document loses its sources (checked by a real-Chromium test). As shipped, on the same
  page and including the resolution, a test takes 8% longer, against 50% with `page.coverage`, with the same 137 files.
- Block coverage is what line granularity needs in the browser; its cost is V8's, not Piwi's.

#### Istanbul, the build-time alternative

Istanbul (`vite-plugin-istanbul`, `babel-plugin-istanbul`, the SWC plugin for Next.js) instruments the application's
source at build time and keeps per-statement, per-branch and per-function counters in `window.__coverage__`, read with
one `page.evaluate` at the end of a test. Measured on the same page, 9 rounds, medians:

| Capture | Page JavaScript | Test time | Data read per test |
|---|---|---|---|
| None | 561 ms | 1,382 ms | |
| Istanbul, the page's own code instrumented (app and its 400 modules, not Vue) | +3.8% | +9.1% | 439 KB |
| V8 function coverage | +7.2% | +4.7% | 349 KB |
| V8 block coverage | +85.5% | +36.7% | 395 KB |
| Istanbul with Vue instrumented too (7 rounds) | +119% | +87% | 2.5 MB |

- **Per executed statement, Istanbul's counters cost more than V8's block counters** (+119% against +85% when all the
  page's code is instrumented). It came out cheaper in the first run only because it instruments the application's
  own code and leaves the framework alone, while V8's coverage covers every script of the page. In an application
  where the framework does most of the work, Istanbul gives line and branch coverage at a fraction of V8 block
  coverage's cost; where the application's own code is the hot part, it costs more.
- **The instrumented code is 7.7 times larger** (93 KB to 721 KB here), which a page pays in download and parse.
- **It works in every browser**, while V8 coverage is Chromium-only; it gives branch coverage and original source
  positions with no source map to resolve; and it needs a separate instrumented build, like the server side.
- It fits the model without change: `fnMap` entries with a count above zero give functions, statements with a count
  above zero give lines (D13).

### The levels

| Level | Browser capture | Server capture | Cost, browser (measured) | Cost, server (measured) | Feeds |
|---|---|---|---|---|---|
| **Routes** (exists) | none | route → handler file, inferred | 0 | 0 | handler files only |
| **Functions**, per test | V8 function coverage | backend `test` mode, functions | +7% to +13% of test time, script-heavy page | under 2% of test time (eShopOnWeb); up to +24% server CPU | files and functions per test: impact, uncovered files, preflight, editor lens |
| **Lines**, per test | V8 block coverage, or Istanbul | backend `test` mode, lines | +29% to +35% of test time with V8 block coverage; +9% with Istanbul when the framework is the hot code, +87% when the application's own code is | as functions: under 2% of test time; up to +26% server CPU | line-level impact, uncovered changed lines, editor line marks |
| **Lines**, run level | (needs block coverage anyway) | backend `run` mode | n/a | +0.2% of test time (eShopOnWeb); up to +6% server CPU | run-level report, LCOV and Cobertura export |

Server lines cost the same as server functions, so the recommended combination for a scheduled job is **browser
functions, server lines**: within the 10% to 15% budget on both sides for typical applications, with line detail
where it is cheap. Browser lines stay a separate choice: V8 block coverage for a job that can afford it, or an
Istanbul build, which is cheaper when the framework does most of the work and is the only way to cover other browsers
than Chromium.

## Decisions

| D | Decision | Why |
|---|---|---|
| D1 | One coverage model for both runtimes: per test, per repository-relative file, the functions (start and end lines) and, at line granularity, the executed line ranges; the runtime is a field. | Both V8 (through source maps) and the span table resolve to file and line; every consumer joins on paths and lines. |
| D2 | Lines are the unit, never byte offsets or statement indexes; ranges are 1-based and inclusive. | Offsets and indexes depend on the build; lines map to diffs and to editor positions. |
| D3 | Each covered file carries the git blob id of the file the lines refer to, computed by the reporter from its checkout. | Lines are only meaningful against one version of the file; a blob id compares directly with git, the SCM APIs and the working copy. Suspect lines compare it with the head blob GitHub (`files[].sha`) and a local clone give; GitLab and Bitbucket give none. |
| D4 | Code reach stays and becomes the file-level view of coverage: its rows are derived from the coverage of the same run, with a new `runtime` column. | Every existing consumer keeps working unchanged, and gets server files for free. |
| D5 | Server coverage comes from the C# compiler's `TestCoverage` instrumentation and a supplied `CreatePayload`, not from IL rewriting or a profiler. | Per-request attribution with no binary rewriting, no native code, and the compiler's own handling of async, lambdas and Razor. |
| D6 | Attribution goes through the request: an `AsyncLocal` mirrored into a thread-static field, a request id on the response, collection by request ids. No test id reaches the backend. | Exact under parallel workers, no CORS preflight, and the reporter already attributes responses to tests. |
| D7 | The reporter process collects, in batches, after each test ends, never the test worker. | Keeps the 17 to 22 ms collection call out of test durations. |
| D8 | Browser code reach moves from `page.coverage` to function coverage through CDP, with the debugger on from the start and a script's source read when it is parsed, only for a version the worker has not resolved. | Same files found for a sixth of the cost (+8% per test against +50%); reading sources at stop would lose an iframe's earlier documents. Shipped. |
| D9 | Line conversion counts a statement span's lines only when the span encloses no other method's span; otherwise only its first line. | A primary constructor's or a field initializer's span covers the whole type. |
| D10 | Coverage is opt-in on both sides; the server needs a coverage build (`-p:PiwiCoverage=true`) and serves coverage only in the environments the middleware is active in. | A coverage build must never reach production, and the endpoints expose source paths and line numbers. |
| D11 | Line numbers (function ranges, executed lines) leave the machine only at the functions and lines granularities, which are opt-in; the files granularity, which `captureCodeReach` maps to, keeps sending paths only. Never source code, never hit counts. | The privacy page promises "never source code, coverage counts or line numbers" to today's users; that promise holds for them and changes only for those who choose more. |
| D12 | The code index and the reach answers gain `runtime` (`browser`, `server`) and `via` (`coverage`, `route`); `origin` stays as an alias until 1.0 (`client` for browser coverage, `server` for any server reach). | `origin: 'server'` means "inferred from the route" today; measured server coverage needs its own value without breaking the editors. |
| D13 | When a page exposes Istanbul's `window.__coverage__`, the reporter reads it at the end of the test, in any browser; for the files it covers, its counters replace V8's, and on Chromium V8's function coverage still covers the rest. | An instrumented build signals itself; it covers other browsers than Chromium, gives lines and branches, and costs less than V8 block coverage when the framework is the hot code. |
| D14 | A Nitro backend serves the contract of part 3 unchanged: the `X-Piwi-Coverage` header, the two endpoints and their answers (part 3b). | The reporter, the wire, the tables and every consumer take a Node backend with no change. |
| D15 | Nitro coverage comes from a coverage transform added to the server build (`PIWI_COVERAGE_BUILD=true`) that looks the request up once per function call through `AsyncLocalStorage`, not from V8's coverage. | V8's counters are per process: two snapshots around a request include what concurrent requests ran, and a page load always sends concurrent requests. |
| D16 | The transform counts the statements and functions `istanbul-lib-instrument` counts, and writes their original lines and the source's checksum into a span table at build time. | A file's executable lines then match Vitest's for the same file (checked under Verification), which [`combined-code-coverage.md`](../adr/combined-code-coverage.md) counts against them (its D5), and no source map is read at run time. |
| D17 | A module's top-level code records at run level; a request the server makes to itself records into the outermost request. | Nitro loads a route's chunk on its first request, and the browser receives only the outermost response. |
| D18 | A style sheet is a `runtime: 'browser'` file of the same model: at `lines`, the lines of the rules that matched an element; at `functions`, each matched rule's line range in `functions`. A grouping rule (`@media`, `@layer`, `@supports`) counts its first line only. Executable lines come from parsing the checkout's file. | Line-level impact, uncovered changed lines and the editors then take CSS with no change; Chromium reports a matching `@media` as one entry spanning its block, and lists no unused rule. |
| D19 | CSS rule usage is its own opt-in, `coverage.css: 'off' \| 'rules'`, off by default, Chromium only, read before each document is left like V8 coverage. | Its cost follows the page's style recalculation, not its scripts: +57% of test time on a CSS-heavy page where function coverage costs +4%, +9.5% on the sample app. |

## Part 1: the model, the wire and the tables

### 1.1 What one test carries

```jsonc
"coverage": {
  "v": 1,
  "files": [
    {
      "path": "src/Web/Services/BasketService.cs",   // repository-relative, POSIX
      "runtime": "server",                            // or "browser"
      "blob": "3b18e512dba79e4c8300dd08aeb37f8e728b8dad",
      "functions": [[22, 25], [31, 48]],              // start and end line of each function that ran
      "lines": [[23, 24], [33, 35], [40, 40]]         // executed lines, at line granularity only
    }
  ],
  "incomplete": false
}
```

- `incomplete` is set when a response named a request id the backend no longer had (evicted, or the backend
  restarted), when collection failed, or when a cap was hit. A consumer treats an incomplete test like a test without
  coverage: impact-from-diff widens instead of trusting it.
- The same per-attempt `codeReach: string[]` keeps going out, derived from `files`, so an older dashboard keeps
  working with a newer reporter.
- Caps: 2,000 files per test (today's code reach cap), 10,000 line ranges per test.
- Measured on eShopOnWeb at line granularity: 14 to 56 server files and 41 to 375 lines per test, about 7 KB of JSON
  per test, 1.7 KB gzipped.

### 1.2 Wire

A typed `coverage` field on the test case payload in `packages/core/src/wire.ts` (`codeReach` is untyped today), sent
with the other per-attempt fields on the streaming `complete` event and the batch fallbacks. The server sanitizes it
like `sanitizeCodeReach` does paths: the same path rules, line numbers within 1 to 1,000,000, ranges sorted and
merged, caps enforced.

### 1.3 Tables

| Table | Holds | Key |
|---|---|---|
| `coverage_fragments` | One file's coverage as one test recorded it: `runtime, path, blob, functions, lines`, content-addressed per project | unique `(project_id, hash)` |
| `test_coverage` | Which fragments a test's latest coverage run recorded on a branch, with `last_seen_run_id, last_seen_at` | unique `(test_case_id, branch, fragment_id)` |
| `run_coverage` | Run-level coverage per file: executed lines and, for server files, executable lines from the span table | `(run_id, runtime, path)` |
| `code_reach` (exists) | Gains `runtime`; rows derived from the run's coverage | unique `(test_case_id, branch, runtime, file)` |

- **Replacement** follows code reach: a test's rows on a branch are replaced by its latest run with coverage; a run
  without coverage leaves them; the default branch stands in for the others.
- **Deduplication**: many tests record the same coverage of a shared file (the layout, authentication, the basket
  component). On 14 eShopOnWeb tests, 394 test-file pairs held 83 distinct fragments (4.7 times fewer rows); the
  ratio grows with the suite.
- **Size**, estimated from those numbers: 1,000 tests reaching 200 files each (browser and server) is 200,000
  `test_coverage` rows per branch and, at that ratio, about 40,000 fragments of a few hundred bytes: tens of
  megabytes per branch, replaced, not accumulated.
- **Retention**: branch rows pruned with the Test Map's branch rows (30 days), which `code_reach` does not do today;
  fragments garbage-collected when no `test_coverage` or `run_coverage` row references them, like `case_payloads`.
- The per-execution `code_reach_payload_id`, which no feature reads, is replaced by the fragments.

## Part 2: browser capture

- **Functions**: a CDP session per covered page, `Debugger.enable` with every pause skipped, then
  `Profiler.startPreciseCoverage({ callCount: false, detailed: false })`; each `Debugger.scriptParsed` event gives the
  script's URL and content hash, and `Debugger.getScriptSource` runs only for a version the worker has not resolved;
  `Profiler.takePreciseCoverage` at stop. Shipped for code reach (files); the same resolution (`resolveCodeReach`:
  served modules, source maps, top-level exclusion) also gives each function's start and end line in the original
  file, for the functions granularity.
- **Istanbul**: when the page exposes `window.__coverage__`, its counters are read at the end of the test, in any
  browser, and replace V8's coverage for the files they cover (D13).
- **Lines**: `detailed: true`. V8 reports nested ranges with counts; a position's count is the innermost range's.
  Executed lines are the original-file lines that hold at least one position with a count above zero, through the
  source map, the conversion `c8` and `v8-to-istanbul` use. Pure logic in `packages/core`.
- **Scope**: all the test's pages, not only the first (each page gets its own session), Chromium only as today.

## Part 2b: CSS

Code reach and browser coverage record scripts only (`SOURCE_EXTENSIONS` in `code-reach.ts`), so a stylesheet maps
to no test: impact selection widens to the whole suite on any style change
(`apps/application/server/utils/selection-impact.ts`), and the uncovered-changes section cannot name a CSS line.
Chromium can tell which CSS rules matched an element during a test. Measured 2026-10-26, Playwright 1.64.1 and its
Chromium; not built.

### 2b.1 What Chromium reports

`CSS.startRuleUsageTracking`, then `CSS.takeCoverageDelta` or `CSS.stopRuleUsageTracking`, on the page's CDP session.
It needs `DOM.enable` and `CSS.enable` first: without them it starts, records nothing and returns no rule. Each entry
names a style sheet and the start and end offset of one rule in its text.

| Case | Reported as used |
|---|---|
| A rule that matched an element once, then stopped matching | Yes |
| A rule that matched an element, overridden by a more specific one | Yes, both: matching counts, not applying |
| `:hover`, `:focus-visible` | Only once the test hovered or focused a matching element |
| A rule inside an `@media` that does not match | No |
| A rule inside an `@media` that matches | Yes, and the `@media` block too, as one entry spanning the whole block (`@layer` the same) |
| An element added and removed before any style recalculation | No |
| An element inside a `display: none` subtree | No: its style is never computed |
| A rule no element matched | Not listed at all: no entry says `used: false` |

- **Reads are deltas**: a rule appears in the first read after it matched, not again.
- **What leaves the page is lost**: a `<style>` removed before a read, and every style sheet of a document the page
  navigated away from, report nothing. Reading before a document is left is what code reach already does for V8
  coverage (the `beforeunload` stop); a style sheet a script removes mid-test is lost.
- **The rules nobody used** must come from the style sheet itself: the reporter reads the file and lists its rules,
  the executable lines of part 1.

### 2b.2 From a rule to a source line

`CSS.styleSheetAdded` gives each style sheet a header: `sourceURL`, `sourceMapURL`, `isInline`, `isConstructed`,
`startLine` and `startColumn`, and the owner node. Checked case by case:

| Style sheet | What identifies the file | Lines |
|---|---|---|
| A `.css` file served by path (`<link>`, the sample app's `/assets/app.css`) | `sourceURL`, resolved against the code reach roots like a module served by path | The served text's lines, the file's own |
| A `<style>` in the HTML | `sourceURL` is the page; `isInline: true`, `startLine` its position in the HTML | Offsets in the `<style>` text, shifted by `startLine` |
| Vite in development, a plain `.css` import | No `sourceURL`; the owner `<style>`'s `data-vite-dev-id` is the file's absolute path | Kept as is: `.title` read at lines 2 to 5, its lines in the file |
| Vite in development, a scoped `<style>` of a `.vue` file | `data-vite-dev-id` is `App.vue?vue&type=style&index=0&scoped=…` | Lines inside the `<style>` block (2 to 5); with `css.devSourcemap: true`, the inline map gives the `.vue` file's lines (10 to 13) |
| A constructed style sheet (`adoptedStyleSheets`, CSS-in-JS) | Nothing: `isConstructed: true`, no URL, no owner | None |
| A Vite production build (8.3.5, `build.sourcemap: true`) | A hashed bundle, `index-<hash>.css` | None: minified to one line, and no CSS source map is written even with `build.sourcemap` |
| Tailwind 4 utilities (`@import "tailwindcss"`) | `data-vite-dev-id` is the app's `tw.css` | With a map, every utility maps into `tailwindcss/index.css` in `node_modules`, never into the application |

So CSS lines are available where the style sheets are served as written or with a development map: a development
server (Vite, Nuxt), or an application that serves its CSS files by path. Against a production build, CSS gives
nothing; a scoped `.vue` style without `css.devSourcemap` maps once the `<style>` block's first line in the file is
added, which the reporter can read from the checkout.

### 2b.3 What it costs

One new browser context per run, Chromium headless, medians of 7 runs after a warm-up, the five variants rotated
between rounds:

| Capture | CSS-heavy page | Sample app (3 pages) |
|---|---|---|
| None | 1,551 ms | 319 ms |
| Function coverage as code reach captures it | +4.4% | +16.3% |
| `DOM.enable` and `CSS.enable` only | +1.5% | +4.0% |
| CSS rule usage | +57.0% | +9.5% |
| Both | +56.2% | +20.3% |
| Time to read the last delta | 63 to 71 ms | 4 to 6 ms |
| Read over CDP per test | 2,861 used rules, 250 KB | 90 used rules, 7.7 KB |

- **The cost is in style recalculation**, not in the reads: on the CSS-heavy page, five full re-renders of 3,600
  elements against 2,081 rules take 139 ms without capture, 153 ms with `CSS.enable` only, and 494 ms with tracking
  on (3.5 times). It grows with the selector matching a page does, so a page with large style sheets and frequent
  re-renders pays most.
- **On the sample app it costs less than function coverage**, whose fixed setup (the debugger) weighs on a 320 ms
  test.
- The CSS-heavy page: a 2,081-rule style sheet like a component library's (16 components, 8 variants, hover and
  focus states, size combinations, 640 `[data-v-…]` scoped selectors, 400 utility classes), 3,600 elements rendered
  by script, five re-renders with other classes, 20 hovers, 10 focus moves, a navigation to a second page with the
  same style sheet and three more re-renders. A second series, run on a busier machine, gave +49.3% and +55.0%.

### 2b.4 In the model and the consumers

- **One more file kind, the same model** (D1): a style sheet is a `runtime: 'browser'` file. At `lines`, `lines` are
  the lines of the rules that matched; at `functions`, each matched rule's line range goes in `functions`, a rule
  being to a style sheet what a function is to a script (D18). A grouping rule (`@media`, `@layer`, `@supports`)
  counts its own first line only, never its block, as D9 does for a statement that encloses a method.
- **Executable lines**: the reporter parses the checkout's file for its rules, as the span table gives them on the
  server; a file is `.css`, `.scss`, `.less` or a `.vue` file's `<style>` blocks.
- **Impact selection**: with `functions`, the line-level impact of part 4 needs no change: a changed line inside a
  rule a test matched selects that test, and a change outside every known rule (a new rule) stays at file level.
  Today the same change runs the whole suite.
- **Uncovered changed lines** name CSS lines no test matched, in the pull-request comment and
  `get_change_coverage`; the editors mark `.css` files and `.vue` style blocks like scripts.
- **Opt-in on its own** (D19): `coverage.css: 'off' | 'rules'`, off by default, because its cost depends on the
  page's styling, not on its scripts, and can pass +50% where function coverage costs +4%.

### 2b.5 Limits

- **Chromium only**, like V8 coverage.
- **States the tests never reach**: a `:hover` never hovered, a breakpoint never rendered, a dark theme never set,
  all read as unused. That is what they are for the suite, but a viewport or color scheme the suite never runs in
  makes whole blocks read as dead code.
- **Utility CSS** (Tailwind) maps into the framework, so it gives nothing per application file; the classes a test
  used are in the templates, which code reach already covers.
- **CSS-in-JS and constructed style sheets** have no file.
- **Production builds** have no CSS map in Vite: CSS coverage needs a development server or CSS served as written.
- **A style sheet removed mid-test** loses what it recorded since the last read.

## Part 3: server capture (ASP.NET Core)

### 3.1 The package

A new NuGet package, `PiwiTests.Instrumentation.Coverage` (MIT, under `integrations/aspnetcore`, net8.0, net9.0 and
net10.0, no ASP.NET Core dependency, like `.Core`):

- the public `Microsoft.CodeAnalysis.Runtime.Instrumentation` type with both `CreatePayload` overloads (single file and
  multiple files);
- the recorder: modules by MVID, shared payloads, per-request payloads, the `AsyncLocal` and its thread-static mirror;
- the span table reader, adapted from Roslyn's MIT reader, refusing any format version but 0.1 and 0.2;
- `build/PiwiTests.Instrumentation.Coverage.props`, which sets `<Instrument>TestCoverage</Instrument>` only when
  `PiwiCoverage` is `true`.

A team adds the package to every project whose code it wants covered (a `Directory.Build.props` item does it for a
solution) and builds the test environment with `dotnet build -p:PiwiCoverage=true` or `dotnet publish
-p:PiwiCoverage=true`. Without the property the package adds one unused type and nothing else.

### 3.2 The middleware

`UsePiwiTestLogs()` gains the coverage bracketing when an instrumented module is loaded, inside the same
environment guard:

- per request: a `RequestCoverage`, the `AsyncLocal` set, the request id written in `OnStarting` (only when an
  instrumented method ran before the response started, which leaves static files unnamed), the request kept after it
  ends;
- `POST /__piwi/coverage/collect` and `GET /__piwi/coverage/run`, beside `/__piwi/manifest`;
- `PIWI_COVERAGE_MODE` (`test` by default in a coverage build, or `run`);
- a cap on kept requests in bytes as well as in count, the oldest evicted first, an evicted id answering as missing so
  the test is marked `incomplete`;
- a warning in the log when an instrumented assembly runs in an environment where the middleware is not active.

The answer is the model of part 1 with `path` relative to the repository root, through the same `PiwiSourceFiles`
rules as the manifest (nearest `.git` above the content root, else the content root, the deterministic `/_/` root
read as the repository root). Files under `obj/` and generated sources are dropped.

### 3.3 The reporter

- The capture fixtures record the `X-Piwi-Coverage` values of a test's responses, per origin, beside `X-Piwi-Logs`,
  and attach them (`piwi-server-coverage-requests`, internal, never uploaded).
- The reporter process collects after `onTestEnd`, several tests per call, from each origin the ids came from (the
  base URL in practice, the origin `/__piwi/manifest` is already fetched from), merges the answer into the test's
  `coverage`, and computes each file's blob id from the checkout, cached per run, through `git hash-object` so
  line ending conversion (`core.autocrlf`) gives the id git stores; it hashes the file itself only without git.
- Options: `coverage: { browser: 'off' | 'files' | 'functions' | 'lines', server: 'off' | 'files' | 'functions' |
  'lines' }`, with `PIWI_COVERAGE_BROWSER` and `PIWI_COVERAGE_SERVER`. `files` costs what `functions` costs and sends
  paths only; `captureCodeReach: true` stays as an alias of `browser: 'files'`. At run end the reporter also fetches
  `/__piwi/coverage/run` for `run_coverage`.

## Part 3b: server capture (Nitro and Nuxt)

This part answers open question 5 (2026-10-26). A Nitro backend serves the contract of part 3 unchanged: the
`X-Piwi-Coverage` header, `POST /__piwi/coverage/collect`, `GET /__piwi/coverage/run` and the same answers (D14). The
reporter, the wire, the tables and every consumer then take it with no change; only the backend side is new, in
`@piwitests/instrumentation-nitro`: a **coverage transform** in its module (the build step that inserts the markers
into the server's JavaScript, the role the C# compiler plays in part 3) and a recorder in its plugin. Built 2026-10-26
for Nitro (delivery PR 9) and checked on the sample application's Nitro backend, beside its ASP.NET Core one (3b.8);
a Nuxt application's server rendering (3b.5, PR 10) is not built.

### 3b.1 Why V8's own coverage cannot attribute

V8 keeps one set of counters per isolate. `Profiler.takePreciseCoverage`, through `node:inspector`, `NODE_V8_COVERAGE`
or `c8`, reads and resets them for the whole process. Two snapshots around a request also count what every other
request in flight ran meanwhile, and a single page load sends several requests at once (the page, its `useFetch`
calls, its API calls), so even one Playwright worker makes requests overlap. Each snapshot also walks every function
of every loaded script, the framework and `node_modules` included. V8's coverage remains the right tool for one
report of the whole run, not for per-test attribution.

| Option | Per-test under parallel workers | Notes |
|---|---|---|
| V8 precise coverage (`node:inspector`, `NODE_V8_COVERAGE`, `c8`) | No: one set of counters per process | Exact for the run; per request only when requests never overlap, which a page load breaks. |
| `istanbul-lib-instrument` as it is | No: one counter object per file per process (`cov_<hash>()`) | Making that object per request means a request lookup at every statement. |
| One backend per Playwright worker, a V8 snapshot per test | Yes | One backend to start per worker, and a snapshot of every loaded function per test. |
| **A coverage transform that looks the request up once per function call** | **Yes** | The scheme of part 3, written in JavaScript. |

### 3b.2 The transform

The package's Nitro module (`@piwitests/instrumentation-nitro/module`, already used for the route table) adds a Rollup
plugin to the server build when `PIWI_COVERAGE_BUILD=true` is set at build time (D15). Nitro builds the server with
Rollup both in development (`nitro dev`) and for production, so one plugin covers both.

- **What it instruments**: the modules Rollup inlines in the server bundle, under the repository root, outside
  `node_modules` and outside generated code (`.nuxt/`, `.nitro/`, `.output/`, virtual modules). A dependency Nitro
  keeps external is never transformed. Include and exclude globs, matched like coverlet's `ExcludeByFile`, narrow it.
- **Where in the build**: after Nitro's esbuild step, so the plugin reads JavaScript, never TypeScript, and
  `this.getCombinedSourcemap()` maps each position back to the original file. A coverage build turns Nitro's
  `sourceMap` option on so that map exists.
- **What it inserts**, in substance, in each function (declarations, expressions, arrows, methods, getters and
  setters):

  ```js
  import { __piwiModule } from '@piwitests/instrumentation-nitro/coverage-runtime';
  const __piwi_m = __piwiModule('9c4e1f0a', [1, 4]);  // the file's id, the payload length of each function

  export function quote(items) {
    const __piwi_p = __piwi_m.f(1); __piwi_p[0] = 1;   // the function was entered
    __piwi_p[1] = 1; let total = 0;                    // before each statement
    for (const item of items) { __piwi_p[2] = 1; total += price(item); }
    __piwi_p[3] = 1; return total;
  }
  ```

  Each function writes into a **payload**, a `Uint8Array` playing the part of the compiler's `bool[]`: entry 0 means
  the function was entered, each other entry one statement. Which statements and functions count follows
  `istanbul-lib-instrument`'s visitor, the statements Vitest's coverage also counts through `ast-v8-to-istanbul`, and
  a statement counts at its first line (a variable's at its initializer's), as Istanbul's line coverage does (D16). On
  the sample application the executable lines are Vitest's exactly (3b.8). The transform is its own walk over
  Rollup's AST with `magic-string`, not Istanbul's code. Branches, hit counts and class field initializers are not
  recorded.
- **The span table**: each instrumented file's repository-relative path, the sha256 of its source (the `checksums`
  the reporter already checks), and, per function, its line range and the line of each statement in the original
  file. The module adds a generated plugin that hands it to the recorder at startup; the table is written into that
  plugin's chunk once the bundle is rendered, when every module is transformed. A module carries only its file id and
  the payload lengths. No source map is read at run time.
- **Lines are first lines**, so D9 needs no counterpart: `export default defineEventHandler(async (event) => { … })`,
  one statement over the whole file in other tools, is no statement at all for Istanbul, and the handler's own
  statements count at their lines.

### 3b.3 Attribution

`__piwi_m.f(i)` returns function `i`'s payload for the request being served, found through the plugin's
`AsyncLocalStorage` (the store the log capture already uses, `integrations/nitro/src/index.ts`), or the shared payload
outside a request. It runs once per call, at entry; the statements then write into a local variable.

- **Every function looks the request up itself**, so a handler created when its module loads and called by a request
  records into that request: part 3's gap on lambdas created outside a request does not exist here.
- **An `async` function keeps the payload of the call that started it** across its `await`s. A callback a request
  schedules (a promise, `setTimeout`, `event.waitUntil`) runs in that request's async context and records into it.
- **A module's top-level code** records at run level, always (D17). Nitro loads a route's chunk on the route's first
  request; without the rule, the first test to reach a route would own the module's initialization.
- **A request the server makes to itself** (`$fetch` or `useFetch` during server rendering, which Nitro serves in the
  same process) records into the outermost request, whose response the browser receives (D17). The plugin already
  nests its log and span stores that way.
- **Work after collection**: once a request is collected, what it still runs (a promise not awaited) records at run
  level.
- In `run` mode (`PIWI_COVERAGE_MODE=run`, as in part 3), `__piwi_m.f` returns the shared payload without looking the
  request up, and no response is named.

### 3b.4 The plugin

The plugin (`export { default } from '@piwitests/instrumentation-nitro'` in `server/plugins/`) serves coverage under
the guard it already applies to logs and the route manifest: `NODE_ENV` set to `development` or `test`, or
`PIWI_TEST_LOGS_DISABLED=false`.

- **The header**: `X-Piwi-Coverage: <process key>.<sequence>.<secret>`, the .NET format, set when the response starts
  and only when instrumented code ran for the request, so a static asset gets none. The plugin sets its headers in a
  `res.end` patch today; the coverage header goes through `res.writeHead`, which `write` and `end` both reach, so a
  streamed response is named too.
- **The endpoints**: `POST /__piwi/coverage/collect` and `GET /__piwi/coverage/run`, beside `/__piwi/manifest`, with the
  ASP.NET Core package's answers, limits and eviction (1 MB and 10,000 ids per call; 5,000 kept requests and about
  64 MB, the oldest evicted first; `instance` naming the process).
- **Run-level executable lines** come from the span table, so they cover every file in the bundle, including routes no
  request loaded.
- **Guards**, as D10: in a coverage build, the plugin throws at startup when `NODE_ENV` is `production` and coverage is
  not explicitly enabled (`PIWI_TEST_LOGS_DISABLED=false`), and logs a warning in any other environment it is not
  active in. `nitro build` replaces `process.env.NODE_ENV` with `"production"` in the bundle, so a built server always
  needs the explicit setting, as the log capture already does.
  `PIWI_COVERAGE_FORBIDDEN=true` at build time makes a coverage build fail, for a production pipeline to set.

### 3b.5 Nuxt

A Nuxt application has two server bundles:

- **Its `server/` directory** (API routes, middleware, server plugins, `server/utils`), built by Nitro: covered by the
  module above, listed under `nitro.modules`, with the plugin in `server/plugins/`. First step.
- **Its Vue application rendered on the server** (pages, components, composables, plugins), built by Vite's server
  build, which Nitro then bundles as it is. The same transform, added as a Vite plugin by a Nuxt module
  (`addVitePlugin(…, { client: false })`, after Vite's own transforms so a `.vue` file maps to its own lines), records
  it with `runtime: 'server'`. The same files' browser side stays with code reach (`runtime: 'browser'`). Second step.

### 3b.6 What it costs

Per call, measured on a micro-benchmark of the code the transform would insert: 50 million calls of a small function
in one loop, each variant in its own process, medians of 5 runs.

| Call | Node 22.22 | Node 24.11 |
|---|---|---|
| Small function, not instrumented | 1.1 ns | 0.9 ns |
| `run` mode | 1.1 ns | 1.1 ns |
| `test`, outside a request | 3.9 ns | 4.6 ns |
| `test`, functions, inside a request | 5.5 ns | 11.3 ns |
| `test`, lines, inside a request | 6.1 ns | 12.7 ns |
| `test`, lines, after an `await` | 9.7 ns | 13.1 ns |
| Getter, not instrumented | 0.7 ns | 0.4 ns |
| Getter, `test`, inside a request | 5.1 ns | 12.5 ns |

- **The cost of `test` is the request lookup at entry**, not the statement markers: recording only functions costs
  about what recording lines costs, as on .NET.
- **`run` mode costs nothing measurable** when the payload is a module constant. The built recorder still calls
  `__piwi_m.f`, which returns at once in `run` mode: at most the cost of `test` outside a request.
- **Node 24 reads `AsyncLocalStorage` through `AsyncContextFrame`**, its default: twice the cost per lookup of Node 22
  in this loop, but no promise hooks, which Node 22 runs on every promise once a store is in use (the log capture
  already pays that today).
- **With inlining turned off** (`--max-inlined-bytecode-size=0`), the bound for code V8 does not inline: lines inside
  a request cost 14.8 ns per call against 4.0 ns on Node 22, and 18.9 ns against 4.4 ns on Node 24. The .NET recorder
  costs 15.6 ns to 17.7 ns per call and stayed under 2% of test time on eShopOnWeb.
- **Not measured yet**: the end-to-end cost on a Playwright suite, the server CPU of an application whose CPU goes to
  its own code (the pricing application's case), and how much the transform grows the bundle.

### 3b.7 Known gaps

- **Code the build does not inline**: a dependency Nitro keeps external, including a workspace package it resolves
  through `node_modules`, is covered only once listed in Nitro's `externals.inline`.
- **Callbacks that lose the async context**: a library that queues callbacks without `AsyncResource` (some connection
  pools) runs them outside any request, so the application code they call records at run level. The log capture has
  the same gap today.
- **Generators** record into the request that created them, even when another request resumes them.
- **Server-to-server calls** to another process count only if that server forwards the header, as on .NET.
- **Runtimes other than Node**: the recorder needs Node's `AsyncLocalStorage`; Bun, Deno and the edge presets are not
  covered.

### 3b.8 Both backends of the sample application

The sample application (`examples/sample-app`) serves the same pages and API from an ASP.NET Core and a Nitro backend,
and one Playwright suite runs against either. Both now run a coverage build, and both have unit tests of their
services (xUnit, and Vitest under `backends/nitro.tests`), uploaded as the `unit-back` suite for combined coverage.
One run of the suite each, against the dashboard, on the same commit:

| Recorded | ASP.NET Core | Nitro |
|---|---|---|
| Tests with server coverage | 28 | 29 (one more spec runs: server spans) |
| Server files across the tests' coverage | 8 | 18 |
| Server files per test, on average and at most | 2.5, 4 | 3.1, 8 |
| *Placing an order*: server files | 4 | 8 |
| Files with executable lines (run level) | 9 | 20 |
| Executable lines | 121 | 94 |
| Run by the Playwright suite | 117 | 90 |
| Run by the unit tests | 47 | 46 |
| Run by both, by the unit tests only | 46, 1 | 46, 0 |
| Back-end functions known, run by the Playwright suite | 47, 45 | 29, 27 |

- **The same features on both**: per-test files, functions and lines with their git blob ids (every checksum matched
  the checkout), run-level coverage with executable lines, combined coverage with the unit tests, and the `front` and
  `back` areas.
- **The Nitro backend has more, smaller files**: one per route (`routes/api/orders.post.ts`), where ASP.NET Core
  groups its endpoints in two classes, so a test names more files for the same path through the code.
- **Executable lines are Vitest's**: on the 33 files of the Nitro backend, the coverage build's 94 executable lines
  and the 94 lines of Vitest's LCOV report are the same, file by file, so both suites count on one set of lines.
- **Fixed on the way**: the sample's `server-coverage` spec expected a request id of two parts, which neither backend
  sends (both send `<process key>.<sequence>.<secret>`), and `1.0-stabilization.md` named the same two-part form.

## Part 4: consumers

- **Impact-from-diff** reads `test_coverage` when the covered blob is the base side of the diff: a changed or deleted
  line of the old version selects the tests that executed it; an added line selects the tests that executed the
  function around it; a file whose blob does not match falls back to file level. Unmapped files still widen to the
  whole suite.
- **Uncovered changes** counts lines, not only files, and covers server files directly instead of only Nitro and
  Nuxt conventions; the pull-request section and `get_change_coverage` name the uncovered changed lines.
- **The gate**: `--max-uncovered-changes` gains a line form; still warn-only.
- **Locator preflight** keeps reading the code index; server files now appear in it.
- **The Test Map** writes server `file` nodes with origin `coverage`, as for browser files; scenario-gap detectors
  keep excluding coverage edges, as today.
- **Export**: run-level coverage as LCOV (one `TN:` section per test is possible) and Cobertura, for Sonar, Codecov or
  any tool already in place.
- **MCP**: `get_coverage` (a file's lines and the tests behind them, or a test's files), read-only.

## Part 5: the editors (later)

What the editor service needs exists or is small:

- A **coverage index** next to the code index: per file, its blob, its executable and executed lines, and per line
  range the tests that executed it, served with an ETag per file (`GET /api/projects/:id/coverage?file=&branch=`), so
  an editor fetches what it opens, not the whole project.
- **Line mapping**: the editor service already diffs application files against `HEAD` for locator-break anchors.
  When the working copy's blob differs from the coverage's, lines are mapped through that diff and changed lines are
  marked "changed since the coverage run" rather than guessed.
- **What the clients draw**: executed and never-executed marks in the gutter, a lens or Code Vision line per function
  ("Reached by 6 tests · Run them", using the existing `piwi/runArgs` path), the tests behind a line on hover, and an
  "uncovered changed lines" mark, the item [`adr/suite-in-the-editor.md`](../adr/suite-in-the-editor.md) left for
  later (priority 4).
- **`.cs` support**: add `cs` to the supported extensions in both clients. The JetBrains plugin is already verified on
  Rider (`RD:2026.2.2`) and its Code Vision provider has no language restriction.
- **Local runs with coverage**: `RunCommand.env` already reaches the Playwright process on every run path; adding
  `PIWI_COVERAGE_SERVER` to it lets "Run the tests that reach this function" refresh that function's marks.

## Part 6: what to build on it

Coverage is an input, not a feature. This part lists what it makes possible, ordered by Piwi's four purposes
([`ROADMAP.md`](../ROADMAP.md)), with the level each item needs. One item was tried on the prototype's data
([Appendix C](#appendix-c-suspect-lines-on-eshoponweb)).

### 6.1 Explain the failures

- **Suspect lines.** The lines changed since the last passing run that the failing tests executed, ranked by how many
  passing tests executed them too (the Ochiai score of spectrum-based fault localization). Tried on eShopOnWeb with a
  commit changing 13 lines in 4 files, one change being an "add instead of set" bug: **the failing test executed 3
  of the 13 changed lines, exactly the bug's hunk**, and none of the other changes. Coverage alone, without the diff,
  ranked the bug line about 36th of the 235 lines the failing test executed: the value comes from joining the two.
  Where it shows:
  - the cluster's *What changed* line and the situation block: "Of 13 lines changed since the last green run, 3 ran
    in this test: `BasketService.cs` 57 to 59";
  - **AI diagnosis**: the patches sent to the model are filtered to the hunks the failing tests executed, first in the
    budget, so a large diff stops being truncated before it reaches the relevant change (`ai-context.ts` cuts patches
    to a byte budget today);
  - the fix plan and `get_fix_plan`, and the editors' failure view, which can mark those lines.
  Needs: lines on the side the change is on; functions give a coarser version (changed functions the failing tests
  ran).
- **Flaky divergence.** Coverage per attempt: the functions a failing attempt executed and a passing attempt did not,
  and the reverse, on the Attempts tab ("the failing attempts took the retry branch in `PaymentClient.cs` line 88").
  The Flake Lab can then aim its conditions at that code. Needs: functions per attempt.
- **Narrower bisect.** The generated `git bisect` can restrict itself to the commits that touch files the failing test
  executed (`git bisect start <bad> <good> -- <paths>`), so fewer steps build and run. Needs: files.
- **Cluster hints.** Two clusters whose suspect lines are the same are likely one cause; a cluster whose tests share
  no suspect line is likely two. Shown as a suggestion, never applied. Needs: lines.

### 6.2 Hand back a fix

- **Fix verification with evidence.** A cluster recorded as fixed says whether the fixing commit changed lines its
  failing tests executed: the line between "stopped failing" and "the diagnosed change is what fixed it" gets a
  measured basis.
- **The owner of the code, not only of the test.** The `CODEOWNERS` entry of the suspect lines suggests who should
  look, next to the test's owner, in the pull-request comment and in notification routing.
- **Missing tests from the nearest test.** For uncovered lines, `draft_scenario` and the write-the-missing-test skill
  receive the test that executes the most of the same function: the best one to copy and change, with the lines its
  copy must reach.

### 6.3 Find what the tests miss: gaps at the code level

The Test Map knows the surface (routes, pages, controls) and which tests reach it. Coverage adds what is behind the
surface: the code of each feature, executed or not. Two consequences:

- **Each feature gets its code.** The browser and server files and functions its tests execute, shown on the feature
  map and in the feature graph. Server code has a **known denominator**, every statement in the span table, so a
  ratio is allowed there under the Test Map's rule "a percentage only over a surface with a known denominator"
  ([`test-map-accuracy.md`](test-map-accuracy.md), D3): "Checkout executes 41 of the 63 statements of
  `OrderService.cs`". Browser code has a denominator only for the scripts a page loaded.
- **New and sharper detectors.** Coverage says what ran, never what was checked, so its detectors are *blind-spot* or
  *fragile*; *false-comfort* still needs probes or assertions.

| Detector | Class | Finds | Needs | Example evidence |
|---|---|---|---|---|
| **Error path never executed** (new) | blind-spot | a `catch` block, a `throw`, or an error return (`return NotFound()`, `Results.Problem`) inside a method the tests execute, that never ran in the last 30 runs: the code-level form of *Success only* | server lines; a statement classification from a syntax scan of the file | `OrderService.cs` 88 to 93, `catch (PaymentException)` · method run by 6 tests · block never |
| **Branch never taken** (new) | blind-spot | an `if`, `else` or `switch` arm inside an executed method that never ran, with the condition as the scenario to write | lines | `if (order.IsGift)` · method run by 4 tests · branch never |
| **Code nobody executes** (new) | blind-spot | a server function no test executed in the last 30 runs, ranked by exposure: dead code or a missing test | server functions, span table | `RefundService.Partial` · 0 tests in 30 runs · 7 commits in 90 days |
| **Single covering test** (sharper) | fragile | a function exactly one trusted test executes, or only flaky and quarantined tests do | functions | `Only checkout › coupon executes CouponRules.Apply` |
| **Incidental execution** (new) | fragile | code executed only by tests tagged with another feature: covered by accident, as *Incidental catch* is for failures | functions, `piwi:feature` tags | `Invoices code executed only by Checkout tests` |
| **Background code never run** (new) | blind-spot | the methods of a hosted service, job or queue consumer that never ran, from run-level coverage | server run level | `NightlyExportJob.ExecuteAsync` · never in 30 runs |
| **Changed, unreached** (sharper) | blind-spot | changed lines, not only files, no test executed, server files included without file conventions | lines | `+41 −3 · 12 changed lines never executed` |
| **Not noticed** (sharper) | false-comfort | as today; a probe run picks the tests that execute the targeted handler instead of every test reaching the route, and names the lines the fault replaced | functions | `A probe (status-500) on POST /api/orders did not make checkout › pay fail` |

- **Exposure per function.** Churn, age and escape history computed for the functions a gap names, from the hunks
  that touched them, instead of for whole handler files: a gap in a function that changed six times this quarter
  ranks above one in a stable function of the same file.
- **Coverage plus probes is close to mutation testing.** Coverage names the code each test executes; a server probe
  that breaks that code and leaves those tests green is the false-comfort evidence. Targeting probes from coverage
  keeps probe runs short.

### 6.4 Selection and CI

- **Line-level impact** (part 4) and **prioritization**: run first the tests that executed the changed lines, so a
  failing pull request fails in the first minute, not the twentieth.
- **Smoke mining over code**: the greedy set cover that mines a smoke suite over observed routes today can cover
  functions instead, front and back, under the same time budget.
- **Redundant tests**: a test whose executed functions and visited pages are both contained in another test's is a
  merge candidate, listed with the evidence, never removed.

### 6.5 History and reports

- **Coverage trends** per feature, kept in the daily rollups, in quality reports and dashboards: "changed code this
  sprint executed by a test: 82%".
- **Run-level reports** exported as LCOV or Cobertura (part 4) for tools already in place.

### 6.6 Order

| Order | Item | Level it needs | Why first |
|---|---|---|---|
| 1 | Suspect lines in the cluster page, AI diagnosis and fix plan | server lines, browser functions | Strongest effect on Piwi's main purpose; tried on real data |
| 2 | Uncovered changed lines and line-level impact | lines | Already designed in part 4 |
| 3 | Error path never executed, code nobody executes, single covering test by function | server lines and functions | Server code has a denominator; the gaps name exact lines |
| 4 | Feature code on the feature map | functions | Builds on 3 |
| 5 | Flaky divergence | functions per attempt | Needs coverage on the runs where flakes happen, not only the scheduled job |
| 6 | Editors (part 5) | lines | The index and the clients |
| 7 | Bisect paths, prioritization, smoke over code, redundant tests | files and functions | Small each; after the rest proves the data |

### 6.7 What coverage does not close

- **Executed is not checked.** A line every test runs can still be wrong with every test green; that is what probes
  and the assertion detectors are for.
- **Coverage is as fresh as the last run that captured it.** On a scheduled job, a test's coverage can be a day old;
  suspect lines and impact say which run the coverage came from.
- **What the capture cannot see**: calls behind a
  front-end server that does not forward the header, other browsers than Chromium, Node backends until part 3b is
  built (and those it does not cover, part 3b.7), and the startup lambdas of part 3.

## Delivery

| PR | Content | Needs |
|---|---|---|
| 1 | Core: the coverage model, sanitizing, fragment hashing, line-range encoding, V8 function and block conversion | none |
| 2 | Reporter, browser: function coverage through CDP for code reach (same results, lower cost), the bench variant, the docs' cost section | 1 |
| 3 | Dashboard: the wire field, `coverage_fragments`, `test_coverage`, `run_coverage`, `code_reach.runtime`, retention, demo seed, privacy page | 1 |
| 4 | .NET: `PiwiTests.Instrumentation.Coverage`, the middleware endpoints, tests (attribution under concurrency, span table on SDKs 8, 9 and 10, Razor mapping, D9) | none |
| 5 | Reporter, server: request ids, batched collection, the `coverage` option | 3, 4 |
| 6 | Browser lines: block coverage to lines | 2, 3 |
| 7 | Consumers: line-level impact, uncovered changed lines, gate, `get_coverage`, LCOV and Cobertura export | 3 |
| 8 | Editors: the coverage index, line marks, function lens, hover, `.cs`, coverage on local runs | 3 |
| 9 | Nitro (part 3b): the transform in the module, the recorder and the endpoints in the plugin, the sample application's Nitro backend built for coverage, tests (attribution under concurrency, each function form, D9, D17), the end-to-end cost, the docs and the `1.0-stabilization.md` entries for `PIWI_COVERAGE_BUILD` and `PIWI_COVERAGE_FORBIDDEN` | 5 |
| 10 | Nuxt (part 3b.5): the Vue server build through a Vite plugin | 9 |
| 11 | CSS (part 2b): rule usage through CDP, the `coverage.css` option, style sheets parsed for their rules, the sample's stylesheet | 2, 3 |

PR 2 is worth shipping alone: it cuts the cost of today's code reach with no change in what it finds. Each PR carries
its docs (`code-reach.md`, `backend-logs.md`, `privacy.md`, the reporter options reference).

## Verification

- **Attribution**: concurrent requests to different pages, each collected alone, never share a file (the prototype
  check, as a .NET test).
- **Granularity**: a fixture application with a method group handler, an inline handler, an async method, a lambda,
  a primary constructor and a Razor view, with the expected functions and lines per request.
- **Cost**: the eShopOnWeb suite and the pricing application, kept as a benchmark job like `reporter:bench`, comparing
  the levels on the same machine; the browser bench gains a function-coverage variant.
- **Cross-runtime**: one test that reaches a Razor page and its JavaScript records both runtimes in one `coverage`.
- **Nitro** (part 3b): the attribution check against the sample application's Nitro backend
  (`examples/sample-app/backends/nitro`), with requests that nest (`$fetch` from a handler) and that continue after the
  response; on a few TypeScript files, the span table's executable lines compared with Vitest's (v8 provider); the
  end-to-end cost on the sample suite and on a Nuxt application, with the backend built with and without the
  transform.

## Risks

- **The compiler feature is public API with no user documentation.** Its span rules can change between SDKs
  (auto-property accessors are instrumented by the .NET 10 SDK's compiler). Mitigation: the span table reader
  checks the format version, and the fixture tests run on every supported SDK.
- **A coverage build differs from the production build**: getters are no longer inlined, methods grow. The tests run
  against slower code than production; the measured costs bound it.
- **Startup lambdas and background work** are attributed to no test. The run-level report still counts them, and the
  route → handler inference still covers handler files.
- **Memory on the backend** grows with requests not yet collected; the cap in bytes bounds it.
- **Exposure**: the endpoints serve paths and line numbers. They live only where `/__piwi/manifest` already lives,
  under the same guard.
- **Browser line granularity** costs what V8's block coverage costs (+29% to +35% of test time on the measured page),
  beyond a 10% to 15% budget for script-heavy applications. It stays a separate, explicit choice.

## Open questions

1. Should browser code reach switch to function coverage before the rest (PR 2 alone)? The measurement says yes.
2. Should backend `run` mode be cheap enough to leave on in every test environment, to produce a run-level report on
   every CI run, with per-test coverage on the scheduled job only?
3. Is the startup-lambda gap acceptable? If minimal API applications with inline handlers lose too much, a post-build
   IL rewriter (Mono.Cecil) that adds a request lookup to each lambda is the fallback, at the cost of owning PDB
   rewriting.
4. ~~Should a per-test `request` fixture wrapper (API tests) land with PR 5, or with the API shapes plan?~~ Answered
   2026-10-14: neither; it shipped on its own, before the API shapes plan, which builds on it.
5. ~~Node backends (Nitro): V8's own coverage is per process, so per-request attribution needs a build-time transform
   whose counters read `AsyncLocalStorage`. The model, the header and the endpoints of this plan are runtime-neutral;
   should the Nitro package follow the same contract?~~ Answered 2026-10-26: yes, part 3b (D14 to D17).

## Not in this plan

- Branch (condition) coverage and hit counts: executed or not is what selection and the editors need.
- Coverage of the test code itself. Coverage of unit tests (`dotnet test`, Vitest), combined with this plan's into one
  ratio per commit, is [`combined-code-coverage.md`](../adr/combined-code-coverage.md).
- F#, which the compiler instrumentation does not cover.
- Mutation testing, and any percentage target or gate that fails a build on coverage.

## Appendix A: measurements

Environment: a 4-core sandbox, 15 GB of memory, Ubuntu 24.04; .NET 10.0.402 SDK (its C# compiler) building net8.0
applications run on .NET 8.0.32; Node 24; Playwright 1.63 with its headless Chromium. The server was pinned to two
cores (`taskset -c 0,1`), the load generator or Playwright and Chromium to the other two.

- **Server CPU per request**: a closed-loop Node load generator (4 connections), 8 seconds of warm-up then 15 to 20
  seconds measured, CPU read from `/proc/<pid>/stat`, variants rotated between rounds. eShopOnWeb pages: the catalog
  with and without filters, the basket, the login page, the privacy page. Pricing application: `/quote?items=40` over
  30 seeds. Raw medians: eShopOnWeb baseline 7.31 ms (rounds 7.66, 7.40, 7.23, 6.84), `run` 6.50, functions 6.93,
  lines 7.51; a build with the middleware and no instrumentation 7.11 ms, the same as the baseline. Pricing
  application baseline 0.183 ms, `run` 0.194, functions 0.227, lines 0.230; Coverlet 10.1 with hit counts 0.233
  against a 0.196 baseline on its first clean round (later rounds ran on already instrumented files and are
  discarded), with `--single-hit` 0.199.
- **Per call**: 50 million calls per loop, the third of three rounds, one core.
- **End to end**: the 14-test eShopOnWeb suite above, `--repeat-each=5`, 2 workers, 4 rounds, rotated; collection
  inside the fixture's teardown.
- **Isolation**: 300 requests across three pages over 16 connections, each request id collected alone.
- **Per call, Node** (part 3b): the code the transform would insert, written by hand around a 4-statement function
  and a getter; 50 million calls in one loop after two warm-up loops, each variant in its own process so the loop's
  call site stays monomorphic, 5 runs, medians; Node 22.22.0 and 24.11.1, default flags, then with
  `--max-inlined-bytecode-size=0 --max-inlined-bytecode-size-small=0`. At default flags, V8 sometimes left the
  uninstrumented function on Node 24 not inlined (5.5 ns, 2 runs of 5); the median is the inlined case.
- **Browser**: 8 rounds, the first discarded, one new context per run, medians; the functions check compared, per
  script URL and start offset, the functions with a count above zero in each mode.
- **CSS** (part 2b): Playwright 1.64.1 and its headless Chromium, a static server on localhost, one new context per
  run, five variants (none, function coverage, `DOM.enable` and `CSS.enable` only, CSS rule usage, both) rotated
  between 8 rounds, the first discarded, medians of 7. Function coverage as code reach starts it (`Debugger.enable`
  with pauses skipped, `Profiler.startPreciseCoverage` with `callCount: false, detailed: false`), without reading
  script sources. Coverage read before the navigation and at the end. CSS-heavy page, raw test times (ms): none 1568,
  1551, 1536, 1651, 1590, 1505, 1526; function coverage 1633, 1606, 1591, 1671, 1662, 1619, 1569; CSS enabled only
  1615, 1513, 1577, 1573, 1565, 1544, 1627; CSS rule usage 2425, 2374, 2378, 2621, 2555, 2475, 2434; both 2422, 2407,
  2406, 2475, 2499, 2360, 2575. Sample app (home with *Load items*, form filled, popup page): none 312, 331, 323, 308,
  303, 319, 330; function coverage 361, 394, 371, 380, 364, 371, 409; CSS enabled only 345, 332, 323, 351, 327, 319,
  350; CSS rule usage 374, 313, 347, 349, 363, 328, 364; both 381, 384, 434, 368, 407, 371, 391. Style recalculation,
  five re-renders timed in the page, medians of 5: 139 ms without capture, 153 ms with `CSS.enable`, 494 ms with
  tracking. The behaviors of 2b.1 and the mappings of 2b.2 were each checked on a page built for the case, and on a
  Vite 8.3.5 project with `@vitejs/plugin-vue` 6.0.10 and Tailwind 4.3.3, in development with and without
  `css.devSourcemap` and built with `build.sourcemap: true`.

Throughput on eShopOnWeb (about 230 to 280 requests per second on two cores) varied by ±8% between identical runs,
which is why CPU per request, not throughput, is reported.

## Appendix B: the recorder, in substance

```csharp
namespace Microsoft.CodeAnalysis.Runtime;

public static class Instrumentation
{
    public static bool[] CreatePayload(Guid mvid, int methodToken, int fileIndex, ref bool[] payload, int payloadLength)
        => Recorder.Payload(mvid, methodToken, ref payload, payloadLength);

    public static bool[] CreatePayload(Guid mvid, int methodToken, int[] fileIndices, ref bool[] payload, int payloadLength)
        => Recorder.Payload(mvid, methodToken, ref payload, payloadLength);
}

public static class Recorder
{
    private static readonly AsyncLocal<RequestCoverage?> s_request = new(args => t_request = args.CurrentValue);
    [ThreadStatic] private static RequestCoverage? t_request;

    public static void Begin(RequestCoverage request) => s_request.Value = request;
    public static void End() => s_request.Value = null;

    public static bool[] Payload(Guid mvid, int method, ref bool[] slot, int length)
    {
        var module = Module(mvid);                     // a thread-static cache in front of a dictionary
        if (Mode == Mode.Run)
            return slot = module.SharedPayload(method, length);
        var request = t_request;
        return request is null ? module.SharedPayload(method, length) : request.Payload(module, method, length);
    }
}
```

The middleware sets `Recorder.Begin` before calling the next middleware and `Recorder.End` after it, names the
request in `Response.OnStarting`, and keeps the `RequestCoverage` until it is collected. A report walks each kept
payload: entry 0 set means the method ran (its first span is the function's line range), any other entry set means
that statement's lines ran.

## Appendix C: suspect lines on eShopOnWeb

One commit on top of eShopOnWeb, 13 changed lines in 5 hunks over 4 files:

- `BasketService.SetQuantities`: the quantity is added instead of set (the bug), and the log line reworded;
- `CatalogViewModelService`: the page count computed by a new helper (executed by catalog pages);
- `Register.cshtml.cs`: the email trimmed (executed by the registration tests);
- `ManageController.ChangePassword`: a log line (executed by no test).

The 14-test suite ran once against the coverage build in `test` mode: 1 test failed (*updates a quantity in the
basket*), 13 passed.

| Changed lines | Failing tests that executed them | Passing tests that executed them | Ochiai |
|---|---|---|---|
| `BasketService.cs` 57 to 59 | 1 | 2 (the two checkout tests) | 0.58 |
| `CatalogViewModelService.cs` 42, 43, 76 | 0 | 4 | 0 |
| `Register.cshtml.cs` 71, 72 | 0 | 2 | 0 |
| `CatalogViewModelService.cs` 40, 41, 44, 45; `ManageController.cs` 159 | 0 | 0 | 0 |

The catalog change was not executed by the failing test although it visits the catalog: the page's view model comes
from a cache another test filled. Without the diff, the 5 lines with the top score are the basket page's update
handler, which only the failing test runs, and the bug line comes about 36th of 235.
