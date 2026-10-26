# Reporter architecture

A map for contributors. The `@piwitests/reporter` package collects Playwright
test results and sends them to a Piwi Dashboard server.

## Public vs internal — the one rule

If it's exported from **`src/index.ts`** (the `.` entry — the package's single
public surface), it's the **public API** and changing it is a breaking
change. Everything under **`src/internal/`** is private plumbing — change it freely.

| Public surface | Where | What |
|---|---|---|
| `PiwiDashboardReporter` (default + named) | `public/reporter.ts` | the Playwright reporter |
| `wrapConfig` | `public/config-wrapper.ts` | injects reporter + global setup into a PW config |
| `createGlobalSetup` | `public/global-setup.ts` | registers the run before `globalSetup`, after checking each `baseURL` answers when `checkBaseUrl` is on |
| `resolveSelection` | `public/selection.ts` | resolves `PIWI_SELECTION` from an ESM config, returns a grep and stamps the run |
| `PiwiDashboardOptions`, `PlaywrightTestConfig`, `PiwiFixtures`, `PiwiWorkerFixtures` | `public/options.ts` / `internal/capture/capture-fixtures.ts` | the config contract + capture fixtures types (types) |
| `piwiFixtures`, `extendPiwiFixtures` | `internal/capture/capture-fixtures.ts` → re-exported by `index.ts` | capture fixtures (imported from `@piwitests/reporter`) |

Two **external contracts** beyond the npm API:
- **Wire types** (`types/wire.ts`) — the JSON sent to / received from the server.
  The small leaf shapes (`BrowserConfig`, `TestStepEvent`, …) are re-exported from
  `@piwitests/core/wire`; the per-case `WireTestCase`/stream union stay here and are
  kept compatible with the server's `TestCasePayload`/`StreamEventPayload` by the
  dashboard's `wire-shared-drift.test.ts`. A change here is a server-contract change.
- **Side effects** — `PIWI_*` env vars (`internal/config/env.ts`), with `PIWI_DASHBOARD_URL`,
  `PIWI_API_KEY` and `PIWI_PROJECT_NAME` also read from the `.env` in the Playwright config's folder,
  below the environment, by the reporter and the global setup alike, `piwi-*` testInfo
  attachment names (`internal/capture/attachments.ts`), temp files in `os.tmpdir()`,
  `[Piwi Dashboard]`-prefixed logs (`internal/support/logger.ts`), and the
  `__piwiProbeElement` page global the capture fixtures seed via `addInitScript`
  (`internal/capture/capture-fixtures.ts`) so a capture ships a stub call rather
  than the probe's source, and the boxed stack prefix `internal/capture/quiet-capture.ts`
  adds for this package's `dist/` in each worker (so a wrapped action is located at the
  test's line), and the resource ledger's listener on each worker's Playwright
  instrumentation, with its wrappers on the browser types' `launch`/`connect`
  (`internal/capture/resource-ledger.ts`). On Linux each worker writes `5` to
  `/proc/<pid>/clear_refs` of the processes it started at each test's start,
  which resets their peak RSS for the test (`internal/capture/worker-metrics.ts`),
  and in Chromium it opens a DevTools session on each page that outlives its test.
  The capture fixtures wrap `playwright.request.newContext` and hand out every API
  request context behind a proxy that records each call, the `request` fixture's and
  each browser context's own `request` (`page.request`) included
  (`internal/capture/api-requests.ts`).
  A headed local run with `PIWI_PAUSE_AT` (the editor's breakpoints) stops each context
  through `context.debugger` before every call it can stop at, with `PW_CODEGEN_NO_INSPECTOR`
  set in the worker except while a `page.pause()` it leaves to Playwright runs (it wraps
  `Page.prototype.pause`, so every `page.pause()` of the worker's Playwright goes through it; one of a second
  copy of Playwright does not, and stops with neither bar nor Inspector), shows the pause
  bar at the calls on those lines and reads its answer from the `__piwiPauseState` page global,
  takes the bar down as the test function ends, before Playwright's own failure screenshot (the
  runner's `_onDidFinishTestFunctionCallbacks`, feature-checked; without them, as the test's page
  or context closes, or at teardown), sets the runner's count of a test function that ended under it
  back to what it held as the stop began (`_timeoutManager.defaultSlot()`, feature-checked), waits a
  while for the call it let go and the requests after it, attaches the stops as
  `piwi-pauses` (`internal/collect/pause-events.ts` sends them with the test's step events, as
  `pause` events: the steps keep their clock, and the step statistics leave the stopped time
  out), and posts a locator picked meanwhile to the editor's
  `PIWI_EDITOR_SEND` address (`internal/capture/pause-at.ts`). With `PIWI_RECORD_CHANNEL`,
  **Record here** and `page.pause()` connect to the editor service's local socket and relay
  the recorder's binding calls over it (`internal/capture/record-handoff.ts`).
  The reporter's run sampler reads `/proc`, the cgroup filesystem or `ps` on an
  unref'd timer (`internal/collect/process-sampler.ts`).
  With server coverage on (`coverage.server`), the capture fixtures keep the
  `X-Piwi-Coverage` request ids of each test's responses, its pages' and its API
  calls' (`piwi-server-coverage-requests`),
  `onBegin` writes `PIWI_COVERAGE_BROWSER` / `PIWI_COVERAGE_SERVER` for the workers,
  and the reporter process calls each origin's `/__piwi/coverage/collect` and
  `/__piwi/coverage/run` and reads the covered files from the checkout for their
  blob ids (`internal/collect/server-coverage.ts`, `test-coverage.ts`).

