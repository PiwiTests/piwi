# Remote browsers

A plan for Piwi to understand runs whose browsers run on another machine. A **browser grid** is a service that hands
each test worker a browser running elsewhere, the meaning Selenium Grid gave the term; a Playwright test reaches one
through `connectOptions.wsEndpoint`. Teams use one to run more workers than a CI machine holds, or browsers it does not
have. Piwi reads those runs badly today:

- **Every lost browser looks the same.** A browser killed for lack of memory, a grid machine that died and a test that
  closed its own page all end in the same error, `Target page, context or browser has been closed`
  ([spike D](#d-what-a-test-sees-and-what-a-page-reads)). Piwi files them as crashes and scores them against the test.
- **The browser's cost disappears.** The [CPU, memory and disk](../apps/docs/features/cpu-memory-disk.md) panel
  measures the processes under the runner; a browser on a grid "runs elsewhere and is not measured".
- **The capture costs more with distance.** On the capture benchmark, with a 10 ms round trip, a test took 717 ms
  longer with Piwi's capture fixtures than without them, against 478 ms with no added delay
  ([spike C](#c-piwis-capture-at-a-distance)).

This plan makes a remote browser something Piwi records and explains, whatever grid serves it, and defines what a grid
can tell Piwi beyond what the test sees.

**Status.** Proposed 2026-10-26. Nothing is built. The spikes in the [appendix](#appendix-the-spikes) are the evidence
for the claims about Playwright and the capture's cost; they are not part of the repository. Nothing here is on
[`ROADMAP.md`](../ROADMAP.md) yet. The contracts it would add are entry D61 of
[`1.0-stabilization.md`](1.0-stabilization.md).

**Summary.** What the plan delivers, in the order it should be built:

- **Remote browsers, from any grid.** The reporter records, per worker, that its browser was remote: the grid's host,
  the browser's version, how long the connection took and how the browser ended. A failure whose browser went away
  gets a clue of its own, with the grid's reason when the grid gave one, instead of reading like a crash.
- **The capture's cost at a distance, found and cut**: which of its reads hold a test up when every round trip costs
  milliseconds.
- **What a grid can tell Piwi.** A grid can name its sessions (Playwright Test then attaches the name to the tests),
  explain the connections it ends (Playwright puts the reason in the test's error), check a short-lived browser token
  that Piwi issues for each run, and report each session: how long it waited, how long the browser took to start, its
  CPU and memory, what happened to it and why it ended. With those reports, the run page shows the browser's cost
  again, an out-of-memory kill shows on the test it hit, and a run whose failures came from machines the grid lost is
  an incident by fact rather than by inference.
- **A docs page**, Piwi with a browser grid: the settings, where to put a grid, what Piwi records, and what not to
  expose.

Of the four things [`ROADMAP.md`](../ROADMAP.md) says Piwi is for, this serves the second, **explain the failures**: a
failure the infrastructure caused is named as such, with the fact behind it. It feeds the first, **keep the history**,
with the browser's cost run after run.

## How a test reaches a remote browser

What Playwright 1.64.1 does, read in its source (`playwright/lib/index.js`, `playwright-core/lib/coreBundle.js`) and
checked by the spikes:

1. **One browser per worker.** With `use.connectOptions` (or `PW_TEST_CONNECT_WS_ENDPOINT`), the `browser` fixture,
   which is worker-scoped, calls `browserType.connect()` once for the worker's whole life; contexts and pages are per
   test. A worker that restarts after a failure connects again. In Piwi, an execution's `worker_index` (Playwright's
   `workerIndex`) therefore names one remote browser. This document calls that connection a **session**: one
   connection, one browser, from `connect()` to its close.
2. **The handshake says what the client wants.** The WebSocket upgrade carries `User-Agent: Playwright/1.64.1 (…)`,
   `x-playwright-browser` (the browser engine), `x-playwright-launch-options` (the project's launch options as JSON,
   `headless`, `channel` and `args` included), `x-playwright-proxy` (the `exposeNetwork` rule) and the user's
   `connectOptions.headers` ([spike B](#b-a-websocket-proxy-in-front)). Playwright's server also reads `browser`,
   `launch-options` and `proxy` from the address's query string, and those win over the headers.
3. **Versions must match.** The server compares the client's major and minor version with its own and answers HTTP 428
   when they differ ([spike A](#a-playwrights-server)). [Playwright's
   docs](https://playwright.dev/docs/api/class-browsertype#browser-type-connect): "1.2.3 → is compatible with 1.2.x".
4. **Playwright's own server.** `playwright run-server`, the server most self-hosted grids are built on, launches a
   browser per connection and closes it at the end. It is a hidden command, absent from the command line's help since
   1.57, which the [Docker page](https://playwright.dev/docs/docker) documents. It has no authentication. Up to 1.59.1
   it applied the `args` a client sent and, started without `--host`, listened on every interface; 1.60.0 drops those
   options unless started with `--unsafe` and binds to the loopback address ([spikes A and D](#appendix-the-spikes)).
   Its extension mode (`--mode extension`, or `PW_EXTENSION_MODE` in its environment) applies every option a client
   sends and shares browsers between connections.
5. **The runner's own network, through the connection.** With `exposeNetwork: '<loopback>'` (since 1.37), the server
   starts a SOCKS proxy for that browser, and the requests that match go back over the same WebSocket to the client,
   which opens them from its own network ([spikes B and E](#appendix-the-spikes)). A test drives the app its CI job
   serves on `localhost` from a browser on the grid. The client enforces the rule itself, ports included
   ([spike F](#f-the-exposenetwork-rule-against-a-server-that-misbehaves)).
6. **Artifacts come back over the connection.** Traces, videos, screenshots and downloads reach the runner's output
   folder ([spike E](#e-playwright-test-through-a-remote-server)).
7. **A grid can name the session and explain its end.** Playwright Test turns each `x-playwright-attachment:
   name=value` header of the server's answer into a text attachment of every test that creates a context on that
   browser (the `page` and `context` fixtures do), and a WebSocket close reason becomes the error of every call still
   waiting ([spike G](#g-a-sessions-name-and-the-reason-it-ended)). Neither is documented: Playwright Test reads the
   attachment header since 1.38, and both were checked in 1.64.1. Playwright compares the header's name exactly, in
   lowercase, so a reverse proxy that rewrites header names loses it: one built on Go's HTTP library (Traefik, Caddy)
   sends `X-Playwright-Attachment` ([spike H](#h-header-names-through-a-go-reverse-proxy)).
8. **Refusals are readable.** The body of a refused handshake and its `x-playwright-debug-log` header lines appear in
   the test's error ([spike B](#b-a-websocket-proxy-in-front)), under the same lowercase condition.
9. **Latency is the cost.** The protocol sends one message per Playwright call and waits for its answer. Through a
   WebSocket proxy with no added delay, the capture benchmark ran as fast as with a local browser; each millisecond of
   round trip added about 22 ms to a test of 20 operations, and more with Piwi's capture fixtures
   ([Part 3](#part-3-the-captures-cost-on-a-grid)).

## What exists

### In Piwi

| Piece | Where | What it gives this plan |
| --- | --- | --- |
| Resource sampling | `packages/reporter/src/internal/collect/process-sampler.ts`, `internal/capture/worker-metrics.ts`, [CPU, memory and disk](../apps/docs/features/cpu-memory-disk.md) | CPU, waits and memory per process role and per test, from `/proc`, cgroups or `ps`, for the processes under the runner. A remote browser is none of them. |
| The resource ledger | `packages/reporter/src/internal/capture/resource-ledger.ts` | Wraps `launch`, `connect` and `connectOverCDP` on the three browser types in each worker: the place to notice a remote browser and time its connection. |
| Failure parsing | `packages/core/src/error-parse.ts`, `describe-failure.ts` | `Target page, context or browser has been closed` is a `crash`, worded "Page or browser closed", whatever closed it. |
| Environment incidents | `apps/application/shared/handlers/run-health.ts`, `shared/run-incident.ts` | A run whose failures come from the environment is flagged (`metadata.incident`, with the app's host the failures were reaching) and left out of baselines, fix verification, flaky scores, the selection catalog, auto-heal and notifications; the gate reads it as inconclusive. Inferred from error text and shares of failures. Its contract is entry D31 of the 1.0 register. |
| Workers and shards | `test_runs_cases.worker_index`, `shard_index`, `started_at` | The key that joins an execution to its remote browser: one per run, shard and worker. |
| Identity | `api_keys`, `apps/application/shared/permissions.ts` | Hashed `pd_` keys sent as `Authorization: Bearer`, each carrying its owner's access; five project roles; a CI job holds an Uploader key (`project:read`, `run:submit`). With `PIWI_AUTH_ENABLED` off, every request acts as an administrator. |
| Capabilities | [`capabilities-opt-out.md`](../adr/capabilities-opt-out.md) | What grids report is one more capability a team can decline. |

Proposed elsewhere and not built: [`run-control.md`](run-control.md)'s live view (Part 8), frames from
`page.screencast` sent by the worker while someone watches. A screencast works through a remote browser
([spike I](#i-a-screencast-through-a-remote-browser)), so that view would need nothing from a grid.

### Outside Piwi

The grids a Playwright suite can use, as of October 2026, and what each tells its users about a session:

| Grid | License | Playwright's protocol | What it tells about a session |
| --- | --- | --- | --- |
| Playwright's `run-server` | Apache-2.0 | Chromium, Firefox, WebKit | Nothing: no session list, no authentication. |
| [Selenium Grid](https://www.selenium.dev/documentation/grid/) 4.51 | Apache-2.0 | No: Playwright reaches it through `SELENIUM_REMOTE_URL` and the DevTools protocol, for Chrome and Edge only, ["experimental"](https://playwright.dev/docs/selenium-grid) | Live sessions through GraphQL, a name (`se:name`), and why a session closed: `QUIT_COMMAND`, `TIMEOUT`, `NODE_REMOVED` or `NODE_RESTARTED`, never a crash or an out-of-memory kill. |
| [Moon](https://aerokube.com/moon/latest/) 2 | Commercial, closed source | Chrome, Chromium, Firefox, WebKit | A name from the address (`?name=`); counts in Prometheus metrics. |
| [Selenosis](https://github.com/alcounit/selenosis) | Apache-2.0 | Chromium, Firefox, WebKit, on Kubernetes | A pod per session, labeled from the address. |
| [Browserless](https://github.com/browserless/browserless) 2.57 | SSPL-1.0 or commercial | Chromium, Chrome, Edge, Firefox, WebKit | A label (`?trackingId=`), and a session list its docs give for its Enterprise plans. |
| Azure Playwright Workspaces | Managed service | All three, on Linux and Windows | The run (`runId` in the address), not the session. |
| BrowserStack, TestMu AI (formerly LambdaTest), TestingBot | Commercial services | All three | A name and a status the test sets through a `page.evaluate` convention, and REST APIs with each session's video and logs. |

Three things the table says. None of these grids documents a browser's CPU and memory, or a queue wait, per session:
only counts and host figures. None says that a browser was killed for lack of memory. And the self-hosted ones that
speak Playwright's protocol leave authentication off by default ([Part 6](#part-6-security)).

## Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | Piwi records each worker's remote browser and how it ended, whatever grid serves it ([Part 1](#part-1-what-the-reporter-records)). | The test sees the same error whatever ended the browser ([spike D](#d-what-a-test-sees-and-what-a-page-reads)); the worker sees the connection, its time and its end. |
| D2 | One entry per worker in the run's resource report; no per-test wire field. | One remote browser per worker, by Playwright Test's own fixture. |
| D3 | A session's name reaches Piwi as a test attachment: a grid answers the connection with `x-playwright-attachment: piwi-grid-session=<name>`, and Playwright Test attaches it to the tests that use that browser. The reporter reads a `piwi-grid-session` attachment only as `text/plain`, and its own `piwi-*` attachments only as the `application/json` the capture fixtures write. | [Spike G](#g-a-sessions-name-and-the-reason-it-ended): any grid can send it without code in the worker. A header-made attachment arrives before the fixtures' own, and the reporter reads the first of each name today, so a grid could otherwise replace Piwi's capture data. |
| D4 | A grid explains a connection it ends in the WebSocket close reason, starting with `Browser closed by the grid: `. The reporter reads it from the errors of the tests that were waiting; Piwi shows it as the failure's cause and fingerprints the failure on the fixed words. | Playwright puts the reason in the error of every call still waiting ([spike G](#g-a-sessions-name-and-the-reason-it-ended)). The fixed words match the crash pattern `error-parse.ts` already has, so the failure keeps its kind and its cluster. |
| D5 | The capture's cost at a distance is measured before it is cut: which awaited reads hold a test up, with the benchmark through a delaying WebSocket proxy, then those reads made fewer. | The capture's per-action reads run beside the test, not before the next action; its cost still grew with the round trip ([spike C](#c-piwis-capture-at-a-distance)). |
| D6 | Piwi offers grids an interface ([Part 4](#part-4-what-a-grid-can-tell-piwi)): browser tokens, a token check, session reports. A grid never receives an API key: the reporter asks the instance for a short-lived browser token, scoped to one run and to opening browsers, and sends that. | An API key carries its owner's access: an Uploader's uploads runs, a Maintainer's can re-run CI and spend AI tokens. A grid outside the team's control should get nothing it can reuse. |
| D7 | Facts from a grid inform; they do not exclude on their own. A run whose failures coincide with machines the grid lost is an incident, with its own rule and the grid named in its own field. An out-of-memory kill shows on the execution it hit, as an event with its time and process, and the flaky score weighs it like any other evidence. | The incident classifier infers today from error text; a lost machine is a fact. An out-of-memory kill usually hits a renderer, which the page or the test itself may have filled. |
| D8 | The `exposeNetwork` rule Piwi writes covers the loopback ports of the projects' `baseURL`s and `webServer` entries alone. | With `<loopback>`, the grid reaches every service on the CI machine's loopback ([spike F](#f-the-exposenetwork-rule-against-a-server-that-misbehaves)). |
| D9 | Piwi's docs never show `run-server` on a reachable address without a reverse proxy that checks a credential and builds the request to the server itself: a fixed path, no query string, its own headers. | Up to 1.59.1 a client's `args` are applied ([spike D](#d-what-a-test-sees-and-what-a-page-reads)), and the query string wins over the headers, so removing what a client sent is easier to get wrong than writing what the server receives. |
| D10 | Licenses stay on their side: what the reporter gains is MIT, the dashboard's part FSL-1.1-MIT. | The root guide's rule. |

## Part 1: What the reporter records

The resource ledger already wraps `connect` and `connectOverCDP` in each worker. When a worker's browser comes from
one of them, the ledger keeps, for that worker:

- **Where**: the endpoint's scheme, host and path, without credentials or query string, so a token in a URL never
  leaves the worker.
- **What**: the browser's version (`browser.version()`) and the engine.
- **How long the connection took**: the grid's queue and the browser's start, which the worker's first test pays.
- **How it ended**: closed by the fixture at the worker's end, or lost before that (`disconnected`), with the test that
  was running and the time.

In the reporter's main process, a test's `piwi-grid-session` attachment (D3) names its worker's session, and a test
whose error starts with the grid's fixed words (D4) gives the reason the session ended. The reporter keeps both with
the worker's entry and uploads neither as a file. A browser lost between two tests leaves no error to read: the grid's
own report (Part 4) carries its reason.

The entry goes with the run's resource report (`internal/collect/resource-wire.ts`): no per-test wire field changes.
The CPU, memory and disk panel says the browsers ran on a grid and where, rather than dropping them from its lines
without a word. `checkBaseUrl` checks from the runner's network; with a remote browser, its message says so when the
`exposeNetwork` rule does not cover the base URL's host.

## Part 2: What the dashboard shows

From the reporter alone, for any grid:

- The run's **Resources** tab names the grid and, per worker, how long the connection took and how the browser ended.
- A **clue** for a failure whose worker's remote browser was lost during the test: "The remote browser on
  grid.example.com went away during this test (connection closed at 10:32:14)", with the grid's reason when it gave
  one, ahead of the generic "Page or browser closed".
- The **incident classifier** counts lost remote browsers with the crashes it already counts.

From a grid that reports its sessions ([Part 4](#part-4-what-a-grid-can-tell-piwi)), joined to the workers by the
session's name:

- **Resources tab**: the browsers' CPU and memory again, with the queue wait and the start of each worker's browser,
  and any browser that ended early and why.
- **Timeline**: each worker's browser tracks from the grid's series, on the same scale as a local run's.
- **Execution**: an out-of-memory kill during the test shows as an event: "A renderer of this test's browser was
  killed for lack of memory at 10:32:14 (limit 2 GB)." The test's error is often `Page crashed` then, which Piwi
  already words apart.
- **Incident**: a run whose failures coincide with machines the grid lost is an incident under a new rule, `grid`,
  with the grid's host in a field of its own; `host` keeps the meaning D31 froze, the app's host. The consequences are
  an environment incident's.
- **Analytics**: queue wait (median and 95th percentile) and refusals per day, sessions and browser hours per project,
  peak concurrency per engine and version, the Playwright versions in use.
- **MCP**: the run tools return the sessions' summary.

## Part 3: The capture's cost on a grid

On the capture benchmark (12 tests of 10 actions and 10 assertions each, on a 200-row page), run with a local browser
and then through a WebSocket proxy that delays each message ([spike C](#c-piwis-capture-at-a-distance)), the median
test took:

| Browser | Without the capture | With the default capture |
| --- | --- | --- |
| A local browser | 1,499 ms | 2,041 ms |
| Through the proxy, no added delay | 1,484 ms | 1,962 ms |
| Through the proxy, 10 ms round trip | 1,705 ms | 2,422 ms |
| Through the proxy, 30 ms round trip | 2,165 ms | 2,936 ms |

The test's own calls cost about 22 round trips per test. The capture sends 109 protocol messages per test where the
test alone sends 28, but most of them do not hold the test up: each locator capture (a `locator.evaluate`, three
messages, and sometimes an ARIA snapshot) starts after its action and is not awaited
(`capture-fixtures.ts`, "Fire-and-forget"); the test waits for them at its end, for 2 seconds at most, and then reads
the page's state. Between no added delay and 30 ms, the capture's own cost grew by 293 ms, about ten round trips per
test. Two consequences:

- **Measure, then cut** (D5): time the awaited reads at the test's end, and the captures' share of one connection
  with the test's own calls, at 10 and 30 ms, before choosing what to change.
- **The docs say where to put a grid**: next to the runners, at a round trip of a few milliseconds. At 30 ms, tests
  ran 46% slower without the capture and 50% slower with it than with no added delay. Microsoft's hosted service
  places browsers in the region closest to the client by default
  ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/how-to-optimize-regional-latency)).

## Part 4: What a grid can tell Piwi

An interface any grid can implement in part or in whole. Each piece stands alone.

### 4.1 The session's name

The grid adds `x-playwright-attachment: piwi-grid-session=<name>` to its answer to the WebSocket upgrade, with the
header's name in lowercase: Playwright ignores `X-Playwright-Attachment`. Playwright Test attaches `piwi-grid-session`
to every test that creates a context on that browser (the name must not contain `=`, which Playwright splits on). The
reporter keeps it with the worker (Part 1); one test per worker carrying it is enough. The name is what the grid's own
session reports carry.

### 4.2 Why a connection ended

When the grid ends a connection for a reason of its own (the machine was lost, a time limit was reached), it closes the
client's WebSocket with a reason that starts with `Browser closed by the grid: `, in at most 123 bytes, the most a
close frame carries. Playwright makes it the error of every call still waiting:
`locator.click: Browser closed by the grid: <reason>` ([spike G](#g-a-sessions-name-and-the-reason-it-ended)). When only
the browser dies, Playwright's server answers the waiting calls itself with the generic text before the grid can close
anything; the session report (4.4) carries what happened then.

### 4.3 Browser tokens

A grid never receives an API key. Piwi issues two kinds of credential for grids:

- **A browser token**, for a run: the reporter asks the instance for one (`POST /api/grid/tokens`, with its API key,
  whose user needs `grid:connect` on the project) and sends it to the grid in the `Authorization` header. The token
  opens browsers for that run alone (one project, one shard) and expires with it.
- **A grid key**, for clients without Piwi's reporter: an API key an administrator creates that holds `grid:connect`
  and nothing else.

`grid:connect` ("Open browsers on a grid") is granted with `run:submit`: Uploader, Maintainer and Project admin.

The grid checks a credential with the instance before it opens a browser (`POST /api/grid/authorize`), calling with
its own credential (4.4). The instance accepts browser tokens and grid keys, never another API key, and checks them
whatever the instance's own authentication setting: with authentication off it issues no browser tokens, and a grid
uses credentials of its own. The answer gives the project, the run and the project's limits, or 401 for an unknown,
expired or revoked credential and 403 for a project the credential does not cover. A grid may keep a positive answer
for a minute, per credential and project. Revoking a credential stops new sessions; sessions already open run to
their end.

### 4.4 Session reports

An administrator creates a credential for each grid in **Settings → Browser grids**; the grid uses it to check
credentials (4.3) and to send its reports (`POST /api/grid/sessions`), in batches. Per session: its name, the project
and run, the engine, the Playwright and browser versions, the machine, the times it was queued, connected and ended,
why it ended, the events that happened to it, and a series of the browser's CPU and memory (one point a second, capped
like the reporter's).

- **Why it ended**, a closed set: the client closed it; the client's connection dropped without a close; the browser
  exited; the machine was lost; a time limit was reached; an administrator ended it or its credential was revoked;
  the grid was shutting down; `unknown`, for anything else.
- **Events**: out-of-memory kills, each with its time and the process it hit (browser, renderer, GPU, utility).

Reports are stored per session and deleted with their run; a session no reporter joined (a client without Piwi's
reporter) stays with its project for the retention window.

### 4.5 Pointing a suite at a grid that takes browser tokens

`PIWI_GRID_URL` (or the `grid` option of `wrapConfig`) fills `connectOptions` in, unless the config already sets it:
the address, the run's browser token in `Authorization`, the project's name in `x-piwi-project`, and an
`exposeNetwork` rule limited to the loopback ports of the projects' `baseURL`s and `webServer` entries
(`<loopback>:3000`). A `baseURL` that is not on the loopback gets no rule: the grid must reach it itself, and the docs
say so. The capture fixtures add `x-piwi-worker`, the worker's index, so a run whose report never arrived still finds
its sessions. `PW_TEST_CONNECT_WS_ENDPOINT` replaces the config's `connectOptions` whole, headers included; the
reporter warns when both are set. Any other grid receives neither a token nor these headers.

## Part 5: Documentation

A docs page, **Piwi with a browser grid**:

- `connectOptions` next to `wrapConfig`, with `exposeNetwork` limited to the app's ports, and why.
- The version rule, and the 428 a mismatch gets.
- Where to put the grid (Part 3).
- What Piwi records from any grid, and what a grid that implements Part 4 adds, with the lowercase header names a
  reverse proxy must keep.
- What not to expose: `run-server` on a reachable address without a reverse proxy that checks a credential and builds
  the request to the server itself (D9), and never in its extension mode.

Its commands work on Windows too, as the root guide requires.

## Part 6: Security

| What could happen | What shows it can | The control |
| --- | --- | --- |
| A grid gets a credential it can reuse. | An API key carries its owner's access ([`api-keys/index.post.ts`](../apps/application/server/api/users/%5Bid%5D/api-keys/index.post.ts): "The key carries its owner's access"). | Grids receive browser tokens, one run each, or grid keys, which open browsers and nothing else (4.3). |
| The grid reaches into the runner. | With `exposeNetwork`, the grid opens connections through the client to any address the rule allows; `<loopback>` allows every port on the CI machine's loopback ([spike F](#f-the-exposenetwork-rule-against-a-server-that-misbehaves)). | The rule Piwi writes covers the `baseURL` and `webServer` ports alone (D8). |
| A grid replaces Piwi's capture data. | A grid's `x-playwright-attachment` headers become attachments of any name, before the fixtures write theirs, and the reporter reads the first of each name. | The reporter reads its own attachments only as `application/json`, and the session's name only as `text/plain` (D3). |
| A token in a recorded endpoint. | Grids that take a token in the query string (Browserless, the commercial clouds' capabilities) put it in the address. | The reporter records the endpoint without its query string or credentials (Part 1). |
| A grid reports false facts. | A report can make a run an incident (D7). | Only an administrator creates a grid's credential; each report names its grid on every page that uses it; an incident from a grid can be cleared like any other (`setRunIncident`). |
| A team exposes `run-server`. | Selenium Grids exposed without authentication were taken over in campaigns reported by [Wiz](https://www.wiz.io/blog/seleniumgreed-cryptomining-exploit-attack-flow-remediation-steps) (2024-07-25), [Cado Security](https://thehackernews.com/2024/09/exposed-selenium-grid-servers-targeted.html) (2024-09) and [LeakIX](https://blog.leakix.net/2026/02/seleniumgreed-rce/) (2026-02-21). A `run-server` up to 1.59.1 applies a client's `args`, and Chromium's [`--renderer-cmd-prefix` and `--gpu-launcher`](https://chromium.googlesource.com/chromium/src/+/main/content/public/common/content_switches.cc) start a program of the caller's choice. | The docs' warning (D9, Part 5). |

## Delivery

Each PR is usable on its own; sizes are relative (S, M, L).

| PR | Content | Size |
| --- | --- | --- |
| 1 | Remote browsers from any grid (Parts 1 and 2, its first list): the per-worker entry, the `piwi-grid-session` attachment and the close reason read, the reporter's own attachments read only as JSON, the clue, the Resources tab, the incident classifier's count, the `checkBaseUrl` message; the docs page (Part 5). | M |
| 2 | The capture's cost at a distance (Part 3): the measurement, then fewer awaited reads, checked with the benchmark through a delaying WebSocket proxy at 0, 10 and 30 ms. | M |
| 3 | What a grid can tell Piwi (Part 4 and Part 2, its second list): browser tokens and grid keys, `grid:connect`, the token check, the grids' credentials in Settings, the session reports, the run page, the timeline, the events, the `grid` incident rule, analytics, MCP, the capability; `PIWI_GRID_URL` and the `x-piwi-*` headers. | L |

PR 1 is the first release.

## Verification

- **Reporter**: an integration test runs real Playwright tests through a stub server that names its sessions, delays
  messages and closes connections with a reason: the per-worker entry, the attachment read, the end recorded; a
  header-made `piwi-*` attachment ignored; no token and no `x-piwi-*` header sent to a grid other than
  `PIWI_GRID_URL`'s; the endpoint stored without its query string. The same test runs through Traefik and nginx in
  front of the stub, for the header names.
- **Capture**: the benchmark through the delaying proxy at 0, 10 and 30 ms, on every change of Part 3.
- **Dashboard**: browser tokens (another run's, an expired one, a revoked one), a grid key used to upload a run
  (refused), an API key sent to the token check (refused), the check with authentication off; session reports with a
  wrong credential refused; a run with lost machines gets the `grid` incident, and an out-of-memory event shows on its
  execution.

## Risks

- **Undocumented Playwright behavior.** `x-playwright-attachment`, the close reason as the error and the handshake
  headers are in Playwright's source, not its docs. The integration test runs on every Playwright update; without the
  attachment, sessions join through `x-piwi-worker` and the run's token.
- **Reverse proxies.** One that rewrites header names breaks the session's name and the refusals' text (4.1); the docs
  say so, and the verification covers two common ones.
- **Trust in a grid's reports.** A report can make a run an incident (D7). The credential is an administrator's to
  give, and each decision names the grid that caused it.
- **Latency.** A grid far from its runners makes every test slower (Part 3); the docs say so, and the connection time
  shows it.

## Open questions

1. **Adapters for existing grids' own APIs** (Selenium Grid's GraphQL and close reasons, Moon's metrics, Browserless's
   session list)? Recommendation: no. They bring labels and counts, none of the per-session facts Part 4 asks for.
2. **Per-test resource figures**: the grid's one-second series, or an exact read at each test's start and end, which
   the capture fixtures would ask the grid for? Recommendation: the series first.
3. **The attachment's name**: `piwi-grid-session` sits in the `piwi-*` attachment names the reporter already reserves.
   Should Piwi also read a name another grid already sends? Recommendation: no grid sends one today; decide when one
   does.

## Not in this plan

- **Running a grid.** Piwi records and explains remote browsers; it does not provide them.
- **WebDriver and Selenium**: Piwi is Playwright-only.
- **A live view of its own**: run control's (its Part 8) would work through a remote browser unchanged.

## Defects found while researching this plan

- **A grid can replace the capture's data** (`packages/reporter/src/public/reporter.ts`, the `attachments.find` reads
  of `piwi-pauses`, `piwi-locators`, `piwi-locator-pages`, code reach and `piwi-resources`): Playwright Test turns a
  server's `x-playwright-attachment` headers into attachments of any name, at context creation, before the fixtures
  write theirs, and the reporter takes the first of each name without checking its type. The fix is D3's, and does
  not wait for this plan.
- **The capture's cost grows with the round trip** (Part 3): 293 ms per test between no added delay and 30 ms, from
  reads the test waits for.
- **`checkBaseUrl` checks from the runner** (`packages/reporter/src/internal/support/base-url-check.ts`), which is not
  where a remote browser's requests come from.
- **The `worker_index` column's comment** (`apps/application/server/database/schema.sqlite.ts` and `schema.pg.ts`)
  says it holds Playwright's `parallelIndex`; the reporter sends `workerIndex`, which changes when a worker restarts.
- **Outside Piwi:** `run-server` up to Playwright 1.59.1 applies a client's `args`, and, started without `--host`,
  listens on every interface while printing `ws://localhost:<port>/` ([spike D](#d-what-a-test-sees-and-what-a-page-reads));
  1.60.0 changed both without a word in its release notes. Playwright's Docker page still publishes the server on
  `0.0.0.0` with no authentication. Anyone who reaches such a server older than 1.60 can run commands in it.
- **Outside Piwi:** Playwright compares the `x-playwright-attachment` and `x-playwright-debug-log` header names exactly,
  in lowercase, where HTTP header names are case-insensitive; behind a reverse proxy built on Go's HTTP library both
  are lost ([spike H](#h-header-names-through-a-go-reverse-proxy)).

## Appendix: the spikes

Run on 2026-10-26 in a sandbox with 4 cores and 16 GB of memory, Node.js 22.22, Playwright 1.64.1 and its Chromium
156.0.8078.4. The scripts lived outside the repository.

### A. Playwright's server

`run-server` 1.64.1 on the loopback interface, driven by `chromium.connect()`.

- A client sent `args: ['--user-agent=PIWI-SPIKE-ARGS-APPLIED']` and `executablePath: '/bin/false'` in
  `x-playwright-launch-options`. The default server ignored both: the browser started and its user agent stayed
  `HeadlessChrome/156…`. A client that sent only those `args` to a server started with `--unsafe` got the user agent
  `PIWI-SPIKE-ARGS-APPLIED`.
- With `--max-clients 1`, a second client's `connect()` had not returned after 1.5 s; it returned 1,622 ms after it
  was called, right after the first client closed.
- An upgrade with `User-Agent: Playwright/1.63.0` got HTTP 428 and Playwright's version mismatch message, naming
  server v1.64 and client v1.63. An upgrade with no `User-Agent` was accepted. A wrong path got 400.
- The first connection ever made on the machine took 12,357 ms to a usable browser; the next five, from connection to
  a first page, took 408, 278, 243, 164 and 159 ms.

### B. A WebSocket proxy in front

A Node.js WebSocket proxy of about 100 lines (the `ws` package): it checks a bearer token on the upgrade, then either
passes the connection to a `run-server`, copying messages and optionally delaying each one, or answers with a
redirect.

- Without a token, the test's error read `browserType.connect: WebSocket error: ws://127.0.0.1:39202/ 401
  Unauthorized`, then the proxy's reason from the response body, then the same reason again in the call log, from
  `x-playwright-debug-log`.
- The proxy saw `User-Agent: Playwright/1.64.1 (x64; ubuntu 24.04) node/22.22`, `x-playwright-browser: chromium`, the
  client's own headers, and `x-playwright-proxy: <loopback>` when `exposeNetwork` was set.
- Answered with a 307 to another address, the client followed it without its `Authorization` header and was refused
  there. Playwright's source drops `authorization` and any header whose name contains `access-key` on the first
  redirect, and lets its WebSocket library follow up to ten more with every other header.
- With `exposeNetwork: '<loopback>'`, the remote browser loaded a page served on the client's own loopback address,
  and the proxy saw the SOCKS messages that carried it (`socksConnected`, `socksData`).
- A minimal session (connect, new context, new page, `goto`) was 4 messages from the client and 33 from the server.

### C. Piwi's capture at a distance

The reporter's capture benchmark (`packages/reporter/tests/bench/run.mjs --only baseline,resources --rounds 2`): 12
tests of 10 actions and 10 assertions each, on a 200-row page, two measured rounds after a warm-up, the median test
reported. Run with a local browser, then with `PW_TEST_CONNECT_WS_ENDPOINT` pointing at spike B's proxy, which
delayed every message by 0, 5 or 15 ms each way. The server ran with `--unsafe` so that it used the benchmark's own
browser binary, the same as the local run.

| Browser | Without the capture | With the default capture | The capture's cost |
| --- | --- | --- | --- |
| A local browser | 1,499 ms | 2,041 ms | +542 ms (36%) |
| Proxy, no added delay | 1,484 ms | 1,962 ms | +478 ms (32%) |
| Proxy, 10 ms round trip | 1,705 ms | 2,422 ms | +717 ms (42%) |
| Proxy, 30 ms round trip | 2,165 ms | 2,936 ms | +771 ms (36%) |

The proxy counted the client's messages: 28.1 per test without the capture and 109.1 with it, at every delay. The
most frequent with the capture, per 12 tests: `evaluateExpression` 312, `dispose` 288, `waitForSelector` 276,
`expect` 132, `click` 120. Bytes per 12 tests: 117 KB from the client and 88 KB to it without the capture, 629 KB and
1.2 MB with it. Two rounds make these medians rough; the shape, a test slowed by about 22 ms per millisecond of round
trip and more with the capture, held in every round.

### D. What a test sees, and what a page reads

- A new server process on a warm machine was ready in 544 to 618 ms, and its first connection reached a first page in
  197 to 251 ms (three runs).
- A proxy that added a header to its upgrade answer: the client kept it with the connection's answer headers.
- A remote page opened `file:///tmp/piwi-spike-node-secret.txt`, a file written on the server's machine, and read
  its content.
- The browser's process killed during a `click`: the test got `locator.click: Target page, context or browser has been
  closed`. The server killed during a `click`, with a proxy that closed the client without a reason: the same text.
- A 1.59.1 server, with a 1.59.1 client, applied the client's `--user-agent` switch (the browser folder pointed at the
  installed 1.64 shell, since 1.59's own build was not installed).
- Started without `--host`, a 1.59.1 server printed `Listening on ws://localhost:39460/` and listened on `0.0.0.0`
  (`/proc/net/tcp`); a 1.64.1 server printed and listened on `127.0.0.1`.
- `run-server` exits about 2 s after SIGTERM and ignores SIGINT.

The published packages of 1.40.0, 1.45.0, 1.48.0, 1.50.0, 1.52.0, 1.55.0, 1.57.0, 1.58.0, 1.58.2, 1.59.0 and 1.59.1
all pass a client's `args` through `filterLaunchOptions`; 1.60.0 is the first to keep them for `--unsafe` servers.

### E. Playwright Test through a remote server

A four-test suite with `connectOptions: { wsEndpoint, exposeNetwork: '<loopback>' }` and `trace`, `video` and
`screenshot` on, against a `run-server`: each test opened a page served on the runner's loopback address at a random
port and clicked a button. All passed; the runner's output folder held 4 traces, 4 videos and 4 screenshots.

### F. The exposeNetwork rule against a server that misbehaves

A WebSocket proxy between a client and a `run-server` forged two `exposeNetwork` requests toward the client, as a
server that wants to reach the runner's loopback would (`socksRequested` on the connection's `SocksSupport` object),
with the client's rule `exposeNetwork: '<loopback>:39480'`. The request for `localhost:39480`, the app, was connected
(`socksConnected`); the request for `localhost:39481`, another service on the runner, was refused by the client
(`socksFailed`, `ERULESET`).

### G. A session's name, and the reason it ended

A WebSocket proxy that answered each upgrade with `x-playwright-attachment: piwi-grid-session=<uuid>`, in front of a
`run-server`, and a two-test Playwright Test suite with one worker. Both tests carried a `piwi-grid-session`
attachment with the same id (the JSON reporter's output). During the second test, the server was killed and the proxy
closed the client's connection with code 1011 and a reason naming the lost machine; the second test failed with
`locator.click:` followed by that reason, in place of the generic text.

### H. Header names through a Go reverse proxy

A server answered a WebSocket upgrade with `x-playwright-attachment` and `x-playwright-debug-log` headers. Read
directly, the names arrived in lowercase; through Go 1.24.7's `httputil.ReverseProxy`, the library Traefik and Caddy
build on, they arrived as `X-Playwright-Attachment` and `X-Playwright-Debug-Log`, which Playwright does not read.

### I. A screencast through a remote browser

`page.screencast.start({ onFrame, size: { width: 640, height: 400 }, quality: 50 })` on a page of a Chromium reached
through `run-server`, while the page's text changed 20 times in a second: 21 frames reached the client, 37 KB in all.
