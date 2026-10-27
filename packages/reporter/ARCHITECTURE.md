# Reporter architecture

A map for contributors. The `@piwitests/reporter` package collects Playwright
test results and sends them to a Piwi Dashboard server. It also ships the `piwi`
command line (`src/cli/`) and the agent skills that `piwi init` installs
(`templates/skills/`). The rules to follow when you change it are in
[`AGENTS.md`](AGENTS.md).

## Public and internal code

If it's exported from **`src/index.ts`** (the `.` entry, the package's single
public surface), it's the **public API** and changing it is a breaking
change. Everything under **`src/internal/`** is private plumbing, except the
capture modules the dashboard's own tests import (see [Build output](#build-output)).

| Public surface | Where | What |
|---|---|---|
| `PiwiDashboardReporter` (default + named) | `public/reporter.ts` | the Playwright reporter |
| `wrapConfig` | `public/config-wrapper.ts` | injects the reporter and the global setup into a Playwright config |
| `createGlobalSetup` | `public/global-setup.ts` | registers the run before the user's own `globalSetup`, after checking each `baseURL` answers when `checkBaseUrl` is on |
| `resolveSelection` | `public/selection.ts` | resolves `PIWI_SELECTION` from an ESM config, returns a grep and stamps the run |
| `piwiFixtures`, `extendPiwiFixtures` | `internal/capture/capture-fixtures.ts`, re-exported by `index.ts` | the capture fixtures (imported from `@piwitests/reporter`) |
| `piwiAiFixtures`, `extendPiwiAi` | `internal/ai/ai-fixtures.ts`, re-exported by `index.ts` | the AI-step fixtures (`page.piwiLocator`, `page.piwiRun`), replayed from committed artifacts |
| `PiwiDashboardOptions`, `PlaywrightTestConfig` | `public/options.ts` | the options type (types) |
| `PiwiFixtures`, `PiwiWorkerFixtures`, `PiwiAi`, `AiMode`, `AiOnMiss` | `internal/capture/capture-fixtures.ts`, `internal/ai/ai-fixtures.ts` | the fixtures' types |
| `ResolveSelectionResult`, `ResolveSelectionOptions` | `public/selection.ts` | `resolveSelection`'s types |
| `PiwiConfig`, `PiwiCodegenConfig` | `public/piwi-config.ts` | the `'@piwi'` section of a Playwright config, which the editor service reads |

Two **external contracts** beyond the npm API:

- **Wire types** (`types/wire.ts`): the JSON sent to and received from the server.
  The small leaf shapes (`BrowserConfig`, `TestStepEvent`, …) are re-exported from
  `@piwitests/core/wire`. The per-case `WireTestCase` and the stream union stay here,
  kept compatible with the server's `TestCasePayload` and `StreamEventPayload` by the
  dashboard's `wire-shared-drift.test.ts`. A change here is a server-contract change.
- **Side effects**: what a user's suite can observe, listed below.

## Side effects

What the package does to a user's run, process by process.

**Configuration and logs**

- `PIWI_*` env vars (`internal/config/env.ts`). `PIWI_DASHBOARD_URL`, `PIWI_API_KEY`
  and `PIWI_PROJECT_NAME` are also read from the `.env` in the Playwright config's
  folder, below the environment, by the reporter and the global setup alike.
- `piwi-*` testInfo attachment names (`internal/capture/attachments.ts`), temp files in
  `os.tmpdir()`, and `[Piwi Dashboard]`-prefixed logs (`internal/support/logger.ts`).

**In each test worker** (the capture fixtures)

- The `__piwiProbeElement` page global, seeded via `addInitScript`
  (`internal/capture/capture-fixtures.ts`), so a capture ships a stub call rather than
  the probe's source.
- The boxed stack prefix `internal/capture/quiet-capture.ts` adds for this package's
  `dist/`, so a wrapped action is located at the test's line.
- The resource ledger's listener on the worker's Playwright instrumentation, and its
  wrappers on the browser types' `launch`/`connect` (and `connectOverCDP`)
  (`internal/capture/resource-ledger.ts`).
- On Linux, `5` written to `/proc/<pid>/clear_refs` of the processes the worker started,
  at each test's start, which resets their peak RSS for the test
  (`internal/capture/worker-metrics.ts`). In Chromium, a DevTools session on each page
  that outlives its test.