## Two processes, two paths

Playwright runs the **reporter** in the main process and **fixtures** in each test
worker. They never share memory — they communicate through `piwi-*` testInfo attachments.

```
            TEST WORKER                                MAIN PROCESS
  ┌───────────────────────────┐            ┌──────────────────────────────────┐
  │ internal/capture/          │            │ public/reporter.ts (PiwiDashboard │
  │   capture-fixtures.ts      │  piwi-*    │   Reporter) — Playwright hooks     │
  │  • network / web-vitals    │ attach-    │   onBegin/onTestEnd/onEnd          │
  │  • console / aria snapshot │  ments     │     │ collects CollectedTestCase   │
  │  • locator snapshots       │ ─────────► │     ▼                              │
  │    (locator-healing.ts)    │            │ internal/submit/serializer.ts      │
  │  • resource census         │            │   → WireTestCase / run body        │
  │    (resource-ledger.ts)    │            │                                    │
  └───────────────────────────┘            │                                    │
                                           │     ▼                              │
                                           │ internal/submit/run-submitter.ts   │
                                           │   the fallback ladder ▼            │
                                           └──────────────────────────────────┘
```

The resource ledger also writes one file, as the lab modes do: a worker's last
census, taken as its `piwiResources` worker fixture tears down, belongs to no test.
The reporter names a temp file in `PIWI_RESOURCES_RESULTS` in `onBegin`, before
any worker starts; each worker appends that census to it, and `onEnd` reads it
back. `internal/collect/resource-verdicts.ts` stitches every census per worker
into the findings the reporter prints. The machine panel needs no worker: the
run sampler reads the processes under the runner from the reporter's own
process. `internal/collect/resource-wire.ts` projects what the server receives:
each test's cost on its wire test case, and the bounded run report (findings,
the run's profile, each worker's open pages) with the finish or the whole-run
submit.

## The submit/fallback ladder (`internal/submit/run-submitter.ts`)

On `onEnd`, the collected run is handed to `RunSubmitter`, which tries, in order:

1. **streaming `/finish`** — when a streaming session is open (`internal/streaming/`),
2. **multipart `/upload`** — when there are reports or traces to attach,
3. **plain JSON `/submit`** — last resort,
4. **crash recovery** — on total failure, persist the payload to disk for the next run: one owner-only file per
   dashboard and project, replayed to that dashboard only and deleted once it took the run (or refused it as
   invalid).

The ladder, including the stream drain and the remaining file uploads, runs within
the `submitTimeout` budget: when it runs out, `HttpClient.close` fails every request
in flight and every later one, so the ladder falls through to crash recovery.

A 401 with no credential configured, or a failed login, stops the ladder at once: no other rung can succeed, so
the run goes to crash recovery. Nothing in the ladder throws out of `onEnd`, since Playwright counts a reporter's
error as a failure of the run. Every rung carries one `deliveryKey` per run, so a dashboard that stored a slow
upload stores the `/submit` that follows it, or the recovery copy, once.

A run delivered by a later rung than its first choice carries `metadata.ingestHealth.submitFallback`
(`{ path: 'upload' | 'submit', reason }`), and a payload sent from crash recovery carries `{ path: 'recovery' }`,
so the dashboard can say how the run arrived.

All HTTP to the dashboard goes through `internal/transport/http-client.ts`, which throws `HttpError`
(carrying `status`) so callers branch on `error.status`, never the message text.

## Coverage (`internal/collect/test-coverage.ts`)

A test's `coverage` is its browser files (code reach; at `coverage.browser:
'functions'`, the lines of each function that ran, from `piwi-browser-coverage`,
with the blob ids the reporter reads from the checkout) and, with `coverage.server`
on, the server coverage the reporter collects from the backend after the test
ends, never in the worker. `onTestEnd` queues the result event of such a test only
once its coverage is in, or after 30 seconds; every other event keeps its place.
Collection batches tests per origin (25 tests or 1 second), and the run's last test
ending sends what is queued at once and fetches the run-level coverage, since
Playwright stops a `webServer` before `onEnd`. `onEnd` waits at most 15 seconds for
the tests still collecting, before the ladder above, and sends the run-level coverage
(`PUT /api/test-runs/:id/coverage`) once the ladder returned the run id. At
`coverage.browser: 'functions'` that includes the browser's run-level coverage:
per file, the functions any test ran and every function V8 listed, run or not
(`allFunctions`), which the workers name once each in `piwi-browser-functions`
attachments, as many per test as the capture caps need.
With `coverage.css: 'rules'`, the same per-page capture (`internal/capture/code-reach.ts`) also reads Chromium's
CSS rule usage, at each document's `beforeunload` pause and at the end; `internal/capture/css-coverage.ts` resolves
each sheet to its file (source map, a Vite dev server's `data-vite-dev-id`, or the served path) and its rules to
line ranges (`@piwitests/core/css-rules`). The matched rules ride `piwi-css-coverage` as browser files' function
ranges, whatever `coverage.browser` is, and every rule of the sheets `piwi-css-rules`, added to the run's
`allFunctions` as the browser functions are.
A backend's files whose source checksums (`checksums`) differ from the checkout's
lose their line numbers (`internal/collect/source-checksums.ts`).
Each backend answer names its process (`instance`, also the prefix of its request
ids); the run-level coverage of an origin gets the lines and functions its tests'
coverage named added, and is sent with an `incomplete` entry when another process
answers it than the one that gave out the run's first ids (a restart), or when no
run-level answer comes (unreachable).

## Directory layout

```
src/
  index.ts                 public entry (.)            — re-exports the whole public API (incl. fixtures)
  global-setup-module.ts   default createGlobalSetup() — resolved by path at runtime
  types.ts                 barrel re-exporting types/wire + types/collected

  public/      reporter, config-wrapper, options, global-setup   ← the supported API
  internal/
    submit/     run-submitter, uploader, serializer
    transport/  http-client (+ HttpError)
    streaming/  stream-manager, stream-buffer, crash-recovery
    collect/    metadata-collector, error-text, resource-verdicts (the censuses
                stitched into leaked, idle, piling-up and handle findings),
                process-sampler (the run's processes and the machine, sampled
                from the reporter), machine-panel (the end-of-run CPU, memory
                and disk lines), resource-wire (what the server receives),
                coverage-settings, server-coverage (the backends' collect and
                run endpoints, batched per origin), test-coverage (each test's
                coverage field, the wait before its result streams, the run's
                coverage), blob-ids (the git blob of each covered file),
                pause-events (the stops a test made at the pause bar, as the
                `pause` step events the dashboard draws and the step
                statistics leave out)
    manifest/   collect (the committed manifest, `/__piwi/manifest` per base URL or origin),
                run-manifests (the instrumented origins the run reached beyond its base URLs,
                fetched as each is first seen, uploaded once the run is submitted)
    files/      file-handler, compression
    capture/    capture-fixtures, locator-healing, attachments   ← runs in the worker
                quiet-capture (keeps the capture out of the test's own steps,
                trace and stack locations — Playwright internals, feature-detected)
                api-requests (the calls a test makes through Playwright's API
                request contexts: the `request` fixture, `page.request`)
                resource-ledger (the browsers, contexts, pages and API request
                contexts each worker opens, and the census per test),
                worker-metrics (what a test cost the worker and its browsers,
                and CDP reads of pages that outlive their test)
                inspect-on-failure, pick-on-failure (the failure-time overlay),
                pause-at (the editor's breakpoints: PIWI_PAUSE_AT, the stop policy
                over Playwright's debugger, the pause bar, a pick posted to
                PIWI_EDITOR_SEND), record-handoff (Record here:
                the paused page relayed to the editor's recorder, PIWI_RECORD_CHANNEL)
    config/     env (PIWI_* ↔ options, and the probe and flake-lab variables),
                desktop (the desktop app's discovery file), dotenv (the `.env` reader)
    probe/      probe mode: plan matching, faults, the shared route interception
                (a matcher over route keys + an action), server-probe signing
    flake/      flake mode: the arm's plan, its conditions on the target's first
                page, the results file
    support/    logger, limiter, ci, ci-output, failure-links, run-url, instance-id,
                system-readers (`/proc`, cgroup and `ps` readers),
                cli-filters, setup-file, source-snippet, worker-index, errors,
                selection-client, selection-env, shard-info,
                base-url-check (the `checkBaseUrl` check the global setup runs)
  types/
    wire.ts        EXTERNAL server contract
    collected.ts   INTERNAL in-process model
```

## Conventions

- **Imports:** Node built-ins as `import * as x from 'node:x'`; type-only imports use
  `import type` (both lint-enforced).
- **Classes** take dependencies as `private readonly` constructor parameter properties;
  an injected `logger` defaults to `new Logger()`. Stateless logic is a plain function module.
- **Errors:** throw `HttpError(status)` for non-2xx; `catch (error)` is `unknown` — narrow
  with `instanceof`, format with `errorMessage(error)` (`internal/support/errors.ts`).
- **Types:** `strict` is on. `any` is allowed only at the Playwright reporter-API / browser
  `evaluate` boundary (with a comment) and the dynamic options merge — everywhere else use
  precise types or `unknown`.
- **Wire changes** touch `types/wire.ts` and `internal/submit/serializer.ts` together, and must
  stay structurally compatible with `apps/application/shared/types.ts` (kept in sync by the drift test).

## Lab modes: probes and flake experiments

Two env-driven modes turn a Playwright run into an experiment rather than a real
run. Each forces `retries` to 0 (`public/config-wrapper.ts`), stamps the run's
metadata at `onBegin` so every submit path carries it (`public/reporter.ts`), and
has the capture fixtures act on the matching test only. A run is one or the
other: setting both stops it with a message (`labModeConflict`).

| | Probe mode | Flake mode |
|---|---|---|
| Switched on by | `PIWI_PROBE=1` + `PIWI_PROBE_PLAN` | `PIWI_FLAKE_PLAN` (one arm's plan) |
| Results | `PIWI_PROBE_RESULTS`, one line per probed test | `PIWI_FLAKE_RESULTS`, one line per finished attempt of the target and of an `alongside`/`after` companion |
| Plan format | `internal/probe/plan.ts` | `@piwitests/core/flake-plan` (`parseFlakePlan`, shared with the dashboard and the CLI) |
| Test match | file + title (+ describe path) | the same, plus the plan's Playwright project |
| Run stamp | `piwiProbe: true` | `piwiFlakeLab: { experimentId, armId }` |

Both apply route changes through `internal/probe/interception.ts`: one
`page.route('**/*')` handler walks a list of rules, each a matcher over route keys,
which matches it acts on (every one, or the Nth after the first navigation), and a
handler. A probe installs one rule that applies its fault (`slow` is a 5-second
`delay` action); a flake arm installs one rule per `delay` or `fail` condition,
matching a request when `requestRouteKey(method, url)` (core) equals the
condition's route, the key the dashboard's flake profile names suspects by. The
route actions are `delay` (fetch, hold until `ms` after the request started,
fulfill), `status` and `abort` (`connectionreset`).

Flake mode installs the conditions on the target's first instrumented page and the
page-creating paths await the install, so they are on before the test navigates.
`cpu` and `network` go through a DevTools session (`Emulation.setCPUThrottlingRate`,
`Network.emulateNetworkConditions`) and are reported `skipped` outside Chromium;
`alongside`, `after` and `project` are applied by the command line's Playwright
arguments and reported `by-command`. Each results line carries the attempt's
status, error signature (`flakeErrorSignature`) and whether it matches one of the
plan's, start, duration, worker and parallel index, and one outcome per condition.
Workers append whole lines (`O_APPEND`) to the one file.

## Shared core (`@piwitests/core`)

Pure cross-cutting logic — locator generation/scoring, ARIA parsing, element-match
healing, the wire leaf shapes, the locator-method list — lives in the private
`@piwitests/core` workspace package and is the single source of truth shared with
the app. The reporter **`import`s it and tsup bundles it into `dist/`** at build
time, so the published package stays self-contained: no `@piwitests/core` runtime
dependency and no monorepo path in the public `dist/index.d.ts`. Reporter-only
runtime that needs Node (`captureCallerLocation`) stays in `internal/capture/locator-healing.ts`.

## Build & test

```bash
npm run reporter:build      # tsup: bundles src/ + @piwitests/core → dist/ (CJS + .d.ts)
npm run reporter:typecheck  # tsc --noEmit on src/, then on tests/ (tests/tsconfig.json)
npm run reporter:test       # vitest
npm run reporter:bench      # capture-overhead benchmark (tests/bench/README.md)
npm run reporter:lint
npm run reporter:format
```

The package entries (`index`, `global-setup-module`) stay at `dist/` root so
`package.json` `main`/`types`/`exports` don't move. The capture modules the
dashboard dogfoods (`internal/capture/*`) are emitted as their own entries so their
`dist/` paths are preserved.