- The API request proxy (`internal/capture/api-requests.ts`): the fixtures wrap
  `playwright.request.newContext` and hand out every API request context behind a
  proxy that records each call, the `request` fixture's and each browser context's own
  `request` (`page.request`) included.
- Code reach (`internal/capture/code-reach.ts`): a `beforeunload` listener on each
  document of a covered page, added in an isolated world.
- With server coverage on (`coverage.server`), the `X-Piwi-Coverage` request ids of each
  test's responses, its pages' and its API calls' (`piwi-server-coverage-requests`).

**The editor's breakpoints** (`internal/capture/pause-at.ts`, a headed local run with `PIWI_PAUSE_AT`)

- Each context stops through `context.debugger` before every call it can stop at, on
  the lines `PIWI_PAUSE_AT` names, and shows the pause bar. The bar's answer is read
  from the `__piwiPauseState` page global.
- `PW_CODEGEN_NO_INSPECTOR` is set in the worker, except while a `page.pause()` it
  leaves to Playwright runs. It wraps `Page.prototype.pause`, so every `page.pause()`
  of the worker's Playwright goes through it; one of a second copy of Playwright does
  not, and stops with neither bar nor Inspector.
- The stops shown (the bar's, and those the run connection holds) end as the test
  function ends, before Playwright's own failure screenshot: through the runner's
  `_onDidFinishTestFunctionCallbacks` (feature-checked), else as the test's page or
  context closes, or at teardown.
- The runner's count of a test function that ended under a stop is set back to what it
  held as the stop began (`_timeoutManager.defaultSlot()`, feature-checked). The call
  the stop let go, and the requests after it, are then waited for, 2 seconds at most:
  before a page or context of the test closes, and at the test's teardown.
- The stops shown, at the bar or in the editor, are attached as `piwi-pauses`.
  `internal/collect/pause-events.ts` sends them with the test's step events, as `pause`
  events: the steps keep their clock, and the step statistics leave the stopped time out.
- A locator picked at the bar is posted to the editor's `PIWI_EDITOR_SEND` address.
- With `PIWI_RECORD_CHANNEL`, **Record here** and `page.pause()` connect to the editor
  service's local socket and relay the recorder's binding calls over it
  (`internal/capture/record-handoff.ts`).

**The editor's run connection** (`internal/capture/run-channel.ts`, with `PIWI_RUN_CHANNEL` and `PIWI_ORIGIN_REF`)

- `PIWI_RUN_CHANNEL` names the same local socket as `PIWI_RECORD_CHANNEL`. Each worker
  connects to it in the `piwiResources` worker fixture, before its first test (it waits
  2 seconds at most), and stays connected until the worker ends. The messages are defined
  in `@piwitests/core/run-channel`.
- The first message, `run-attach`, lists the intents the worker takes
  (`takes: ['pick', 'record']`). The worker then sends each test's begin and end, each
  stop it shows, and each stop's end (`running`).
- The editor's controls (Pause, Step, Resume, Finish, Run to a line) and its breakpoints,
  which replace `PIWI_PAUSE_AT`, go through the same stop policy as `PIWI_PAUSE_AT`.
- While the connection is open, a headless run stops too (never under CI or Playwright's
  own debugger): the stop waits for the editor's answer, and goes on if the connection
  closes. In a headed run the pause bar shows as well, and the first answer wins: the
  editor's answer takes the bar down.
- A stop answered in the editor is attached to `piwi-pauses` like one answered at the
  bar. A stop that ends unanswered (the test function ended, its page or context closed,
  or, for a stop whose page the worker cannot tell, any page of its context closed) ends
  the same way with or without a bar, and the editor gets `running`.
- The editor can ask for an image of the stopped page: a JPEG screenshot without the
  pause bar, taken through an internal call. It gets none for a stop whose page the
  worker cannot tell (a navigation or a key press in a context with several pages).
- At a stop the bar shows, the editor can start the bar's **Pick a locator** or **Record
  here** (an intent: a `request` with `what: 'pick' | 'record'` that names the stop).
  `BarIntents` (`pause-at.ts`) hands it to the bar, which takes it as a click on its own
  button: the same picker, the pick posted to `PIWI_EDITOR_SEND`, the same hand-off over
  `PIWI_RECORD_CHANNEL`. The test's window is brought to the front, and the pick or the
  recording ends with the stop. The worker answers at once whether it started. It
  refuses at a stop that ended or is ending (its test ended, its page or context began to
  close), at one no bar shows or whose page it cannot tell, Record here when the run has
  no `PIWI_RECORD_CHANNEL`, and any intent while a pick or a recording runs.
- One stop shows at a time in a worker. A stop that waits for its turn is decided again
  when its turn comes. It goes on without showing, and the editor never hears of it,
  when the test ended meanwhile (as on Finish), when its page or context began to close,
  or when it is a breakpoint's stop and that breakpoint was removed or the stop before
  was answered with Finish. The Step, Pause or Run to a line it would have used then
  applies to the next stop.
- Closing a context, directly or through its browser, first lets the call its debugger
  holds go on, since the close does not.
- While each test runs, the capture fixtures take `PIWI_RUN_CHANNEL` and
  `PIWI_EDITOR_SEND` out of the worker's `process.env` (`hideRunChannel`), whether a run
  connection is open or not, so a process the test starts does not connect to the run
  and does not get the pairing's token. Picks still go to the pairing
  (`editorSendAddress`). Both are put back after the test, since Playwright passes a
  worker's environment changes to the projects that depend on its project.
  `PIWI_RECORD_CHANNEL` stays, for **Record here**.

**In the reporter process**

- The run sampler reads `/proc`, the cgroup filesystem or `ps` on an unref'd timer
  (`internal/collect/process-sampler.ts`).
- While the dashboard says someone watches the run, another unref'd timer posts what the
  sampler and the censuses added since its last post to `/live-resources`, every five
  seconds (`internal/streaming/live-resources.ts`).
- `onBegin` writes `PIWI_RESOURCES_RESULTS` (see below) and, with coverage on,
  `PIWI_COVERAGE_BROWSER` / `PIWI_COVERAGE_SERVER` / `PIWI_COVERAGE_CSS` for the workers.
- With server coverage on, it calls each origin's `/__piwi/coverage/collect` and
  `/__piwi/coverage/run`, and reads the covered files from the checkout for their blob
  ids (`internal/collect/server-coverage.ts`, `test-coverage.ts`).

## Two processes, two paths

Playwright runs the **reporter** in the main process and **fixtures** in each test
worker. They never share memory: they communicate through `piwi-*` testInfo attachments.

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

1. **streaming `/finish`**: when a streaming session is open (`internal/streaming/`),
2. **multipart `/upload`**: when there are reports or traces to attach,
3. **plain JSON `/submit`**: last resort,
4. **crash recovery**: on total failure, persist the payload to disk for the next run: one owner-only file per
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

A test's `coverage` holds two parts:

- its **browser files**: code reach, and at `coverage.browser: 'functions'` the lines of each function that ran,
  from `piwi-browser-coverage`, with the blob ids the reporter reads from the checkout;
- with `coverage.server` on, the **server coverage** the reporter collects from the backend after the test ends,
  never in the worker.

Timing:

- `onTestEnd` queues the result event of such a test only once its coverage is in, or after 30 seconds; every
  other event keeps its place.
- Collection batches tests per origin (25 tests or 1 second). The run's last test ending sends what is queued at
  once and fetches the run-level coverage, since Playwright stops a `webServer` before `onEnd`.
- `onEnd` waits at most 15 seconds for the tests still collecting, before the ladder above. It sends the
  run-level coverage (`PUT /api/test-runs/:id/coverage`, in chunks) once the ladder returned the run id.

At `coverage.browser: 'functions'` the run-level coverage includes the browser's: per file, the functions any
test ran and every function V8 listed, run or not (`allFunctions`). The workers name each function once, in
`piwi-browser-functions` attachments, as many per test as the capture caps need.

With `coverage.css: 'rules'`, the same per-page capture (`internal/capture/code-reach.ts`) also reads Chromium's
CSS rule usage, at each document's `beforeunload` pause and at the end. `internal/capture/css-coverage.ts` resolves
each sheet to its file (source map, a Vite dev server's `data-vite-dev-id`, or the served path) and its rules to
line ranges (`@piwitests/core/css-rules`). The matched rules ride `piwi-css-coverage` as browser files' function
ranges, whatever `coverage.browser` is. Every rule of the sheets rides `piwi-css-rules`, added to the run's
`allFunctions` as the browser functions are.

A backend's files whose source checksums (`checksums`) differ from the checkout's lose their line numbers
(`internal/collect/source-checksums.ts`).

Each backend answer names its process (`instance`, also the prefix of its request ids). The run-level coverage
of an origin gets the lines and functions its tests' coverage named added. It is sent with an `incomplete` entry
when another process answers it than the one that gave out the run's first ids (a restart), or when no run-level
answer comes (unreachable).

## Directory layout

```
src/
  index.ts                 public entry (.)            — re-exports the whole public API (incl. fixtures)
  global-setup-module.ts   default createGlobalSetup() — resolved by path at runtime (config-wrapper.ts)
  types.ts                 barrel re-exporting types/wire + types/collected

  public/      reporter, config-wrapper, global-setup, selection, options,
               piwi-config (the '@piwi' config section)            ← the supported API
  cli/         the `piwi` command line (package.json `bin`, its own tsup entry):
               index (the command switch), one file per command (init, skills, gate,
               quality-report for `report`, coverage, select for `select` and `run`,
               probe, flake, ai, codegen, preflight, bug); detect, configure (what
               init inspects and edits), add-reporter (`run`'s --add-reporter),
               report (the step results init and skills print)
  internal/
    submit/     run-submitter, uploader, serializer
    transport/  http-client (+ HttpError), backend-request
    streaming/  stream-manager, stream-buffer, bounded-queue, crash-recovery,
                live-resources (a watched run's CPU, memory and open pages,
                posted as it runs)
    collect/    metadata-collector, error-text, test-meta, external-ids,
                resource-verdicts (the censuses stitched into leaked, idle,
                piling-up and handle findings), process-sampler (the run's
                processes and the machine, sampled from the reporter),
                machine-panel (the end-of-run CPU, memory and disk lines),
                resource-wire (what the server receives), coverage-settings,
                server-coverage (the backends' collect and run endpoints,
                batched per origin), test-coverage (each test's coverage field,
                the wait before its result streams, the run's coverage),
                blob-ids (the git blob of each covered file), source-checksums,
                pause-events (the stops a test made, at the pause bar or in
                the editor, as the `pause` step events the dashboard draws and
                the step statistics leave out)
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
                code-reach, css-coverage (browser and style sheet coverage),
                locator-pages, page-interaction, page-inventory, failure-screenshot,
                inspect-on-failure, pick-on-failure (the failure-time overlay),
                pause-at (the editor's breakpoints: PIWI_PAUSE_AT, the stop policy
                over Playwright's debugger, the pause bar, a pick posted to
                PIWI_EDITOR_SEND), record-handoff (Record here:
                the paused page relayed to the editor's recorder, PIWI_RECORD_CHANNEL),
                run-channel (the worker's run connection to the editor,
                PIWI_RUN_CHANNEL: its tests and stops out, the editor's controls in)
    ai/         ai-fixtures, artifact, keys, params, ground, compile, resolution
                (the authoring loop), interpreter (replay), check (`piwi ai check`)
    coverage-upload/  git-inventory, report-files (`piwi coverage upload`)
    config/     env (PIWI_* ↔ options, and the probe and flake-lab variables),
                desktop (the desktop app's discovery file), dotenv (the `.env` reader)
    probe/      probe mode: plan matching, faults, the shared route interception
                (a matcher over route keys + an action), server-probe signing
    flake/      flake mode: the arm's plan, its conditions on the target's first
                page, the results file; lab (the command line's side of an arm)
    support/    logger, limiter, ci, ci-output, failure-links, run-url, instance-id,
                system-readers (`/proc`, cgroup and `ps` readers),
                cli-filters, setup-file, source-snippet, worker-index, errors,
                selection-client, selection-env, shard-info, aria-sampling,
                run-mode, test-paths, reporter-version, connection (the
                commands' dashboard), playwright-spawn (how commands start
                `playwright test` and package managers),
                base-url-check (the `checkBaseUrl` check the global setup runs)
  types/
    wire.ts        EXTERNAL server contract
    collected.ts   INTERNAL in-process model

templates/skills/<slug>/SKILL.md   the agent skills (see below)
```

## Agent skills (`templates/skills/`)

Each skill is one `SKILL.md`: a YAML front matter with `name` and `description`, then Markdown instructions for a
coding agent. `src/cli/skills.ts` declares them: `SETUP_SKILL` (`setup-piwi`) and the six `WORKFLOW_SKILLS`.

They reach users' agents four ways, all from the same files:

- `piwi init` installs the workflow skills by default (`--skills` picks others), and `piwi skills add` installs
  any of them, into `.claude/skills/` unless another folder is named (`--skills-dir` for `init`, `--dir` for
  `skills add`). Each installed file is stamped with the
  package version and a hash of what was written (`@piwitests/core/skill-stamp`): a later install updates an
  untouched skill from an older release and keeps one a person edited, unless `--force`.
- The dashboard bundles the workflow skills into its build (`piwi-skills` server assets in
  `apps/application/nuxt.config.ts`) and serves each one as an MCP prompt named after it (`investigate_failure`, …),
  its description taken from `apps/application/shared/mcp-prompts.ts`.
- The desktop app installs them into a project's linked folder, from the dashboard's `/api/agent-skills`.

## Conventions

- **Imports:** Node built-ins as `import * as x from 'node:x'`; type-only imports use
  `import type` (the `node:` protocol and the type imports are lint-enforced).
- **Classes** take dependencies as `private readonly` constructor parameter properties;
  an injected `logger` defaults to `new Logger()`. Stateless logic is a plain function module.
- **Errors:** throw `HttpError(status)` for non-2xx; `catch (error)` is `unknown`: narrow
  with `instanceof`, format with `errorMessage(error)` (`internal/support/errors.ts`).
- **Types:** `strict` is on. `any` is allowed only at the Playwright reporter-API / browser
  `evaluate` boundary (with a comment) and the dynamic options merge; everywhere else use
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
`page.route('**/*')` handler walks a list of rules. Each rule has a matcher over
route keys, which of the matching requests it acts on (every one, or the Nth after
the first navigation), and a handler. A probe installs one rule that applies its
fault (`slow` is a 5-second `delay` action). A flake arm installs one rule per
`delay` or `fail` condition, matching a request when `requestRouteKey(method, url)`
(core) equals the condition's route, the key the dashboard's flake profile names
suspects by. The route actions are `delay` (fetch, hold until `ms` after the
request started, fulfill), `status` and `abort` (`connectionreset`).

Flake mode installs the conditions on the target's first instrumented page, and the
page-creating paths await the install, so they are on before the test navigates.
`cpu` and `network` go through a DevTools session (`Emulation.setCPUThrottlingRate`,
`Network.emulateNetworkConditions`) and are reported `skipped` outside Chromium.
`alongside`, `after` and `project` are applied by the command line's Playwright
arguments and reported `by-command`. Each results line carries the attempt's
status, error signature (`flakeErrorSignature`) and whether it matches one of the
plan's, start, duration, worker and parallel index, and one outcome per condition.
Workers append whole lines (`O_APPEND`) to the one file.

## Shared core (`@piwitests/core`)

Pure cross-cutting logic (locator generation/scoring, ARIA parsing, element-match
healing, the wire leaf shapes, the locator-method list) lives in the private
`@piwitests/core` workspace package and is the single source of truth shared with
the app. The in-page overlays (the element probe, the picker, the pause bar) come
from the private `@piwitests/picker-dom` package. The reporter **`import`s both and
tsup bundles them into `dist/`** at build time, so the published package stays
self-contained: no `@piwitests/core` runtime dependency and no monorepo path in the
public `dist/index.d.ts`. Reporter-only runtime that needs Node (`captureCallerLocation`)
stays in `internal/capture/locator-healing.ts`.

## Build output

`npm run reporter:build` runs tsup (`tsup.config.ts`): it bundles `src/`, `@piwitests/core` and
`@piwitests/picker-dom` into `dist/` as CommonJS with `.d.ts`, leaving `form-data` and `@playwright/test`
external.

- The package entries (`index`, `global-setup-module`) stay at `dist/` root so `package.json`
  `main`/`types`/`exports` don't move.
- The CLI is its own entry (`dist/cli/index.js`, the `piwi` bin), so the main bundle carries no CLI code.
- The capture modules the dashboard dogfoods (`locator-healing`, `capture-fixtures`, `inspect-on-failure`,
  `pick-on-failure`, `attachments`) are emitted as their own entries, so their `dist/internal/capture/` paths are
  preserved: `apps/application/tests/fixtures.ts` imports them from there.
- `templates/` ships beside `dist/` (`files` in `package.json`); `findTemplatesDir` finds it from `dist/cli/` and
  from `src/cli/` alike.
