# Running tests on browser grids

A study of how Piwi could run tests on BrowserStack, the services like it, and the browser grids a team runs itself.
It answers one question: can such a service give Piwi a test runner, so that a failure, a flaky test or a selection can
be run from the dashboard? It describes what these services actually provide, what Piwi already has, the options, and a
plan.

**Status.** Proposed 2026-10-12. Nothing is built. Vendor facts were checked on 2026-10-12 against each vendor's
documentation, change log and price page ([Sources](#sources)). Supported versions and prices change every month:
check them again before building on them.

## Words used here

| Term | Meaning in this document |
|---|---|
| **test runner** | Playwright Test's process, `npx playwright test`: it reads the config and runs the workers, the fixtures and the reporters, Piwi's included. |
| **launcher** | What starts a test runner for Piwi and names itself in `PIWI_ORIGIN`: the `piwi` CLI, the desktop app, an editor extension, a CI job ([run origin](../apps/docs/reference/test-metadata.md#run-origin)). |
| **remote browser** | A browser the test runner does not launch: it reaches it over a WebSocket through Playwright's `connectOptions` (`browserType.connect`). |
| **grid** | A service that hands out remote browsers on demand, with a limit on simultaneous sessions and a queue: BrowserStack Automate, TestMu AI, Azure Playwright Workspaces, Moon, a pool of Playwright servers. |
| **grid project** | A Playwright project whose `use.connectOptions` points at a grid. |
| **Playwright server** | `npx playwright run-server`, Playwright's own open-source server for remote browsers, which the official Docker image runs. |
| **session** | One remote browser, from connection to close: the unit a vendor bills, records on video and names. Its **session link** is the vendor's page for it. |
| **browser-minute** | A minute of a session: the unit a grid that bills by time counts. |
| **hosted runner** | A service that runs the test runner itself on its machines: Sauce Labs, HyperExecute, Checkly, Katalon. |
| **self-hosted runner** | A process a team runs on its own machine that takes work from the Piwi server and starts a test runner, connecting out only, as GitHub's self-hosted runners do. |
| **tunnel** | What lets a remote browser reach an application only the test runner's network can reach: a vendor binary (BrowserStack Local, Sauce Connect) or Playwright's `exposeNetwork`. |
| **dispatch** | The dashboard asking another system to start a test run: a CI pipeline today, as **Re-run in CI** does. |

## Summary

- **These services provide browsers, not test runners.** BrowserStack Automate, TestMu AI (LambdaTest until January
  2026), TestingBot, Perfecto and Azure Playwright Workspaces work the same way as the grids a team runs itself (Moon,
  Browserless, Playwright's own server). The Playwright test runner stays on the machine that has the code (a laptop,
  a CI job), and each worker connects to a browser on the grid over a WebSocket (`connectOptions`). BrowserStack does not run Playwright test runners for
  functional tests: the "re-run" button of its reporting product starts the customer's CI, as Piwi's **Re-run in CI**
  does. Among the vendors, only Sauce Labs, HyperExecute, Checkly and Katalon run the test runner on their own
  machines. Sauce Labs' and HyperExecute's documented APIs have no call that creates a job: their CLI uploads the code
  from a machine that has it, and HyperExecute can also start from a linked Git repository.
- **Piwi already decides where the test runner runs.** The `piwi` CLI, the desktop app, the editors and the dashboard's
  **Re-run in CI** all start runs. A grid plugs in under them; it does not replace them. What is missing:
  1. Knowing where an execution's browser ran.
  2. Letting the launchers pick a grid.
  3. Letting a team instance start more kinds of runs.
- **A run on a grid reaches Piwi today, and Piwi cannot tell.** The reporter runs inside the test runner, so a run whose
  browsers are on BrowserStack streams in like any other. But the reporter records the configured browser, not the
  real one: no browser version, no grid, no session link.
  - A test that starts failing the day the grid's `latest` Chrome moves up a version shows nothing different from
    yesterday's pass.
  - A project run on a grid in CI and on a laptop locally reads as one environment, so a failure on the grid and a
    pass on the laptop look like a flaky test.
  - Grid durations, which include a network round trip per Playwright call, are averaged with local ones into the
    duration-balanced shards.
- **Recommendation**, in four steps, each useful on its own:
  1. **Record where each browser ran**: its real version, and for a remote browser the grid's host, vendor and session.
     Keep grid runs apart where timing matters, and document the grids that work. This is reporter, core and server
     work, with no new outbound call from the server.
  2. **A local Linux browser.** The desktop app and `piwi run` start the Playwright server image matching the project's
     Playwright version in Docker and run against it. A macOS or Windows developer then reproduces a Linux CI failure,
     fonts and screenshots included, on their own machine.
  3. **Dispatch more from the dashboard**: re-run a run's failed tests, reproduce a test N times, run a selection, try
     a failure on the other projects (grid projects included). Each dispatch goes to the CI pipelines Piwi already
     starts, or through a signed webhook to any other CI system or service. The dispatch carries an id, and the
     reporter fetches the tests to run. CI keeps the grid credentials and the tunnel.
  4. **Later, when asked**: a self-hosted runner that takes work from a team instance, a helper that writes grid
     projects, real mobile devices.
- **Not recommended**: the dashboard driving remote browsers itself, vendor credentials stored on the Piwi server,
  BrowserStack's SDK bundled into Piwi (its license forbids it), or browsers in Piwi's image.

## What exists

### Where tests run

| Launcher | Where the test runner runs | Started by | Origin |
|---|---|---|---|
| A CI job | the CI machine | a push, a pull request | `ci` |
| **Re-run in CI**, Flake Lab in CI | the CI machine, through a GitHub `workflow_dispatch`, a GitLab pipeline or a Bitbucket custom pipeline | a person with `run:control` on a failure cluster or a flaky test | `ci-rerun`, `flake-lab` |
| `piwi run`, `preflight --run`, `flake`, `probe`, `bug --write`, `ai resolve` | the developer's machine, or CI | a person, a coding agent | `local`, `preflight`, `flake-lab`, `probe`, `bug` |
| The desktop app: Run locally, Reproduce here, Find the breaking commit here, Reproduce this flake, a bug report's replay | the developer's machine, in the linked folder or a throwaway worktree | the developer in the window, or an editor's job on the same machine | `desktop`, `reproduce`, `bisect`, `flake-lab` |
| The editor extensions | the developer's machine, in a terminal | the developer | `editor` |

Where the code is:

- The dispatch: `dispatchClusterRerun`, `matchCiRerunRun` and `runFlakeLabInCi` in
  `apps/application/server/utils/ci-rerun.ts`, which call `ScmProvider.dispatchRerun` in
  `server/utils/scm/{GitHub,GitLab,Bitbucket}Provider.ts`.
- The dispatch settings: `CiRerunSettings` (`shared/ci-rerun.ts`), stored in `projects.ci_rerun` and off by default.
- The CLI: `spawnPlaywright` (`packages/reporter/src/internal/support/playwright-spawn.ts`) and `piwi run`
  (`cli/select.ts`), which adds `--add-reporter @piwitests/reporter` on Playwright 1.63 and later.
- The desktop app: `runner.rs` and `worktree.rs` in `apps/desktop/src-tauri/src`.
- The editor service: it builds the command (`piwi/runArgs`), and the client runs it in a terminal.

The dashboard itself runs nothing.

- No code under `apps/application/server` launches a browser; quality reports are drawn as PDFs with `pdf-lib`.
- Flake Lab's design record states the rule: "The dashboard never runs tests; that holds for probes too"
  ([adr/flake-lab.md](../adr/flake-lab.md), D4).

### What a launcher is handed

- **A desktop job** ([`packages/core/src/desktop-job.ts`](../packages/core/src/desktop-job.ts)).
  - An editor or Piwi Picker posts a `DesktopJobRequest` to the desktop app on the same machine: a kind (`reproduce`,
    `bisect`, `flake-lab`), commits, up to 50 tests (`filePath`, `title`, `line`, `projectName`), a browser and a
    Flake Lab plan. In its own words, it "names commits, tests and lab conditions, never code or command-line flags".
  - The app shows the job and runs nothing until the developer starts it.
  - Requests are kept in memory: 50 at most, for 10 minutes each.
- **A dispatch's arguments** are built by `buildRetryArgs` (`shared/retry-command.ts`).
  - Each `file:line` is double-quoted.
  - A value holding a character a shell expands inside double quotes is left out: `$`, a backtick, `"`, `\`, `%`, `!`
    or a control character. A recorded file path therefore cannot inject a command into the workflow's shell.
  - A dispatch names 100 tests at most (`MAX_RERUN_TESTS`).
- **What the dispatch assumes about the providers.** Two of its assumptions no longer hold.
  - **GitHub's run id.** Piwi's code and docs say GitHub's `workflow_dispatch` returns no run id. Piwi therefore matches
    the finished run by an optional dispatch-id input that the workflow forwards as `PIWI_ORIGIN_REF`, and without it
    by branch, a start within six hours and the dispatched spec files (`matchRerunDispatch`). GitHub has returned the
    run id since February 2026 (D10).
  - **GitLab's variables.** The GitLab dispatch sends the arguments as a pipeline variable. Since 17.7, GitLab.com
    refuses pipeline variables by default for new projects in new namespaces, so the dispatch is refused there until a
    maintainer allows them (D10).
- **Plans**: the flake plan and probe plan endpoints, a fix plan's verify command, `resolve_selection`. Each returns a
  command or data for a launcher to run.
- **The desktop runner's checks.**
  - It accepts 12 Playwright flags (`--headed --debug --ui --trace --repeat-each --project --grep --workers --retries
    --max-failures --timeout --last-failed`) and refuses every other argument that starts with a dash.
  - It sets no environment variable of the webview's choosing (`validate_args` and `desktop_run_local_tests` in
    `runner.rs`).

### What the reporter records about the browser

- **Per execution, `browser` holds the configured browser** (`BrowserConfig` in
  [`packages/core/src/wire.ts`](../packages/core/src/wire.ts), filled from `project.use` by `metadata-collector.ts`):
  the project name, `browserName`, `channel`, the viewport, the locale, the color scheme and other context options.
  There is no browser version, and nothing about the machine the browser ran on.
- **Per run, the other fields describe the test runner, not the browser**: `playwrightVersion` is the test runner's
  version, the resource profile's `platform` and `machine` describe its machine, and `instanceId` hashes its hostname.
- **The environment diff** compares a failing execution with its last passing one (`shared/environment-diff.ts`). Its
  whitelist covers the Playwright and reporter versions, the environment, the CI provider, the branch, the `browser`
  fields, and the worker and shard index.
- **`environment`** is a free-text label for the deployment under test (`PIWI_ENVIRONMENT`), and baselines prefer the
  same one ([concepts](../apps/docs/guide/concepts.md)). It does not describe where the browser ran.
- **The reporter has no code for remote browsers.**
  - `connectOptions`, `wsEndpoint` and `browser.version()` appear nowhere in `packages/reporter/src`.
  - The capture fixtures patch the browser Playwright's own fixture creates, so a configured `connectOptions` passes
    through untouched.

### What assumes the browser runs beside the test runner

| Feature | What it assumes | With a remote browser |
|---|---|---|
| CPU, memory and disk ([resource leaks](resource-leaks.md)) | It reads the test runner's process tree (`/proc`, `ps`, CIM) and the temporary folders of browser profiles. | The browser is outside the tree. [The docs](../apps/docs/features/cpu-memory-disk.md) say it "is not measured", but no code adds that note. `resource-verdicts.ts` maps the `Launch browser` and `Connect over CDP` steps, not the step `browserType.connect` records. |
| Flake Lab's `cpu` and `network` conditions, page metrics after a test, code reach | CDP: `newCDPSession` with `Emulation.setCPUThrottlingRate`, `Network.emulateNetworkConditions`, `Performance.getMetrics`; `page.coverage`. | These are Chromium only. Over Playwright's protocol they are ordinary calls and should work (inferred from Playwright's source, not tested). A vendor may refuse them; the lab already reports a condition as skipped when its CDP session fails. |
| Pause at a breakpoint, inspect and pick on failure | A visible browser on the developer's screen, outside CI. | The browser is not on the developer's screen. |
| The editor's recorder | `browserType.launch`, headed, on the developer's machine. | Unchanged: recording needs a browser the developer sees. |
| Flake Lab and probe results | Workers append to local JSONL files that the CLI reads. | Unchanged with a remote browser. A hosted runner breaks it, because it runs the workers elsewhere. |
| Stopping a run in the desktop app | It kills the process tree, browsers included. | A remote session ends when its WebSocket closes. |
| Durations | The selection catalog averages a test's duration over every eligible execution, in every Playwright project (`shared/handlers/selections.ts`). Duration-balanced shards are built from that average. | A grid project's slower executions are averaged with local ones. |

### Rules this study keeps

- **The dashboard plans, dispatches and records**; tests run where a launcher runs them (Flake Lab, D4).
- **Self-hosted, zero telemetry.** Every outbound call the server makes is listed in
  [Privacy & data flow](../apps/docs/guide/privacy.md), and all but two are switched on by an administrator.
- **Playwright only, one container** ([ROADMAP.md](../ROADMAP.md#non-goals)).
- **Licenses.** The reporter, core and picker-dom are MIT; the app and the desktop app are FSL
  ([AGENTS.md](../AGENTS.md#licensing-must-follow)). A vendor's proprietary SDK cannot be bundled in either.
- **Permissions.** Starting a run from the dashboard needs `run:control` ("Re-run in CI, bisect, Flake Lab, fix
  attempts"), which starts at Maintainer (`shared/permissions.ts`).
- **Wire format.** A new wire field is an optional addition that an older server drops. Origin kinds and the dispatch
  contract freeze at 1.0 ([1.0-stabilization.md](1.0-stabilization.md)).

## What the services provide

### Three ways to reach a browser

1. **A remote browser over Playwright's protocol.**
   - How: `browserType.connect(wsEndpoint)`, or `use.connectOptions` in Playwright Test.
   - The test runner, its workers, fixtures and reporters stay on the client; the server launches the browser and
     drives it.
   - Full Playwright fidelity, all three engines.
   - Who: BrowserStack Automate, TestMu AI, TestingBot, Perfecto, pCloudy, Azure Playwright Workspaces, Browserless,
     Moon and the Playwright server.
2. **A remote browser over CDP.**
   - How: `chromium.connectOverCDP`.
   - Chromium only, "significantly lower fidelity than the Playwright protocol connection" in Playwright's docs, and
     no `exposeNetwork`.
   - Who: Selenium Grid (through `SELENIUM_REMOTE_URL`, Chrome and Edge only, marked experimental in Playwright's
     docs) and the cloud browsers built for AI agents (Browserbase, Steel, Hyperbrowser, Kernel, Anchor, Cloudflare).
     They suit agent automation, not a cross-browser test suite.
3. **A hosted runner.**
   - The vendor runs `npx playwright test` on its own machine, after a client uploads the project or the vendor clones
     it from Git.
   - Who: Sauce Labs (`saucectl`), TestMu AI HyperExecute, Checkly (`npx checkly pw-test`, Playwright Check Suites),
     Katalon True Platform (new in August 2026).
   - Sauce Labs' and HyperExecute's APIs list, stop and download jobs, but have no endpoint to create one.

BrowserStack is in the first group only. Its Test Reporting & Analytics re-runs a build by starting the customer's CI
(`workflow_dispatch` on GitHub), as Piwi's **Re-run in CI** does.

### Vendors

Prices are per parallel session per month, billed yearly, unless stated otherwise. Playwright 1.64.0 came out on
2026-10-07; every vendor whose server must match the client's version trails it.

| Vendor | Model | Browsers and OS | Real mobile devices | Newest Playwright supported | Price | Data in the EU |
|---|---|---|---|---|---|---|
| BrowserStack Automate | remote browser; SDK optional | Chrome, Edge, Chrome for Testing, Playwright's Chromium, Firefox and WebKit; Windows 10–11, macOS | iOS Safari (since June 2025, a subset of commands), Android Chrome | 1.62, "two versions" policy | $99 desktop, $175 with mobile, $59 Chrome only; no pay per use | EU desktops in the Netherlands. Region restriction is Enterprise only, and test metadata still leaves the region. |
| TestMu AI | remote browser; HyperExecute is a hosted runner | Chrome, Edge, Playwright's browsers; Windows, macOS | Android; iOS in beta | "latest" claimed; device tables stop at 1.60–1.61 | $79; HyperExecute $103 on Linux | EU API hosts, no documented guarantee |
| TestingBot | remote browser | Chrome, Edge, Firefox, WebKit; Windows, macOS, Linux | Android | server matched to the client (vendor's claim) | $50 with 1,000 minutes, $90 unlimited | EU-hosted (vendor's claim); no SOC 2 or ISO 27001 |
| Sauce Labs | hosted runner (`saucectl`) | Playwright's browsers and Chrome; Windows, macOS, Linux | none for Playwright | 1.61.1 | $149 | EU Central data center |
| Azure Playwright Workspaces | remote browser (CDP too) | every Playwright browser; Linux, Windows | none | 1.50 and later | $0.01 per test minute on Linux, $0.02 on Windows, pay per use | West Europe and Switzerland North, data kept in the region |
| Perfecto | remote browser | Windows: Chrome, Edge; macOS: also Firefox, WebKit | Android (experimental), iOS in beta | 1.60 (the latest and the nine before) | on quote | not checked |
| Checkly | hosted runner | Playwright's browsers | none | your own version, 1.40 and later | per 30 seconds of run time | EU locations |

**More on Azure Playwright Workspaces**:

- **History.** Microsoft Playwright Testing was retired on 2026-03-08 and replaced by Playwright Workspaces in Azure
  App Testing.
- **Configuration.** Its package, `@azure/playwright` (MIT), turns `createAzurePlaywrightConfig` into ordinary
  `connectOptions`: a WebSocket endpoint and a bearer token, with `exposeNetwork: '<loopback>'` by default.
- **Limits.** Authentication goes through Microsoft Entra ID, and a workspace allows 100 parallel workers (one older
  page says 50).
- **Reports.** The HTML report goes to the customer's own storage account.

### Grids a team runs itself

| Grid | License | How Playwright connects | Notes |
|---|---|---|---|
| Playwright server (`run-server`, the official Docker image) | Apache-2.0 | Playwright's protocol. One endpoint serves all three engines: the client names its engine in a header. | **No authentication**: protection is `--host` and an unguessable `--path`. `--max-clients` queues the connections past the limit. Since 1.60 it ignores client-sent `args`, `ignoreDefaultArgs`, `chromiumSandbox`, `firefoxUserPrefs`, `downloadsPath` and `executablePath` unless started with `--unsafe`. One Playwright version per server, no capacity API. |
| Moon (Aerokube) | proprietary; free up to 4 parallel sessions, then $5 per session per month | Playwright's protocol on `wss://…/playwright/<browser>/playwright-<version>`, which picks the image for that version | Kubernetes or OpenShift, one pod per session, video to S3, a live view for headed sessions, no ARM64 for Playwright. No authentication built in since 2.x: an ingress or a sidecar adds it. |
| Browserless | SSPL or a commercial license; the vendor says commercial use, CI included, needs the latter | Playwright's protocol on `/chromium/playwright`, `/firefox/playwright`, `/webkit/playwright` | One image bundles several `playwright-core` copies (1.59.1 to 1.63.0 in the open-source 2.57.0) and picks one from the client's `User-Agent`. A queue and a live debug viewer. |
| Selenosis 2, Selenwright, BrowserThing | Apache-2.0 | Playwright's protocol | Small projects, active in 2026. Selenosis runs one pod per session through a Kubernetes operator, with no queue. Selenwright is a fork of Selenoid for Docker, with video. BrowserThing routes each client to a worker of its version and has a capacity API, but its sessions share a browser process. |
| Selenium Grid 4 | Apache-2.0 | **CDP only, Chrome and Edge**, through `SELENIUM_REMOTE_URL` (experimental in Playwright's docs): Playwright opens a WebDriver session, then connects over CDP | Router, distributor, session queue and nodes. An early pod-per-session mode on Kubernetes since 4.41, and KEDA autoscaling in the Helm chart. Video and VNC only for headed sessions, and Playwright Test runs headless by default. No `exposeNetwork`. An unauthenticated grid allows remote code execution (SeleniumGreed), so it needs its router's basic authentication and a firewall. |
| Selenoid, Ggr | archived on 2024-12-17 | — | Their READMEs point to Moon. |
| Testcontainers | MIT | The .NET module runs a Playwright server in a container; the Java and Node modules for Playwright are community-maintained | A grid created for one run and removed after it: the version is pinned, there is no queue and no live view. The local Linux browser of step 2 is the same pattern. |
| BrowserStack Automate self-hosted (formerly TurboScale) | commercial | Through BrowserStack's SDK or hub, into your own Kubernetes cluster | The grid runs in your AWS, GCP or Azure account and keeps artifacts in your storage. But test names, results and capabilities go to BrowserStack's US servers, and Linux runs Playwright 1.59. |
| Testkube | Testkube Community License and MIT | Not a grid: it runs `npx playwright test` in pods, a hosted runner inside your cluster | Sharding needs the paid control plane ($700 per runner agent per month). The standalone API has no authentication. |

**Several Playwright versions on one grid.** A server must match each client's major.minor, and Playwright's Firefox
and WebKit are patched builds tied to each release, so a grid keeps one image per minor version. It then routes
requests in one of three ways:

- by the version in the URL (Moon, Selenosis, Selenwright);
- by the client's `User-Agent: Playwright/x.y` (Browserless, BrowserThing);
- by a capability (BrowserStack's `client.playwrightVersion`).

**WebDriver BiDi does not open standard grids to Playwright yet.**

- Playwright's source has undocumented BiDi channels (`bidi-chromium`, `moz-firefox`), but it launches those
  browsers locally only.
- It has no call that connects to a remote BiDi endpoint.
- Selenium Grid, BrowserStack and Sauce Labs already expose BiDi for WebDriver sessions.

As of October 2026, the only way from Playwright onto a WebDriver grid is CDP, for Chrome and Edge.

### What BrowserStack adds over a Playwright server, and what it costs

What it adds:

- Branded Chrome and Edge at chosen versions (83 and later) on Windows 10–11 and macOS, and Playwright's WebKit on
  macOS.
- **Real iOS Safari**, since June 2025. BrowserStack implements the commands one by one, with limits: one context and
  one page per session, no `request` events for subresources, no `toMatchAriaSnapshot`.
- Real Android Chrome.
- **Capacity without operating anything**, with per-session video, console and network logs.
- An interactive session that takes over a paused browser.
- IP geolocation (Enterprise plan).
- An outbound-only tunnel to private applications (BrowserStack Local).
- SOC 2 and ISO 27001 certifications.

What it costs:

- **The price.**
  - $99 to $225 per parallel session per month, billed yearly, with no pay-per-use plan.
  - Plans with up to 5 parallel sessions can queue 5 more; a queued session is dropped after 15 minutes.
- **A version behind.** The server must match the client's major.minor: BrowserStack lists 1.62 while 1.64 is out. A
  team upgrades Playwright when its grid does.
- **The data leaves.**
  - The page, screenshots, video and logs are on BrowserStack's machines.
  - Text logs cannot be turned off and are kept 60 days.
  - Under region restriction, test metadata still leaves the region.
- **Its SDK** (`browserstack-node-sdk`) cannot ship with Piwi.
  - It rewrites the Playwright projects into one per platform, and sends usage and reporting data by default.
  - Its license forbids incorporating it into a product offered to others. Piwi can describe a team's use of it, but
    not ship it.
  - The raw `connectOptions` path works without it, and BrowserStack documents both.

## How a test reaches a remote browser

What the Playwright source (1.63 in this repository, 1.64 upstream) and the vendors' docs establish:

- **Configuration.**
  - Playwright Test reads `use.connectOptions` (`wsEndpoint`, `headers`, `timeout`, `exposeNetwork`), for one
    project or all.
  - `PW_TEST_CONNECT_WS_ENDPOINT` overrides it for a whole run. Playwright's Docker page documents it:
    `PW_TEST_CONNECT_WS_ENDPOINT=ws://127.0.0.1:3000/ npx playwright test`.
  - The same code reads `PW_TEST_CONNECT_HEADERS` (JSON) and `PW_TEST_CONNECT_EXPOSE_NETWORK`, which are undocumented.
  - The `browser` fixture is worker-scoped. Each worker opens one connection and sends its engine in
    `x-playwright-browser` and its launch options in `x-playwright-launch-options`.
- **One endpoint, or one per browser.** A Playwright server and Azure read the engine from that header, so one endpoint
  serves a config's Chromium, Firefox and WebKit projects. Browserless and Moon put the browser in the URL's path, and
  BrowserStack, TestMu AI and TestingBot in capabilities in the URL's query, so each grid project there has its own
  endpoint.
- **Versions.** The client and the server must share major.minor. A Playwright server answers HTTP 428 "Playwright
  version mismatch" otherwise.
- **The tunnel.**
  - `exposeNetwork` sends the remote browser's requests for the listed hosts back through the WebSocket. The test
    runner's machine opens those connections, with no binary and no inbound port. `<loopback>` covers `localhost`, so a
    `webServer` started by the config is reached as usual.
  - Azure turns it on by default.
  - BrowserStack, TestMu AI and TestingBot document their own tunnel binaries instead.
- **What works remotely.**
  - Tracing: the server streams the trace back.
  - Screenshots.
  - Video and downloads, through `saveAs()`; `path()` throws.
  - `setInputFiles` with local files, which are streamed to the server.
  - `page.route`: its handler runs on the client, so each intercepted request costs a round trip.
  - CDP sessions and coverage on Chromium: ordinary protocol calls, not tested on each vendor.
- **What does not work remotely.**
  - `launchPersistentContext`, because the server only launches browsers. That rules out browser extensions;
    BrowserStack has its own upload flow over CDP for them.
  - Anything shown on the developer's screen.
- **Latency.** Every `await` on a Playwright call is a round trip over the WebSocket. No vendor publishes a figure.
  Test and step durations grow with the distance to the grid; request timings measured inside the browser do not.
- **Sessions span tests.** A worker keeps its connection across tests and opens a new one after a failure, because
  Playwright then restarts the worker. A vendor's session, its video and its pass or fail mark therefore cover several
  tests. BrowserStack's older sample opens one connection per test by overriding `page` instead.
- **Naming the session.** Three sources can tell a test which session it ran in:
  - `browser.version()` gives the real browser version, on any grid.
  - BrowserStack, TestMu AI and TestingBot answer a call made from the page (`page.evaluate` with
    `browserstack_executor: {"action":"getSessionDetails"}` and their equivalents) with the session id, the OS and the
    session's links.
  - Playwright Test also turns each `x-playwright-attachment: name=value` header the server sends when the connection
    opens into a text attachment on every test that uses that browser. A grid, or a proxy in front of a pool of
    Playwright servers, can put its session id there. The header is in the code of 1.63 and 1.64 but not in the docs.
- **Timeouts and queues.**
  - BrowserStack closes a session idle for 90 seconds (up to 300 with `idleTimeout`). It drops a queued session after
    15 minutes and refuses any beyond the queue.
  - A Playwright server queues the connections past `--max-clients`, with no limit.

## What each part of Piwi gains

| Piwi feature | What a grid adds | Condition |
|---|---|---|
| Explaining a failure (environment diff, failure clues) | "The grid's Chrome went from 152 to 153 between the last pass and this failure", or "this failed on the grid and passed on a laptop", reads as an environment difference, not as a flaky test. | The execution records its browser version and grid (step 1). |
| Flaky tests | A test flaky on one grid only becomes an environment suspect. Flake Lab's `project` condition already runs a test in another Playwright project, a grid project included. | Durations and flaky rates kept per project (step 1). |
| Reproducing a failure | A Linux browser on a macOS or Windows machine renders as Linux CI does, so a screenshot comparison reproduces. A real Safari or iOS device reproduces a failure seen only there. | Docker on the machine (step 2), or a grid project with its credentials. |
| Verifying a fix | Run the fixed tests where they failed. | A dispatch (step 3). |
| Flake Lab | Arms could run at the same time, each on its own remote browsers, with the control in the same grid project. | The lab runs its arms one after another today, so this changes its design. It routes every request of the target's page, and each routed request costs a round trip to the grid. The `cpu` condition needs CDP on the grid. The load and interference suspects measure the test runner's machine, not the grid's. |
| Finding the breaking commit | Nothing. | Each step costs a checkout, an install and an application build at a commit; the browser is not the bottleneck. |
| Selections and shards | More browsers at once than a CI machine has cores. | Shards built from the durations of the same project. |
| Editor runs | A grid project is one more `--project`. | The grid's credentials in the developer's environment. |
| Recorder, breakpoints, pick on failure | Nothing. | They need a browser on the developer's screen. |
| Test Map probes | Client probes intercept with `page.route`, which works remotely. | Each intercepted request costs a round trip to the grid. |
| AI steps | Resolution reads the test's own page, so it works on any browser. | None. |
| A team instance without the desktop app | Runs started from the dashboard. | A dispatch (step 3), or a self-hosted runner (later). |

## Options

**A. Record grid runs and keep them apart.**
- What: the capture fixtures record the real browser version and, for a remote browser, the grid. The reporter falls
  back on `connectOptions` from the config and the environment. The server shows it, diffs it, and averages durations
  per project.
- Cost: small.
- Fit: it is the base of every other option and adds no outbound call. **Recommended.**

**B. Grids in Piwi's launchers.**
- What:
  - Grid projects need nothing new, since every launcher already passes `--project`.
  - New: a local Linux browser. The launcher starts the Playwright server image for the project's Playwright version
    in Docker, bound to `127.0.0.1` with a random path, and runs with `PW_TEST_CONNECT_WS_ENDPOINT` and
    `exposeNetwork: <loopback>`.
- Cost: small to medium.
- Fit: it stays on the developer's machine and needs no account. **Recommended.**

**C. Dispatch more from the dashboard.**
- What:
  - New entry points: re-run a run's failed tests, reproduce a test N times, run a selection, run a failure on the
    other projects.
  - The dispatch carries an id, and the reporter fetches the tests to run in Playwright's `preprocess()` hook.
  - A dispatch can target an exact commit.
  - Piwi reads GitHub's run id, sends GitLab pipeline inputs, and offers a signed webhook for any other CI system or
    service.
- Cost: medium.
- Fit: grid credentials and the tunnel stay in CI, and it reuses the dispatch and run matching that exist.
  **Recommended.**

**D. A self-hosted runner that takes work from a team instance.**
- What: a queue on the server, runner registration, leases and heartbeats, cancellation, and worktrees in Node. A team
  instance could then run tests without CI, and on a warm checkout.
- Cost: large.
- Fit: the runner executes repository code on demand, which needs the same care as a CI runner. **Later, when a team
  without a CI it can dispatch to asks.**

**E. Integrate hosted runners one by one** (Sauce Labs, HyperExecute, Checkly, Testkube).
- What: Piwi would start jobs on their machines itself.
- Cost: medium per vendor.
- Fit: poor.
  - Sauce Labs and HyperExecute have no API to create a job; the code is uploaded from a machine with the checkout.
  - The reporter would run on their machines and need a route to the Piwi server.
  - Flake Lab's local result files would not reach the CLI.
- **Not recommended**: reach them through CI or the webhook (C).

**F. The dashboard drives remote browsers itself.**
- What: the server runs a test against a grid on its own.
- Fit: none. The server has no checkout, no test code and none of the application's secrets; this would make it a test
  runner, against Flake Lab's D4 and the single-container design. **Rejected.**

**G. Piwi ships a grid.**
- What: Playwright servers managed by Piwi, in its compose file or through a Kubernetes operator.
- Cost: large and permanent: browser images, a version per Playwright release, autoscaling.
- Fit: operating browsers is the vendors' and the Playwright server's job. **Rejected**; a documented compose service
  next to Piwi's is enough.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The dashboard plans, dispatches and records; it never runs a test or drives a browser, and Piwi hosts no browsers. | Flake Lab's D4 holds; the server has no checkout; one container stays one container. |
| D2 | Piwi's own code reaches a grid only through Playwright's `connectOptions` and depends on no vendor SDK; a team's config may still use one (Azure's config helper, BrowserStack's SDK). The Piwi server stores no vendor credentials. | Every vendor in the first group documents the raw path. A vendor SDK rewrites the run, sends data and, for BrowserStack, cannot be bundled. Credentials stay on the machine that runs the test runner. |
| D3 | A grid is configured as a grid project in `playwright.config`, and Piwi's launchers and dispatches choose projects. The one exception: a launcher may point a whole run at a Playwright server it started itself (D7). | `--project` already flows through every launcher, dispatch, Flake Lab condition and history view. A grid project records like any project. |
| D4 | Each execution records its browser's real version (`browser.version()`). A remote browser also records its grid: the host without path or query (BrowserStack carries credentials in the query), the vendor recognized from the host, and the session id and session link when the vendor offers them in the page or the grid sends them as an `x-playwright-attachment`. | The configured browser cannot explain a difference between two machines. The query string of a vendor URL holds secrets. |
| D5 | Durations, shards, slow-test numbers and CI-minute costs use the same Playwright project's history. A test whose flaky executions are all in one grid project is shown as flaky there. | Grid durations include a round trip per call; mixing them skews shards and slow-test thresholds. |
| D6 | A feature that needs the browser's machine says so instead of guessing. Resource measurement reports a remote browser as not measured. CDP conditions report "skipped" when the grid refuses them. Headed features stay local. | A missing measurement must not read as zero. |
| D7 | The desktop app and `piwi run` can start a local Playwright server in Docker for the project's own Playwright version and run against it. The launcher sets the endpoint; the webview passes a choice, not a variable. | It reproduces Linux rendering on any machine with no account, and keeps the desktop runner's guarantee that the webview sets no environment. |
| D8 | A dispatch carries an id. The reporter, on Playwright 1.62 and later, reads that dispatch's tests from the server in `preprocess()` and excludes the others. Quoted `file:line` arguments remain the fallback. | No test name or path crosses a shell, the 100-test cap goes away, and one mechanism serves CI, the webhook and a future self-hosted runner. Allure TestOps applies its test plan in the same hook. |
| D9 | A dispatch can target an exact commit: a `sha` input on GitHub and GitLab, a commit target on Bitbucket. | GitHub, GitLab and CircleCI start a pipeline on a branch or tag only. Reproducing a failure needs its commit. |
| D10 | GitHub dispatches read the run id GitHub now returns. GitLab dispatches can send pipeline inputs instead of variables. | GitHub returns the run id since 2026-02-19 (always under API version 2026-03-10). Since 17.7, GitLab.com refuses pipeline variables by default for new projects in new namespaces, and GitLab recommends inputs. |
| D11 | A signed webhook is the dispatch target for every system Piwi does not call itself: Jenkins, Azure DevOps, Testkube, a script around `saucectl` or HyperExecute, an in-house service. It is signed as notification webhooks are. | One contract instead of one integration per vendor; the outbox already retries. |
| D12 | No self-hosted runner now. If one is built, it reuses the desktop job's shape (commits, tests, conditions, never code or flags), the outbox's leases, and outbound-only polling. | The dispatch covers teams with CI. The design is known from GitHub's self-hosted runners, GitLab Runner, the Buildkite agent and Checkly's private locations. |
| D13 | A dispatch to a grid project shows its estimate before it starts: tests × repeats × the median duration in that project, and the sessions it holds at once. | Paid grids bill per parallel session or per minute; `--repeat-each=100` is easy to click. |
| D14 | The privacy page says what a grid receives and keeps. The server makes no new outbound call, except the webhook an administrator configures. | The promise is that every outbound call is listed and opt-in. |

## What the reader gets

On an execution's page, the browser line and the environment diff:

```
Browser   Chrome 153.0 · BrowserStack (cdp.browserstack.com) · Windows 11 · session 7f3a…  ↗
          project chrome-windows · channel chrome · viewport 1280×720

Environment against the last pass (run #4211, yesterday)
  Browser version  152.0 → 153.0
```

On a run's page, the dispatch menu:

```
Re-run failed tests ▾
  in CI · chromium                 12 tests · about 6 min
  in CI · chrome-windows           12 tests · about 9 browser-minutes · 4 sessions at once
  in CI · on the other projects…   12 tests × 3 projects
```

From the CLI, a local Linux browser:

```
$ npx @piwitests/reporter run smoke --linux
piwi run · smoke · 42 tests · Playwright 1.64.0
Starting mcr.microsoft.com/playwright:v1.64.0-noble as a Playwright server on 127.0.0.1:53111
The browsers run in the container; localhost is reached through this machine (exposeNetwork: <loopback>)
```

## Delivery

Each PR is useful on its own, in this order. PRs 1 to 3 are step 1 of the summary, PR 4 is step 2, and PRs 5 and 6 are
step 3.

1. **Where the browser ran** (core, reporter, server, docs).
   - New optional fields `browserVersion` and `grid` per execution.
   - The capture fixtures read the `connectOptions` worker fixture and `browser.version()`. For a recognized vendor,
     they also read its in-page session call (`browserstack_executor: getSessionDetails`, TestMu AI's
     `getTestDetails`, TestingBot's `getSessionDetails`). The reporter reads a session id a grid sends as an
     `x-playwright-attachment`.
   - Without the fixtures, the reporter reads each project's `use.connectOptions` and `PW_TEST_CONNECT_WS_ENDPOINT`.
   - The server stores the fields, shows them on the execution's page and adds them to the environment diff.
   - The resource report says "not measured" for a remote browser, and `resource-verdicts.ts` learns the `connect` step.
2. **Like with like.**
   - Per-project durations in the selection catalog and the shards.
   - Flaky rates per project.
   - A Flake Lab experiment records its project's grid.
3. **Grid recipes and privacy.**
   - A **Browser grids** docs page: what works and what does not, then recipes for a Playwright server (Docker,
     Kubernetes), Azure Playwright Workspaces, BrowserStack without the SDK, TestMu AI, TestingBot, Moon and
     Browserless, and the limits of Selenium Grid.
   - The privacy section, and a compose service for a Playwright server next to Piwi.
4. **A local Linux browser**: `piwi run --linux`, and the same choice in the desktop app's run options (D7).
5. **Dispatches that carry an id** (D8).
   - The workflow hands the dispatch id to the reporter, as it already can through `PIWI_ORIGIN_REF`.
   - A dispatch endpoint the reporter reads in `preprocess()`, with the arguments as the fallback.
   - **Re-run in CI** moves to it. Flake Lab's dispatch already carries only a test case id, from which `piwi flake`
     reads its plan.
6. **More dispatches** (D9 to D11, D13).
   - New entry points on the run, test case, selection and failure pages.
   - The exact-commit input, GitHub's run id, GitLab inputs, the webhook target, the estimate, and the docs.

Later, when asked:
- A self-hosted runner (D12).
- A helper that writes grid projects for a vendor.
- Marking the vendor session as passed or failed.
- Real mobile devices.

## Costs

Three workloads, priced on 2026-10-12. Azure bills browser-minutes, which it calls test minutes; BrowserStack bills the
sessions running at the same time, whatever their length.

| Workload | Browser-minutes | Azure, Linux | BrowserStack desktop | Self-hosted |
|---|---|---|---|---|
| A cluster checked on other projects: 12 tests × 3 grid projects × 40 s | 24 | $0.24 | covered by the plan; holds 3 to 12 sessions for 2 to 8 minutes | the machines only |
| A Flake Lab session: a control and 3 arms, up to 10 runs each, a 30-second test | 20 at most | $0.20 | covered by the plan; 1 session for 20 minutes, or 4 for 5 | the machines only |
| A nightly suite: 800 tests × 4 projects × 20 s, finished within 30 minutes | about 1,070 a night | about $10.70 a night, $320 a month | about 36 sessions at once: 36 × $99 = $3,564 a month | Moon: 36 × $5 = $180 a month. A Playwright server pool: the machines only. Either way, about 36 vCPU and 72 GB of memory at 1 CPU and 2 GB per browser (Moon's default). |

The nightly suite is where the pricing models part ways. At the other end, a team that wants one rarely used grid
project, real iOS Safari for instance, pays for a whole parallel session of BrowserStack's mobile plan ($175 a month);
Azure bills by the minute but has no real devices.

## Privacy and security

- **The server.**
  - PRs 1 to 5 add no outbound call from the server.
  - PR 6 adds the webhook target, which an administrator configures, and the privacy page lists it with the
    notification webhooks.
  - The session id and link come over the connection the test runner already has to the grid.
- **What a grid receives.** The test runner's machine sends it everything the page shows and sends: screenshots, video,
  console and network logs, and typed values, test credentials included.
  - BrowserStack keeps text logs 60 days, and they cannot be turned off; other logs are kept 30 days.
  - `maskCommands` hides typed values from BrowserStack's logs but not from Playwright's logs, which
    `playwrightLogs: false` turns off.
  - A team that must keep its data in its own network uses a Playwright server or Moon there, or Azure in an EU region.
- **Credentials** stay where the test runner runs: CI secrets, the developer's environment.
  - Piwi stores the session link, which needs the viewer's vendor login.
  - It does not store BrowserStack's `public_url`, which carries a token that opens the session without logging in.
- **A Playwright server has no authentication.**
  - Bind it to `127.0.0.1` or a private network, give it an unguessable `--path`, and never start it with `--unsafe`.
  - Playwright describes its Docker image as "intended to be used for testing and development purposes only".
- **Dispatch values.**
  - Every value follows `buildRetryArgs`'s rule: quoted, with no character a shell expands.
  - The docs' workflow examples pass inputs through an environment variable, as GitHub's script-injection guidance
    recommends: `env: PW_ARGS: ${{ inputs.args }}`, then `npx playwright test $PW_ARGS`.
  - A dispatch that carries only its id puts no test name or path in the pipeline at all.
- **Who can dispatch**: `run:control`, with the estimate (D13) shown before a dispatch to a grid project.

## Risks

- **Version lag blocks upgrades.**
  - A team on Playwright 1.64 cannot use BrowserStack or Sauce Labs until they support it.
  - Piwi features that need 1.63, such as aria snapshots in traces, need a grid that runs 1.63.
  - The docs say so, and the reporter names the cause when a connection fails with HTTP 428.
- **Grid latency causes timeouts a local run never sees**, and they read as flakiness. Per-project history (D5) limits
  the damage; it does not remove it.
- **Vendors change fast.** Within a year:
  - LambdaTest became TestMu AI.
  - Microsoft Playwright Testing became Azure Playwright Workspaces.
  - Sauce Orchestrate's documentation disappeared.
  - TurboScale became Automate self-hosted.

  Piwi depends on Playwright's protocol and a host table, not on any vendor's SDK.
- **Undocumented variables.** `PW_TEST_CONNECT_HEADERS` and `PW_TEST_CONNECT_EXPOSE_NETWORK` may change. PR 4 uses
  them only for the server it starts, and its tests run against each Playwright release.
- **Sessions span tests.** A vendor session link points into a session that covers other tests of the same worker.
- **Cost.** A large `--repeat-each` on a paid grid holds sessions for a long time; the estimate (D13) is the guard.
- **Hook availability.** `preprocess()` exists from Playwright 1.62, and the reporter supports 1.61.1, so the
  arguments stay the fallback.
- **Rendering may still differ on Apple silicon.** There the Linux image runs on arm64, and screenshots may differ from
  an amd64 CI machine. PR 4 measures it before claiming identical rendering.

## Open questions

1. **A helper or recipes only?** Should Piwi offer a helper that writes grid projects (`piwiGrid({ vendor, platforms })`
   returning Playwright projects)? Recommendation: recipes first, and a helper only for vendors whose capability format
   has been stable for a year.
2. **Where the new fields go.** Inside `browser` or beside it? Recommendation: beside it, as `browserVersion` and `grid`,
   since `browser` is what the config asked for.
3. **Vendor session marks.** Should the fixtures mark the vendor's session as passed or failed? Recommendation: no.
   It serves the vendor's dashboard, a session covers several tests, and the vendor's SDK does it for teams that want
   it.
4. **The BrowserStack SDK.** Does it keep Piwi's reporter and capture fixtures working? BrowserStack says its SDK "does
   not support test context marking out of the box with custom test fixtures". This needs a spike.
5. **CDP per vendor.** Does CDP work on BrowserStack, TestMu AI and TestingBot, for Flake Lab's `cpu` condition? This
   needs a spike.
6. **Grid capacity.** Should a team instance read a grid's capacity (BrowserStack's `plan.json`) before a dispatch?
   That needs vendor credentials on the server, against D2. Recommendation: no.
7. **The webhook contract.** What the body holds, the signature, the answer expected, and retries through the outbox.
8. **The first self-hosted runner.** The desktop app taking a team instance's work for its own user, or a headless
   process started from the `piwi` CLI?

## Not in this plan

- Browsers or a grid in Piwi's image.
- Grids for other frameworks (Selenium, Cypress): Piwi stays Playwright only.
- Native mobile apps (Appium).
- Scheduled monitoring of production (Checkly's job), and load testing.
- Importing results from a vendor's reporting product (BrowserStack Test Reporting & Analytics, Sauce Insights).
  Piwi's reporter runs in the same test runner and records the run itself.

## Sources

Checked on 2026-10-12.

**Playwright**

- [Remote connection in Docker](https://playwright.dev/docs/docker#remote-connection)
- [`browserType.connect`](https://playwright.dev/docs/api/class-browsertype#browser-type-connect) and
  [`exposeNetwork`](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-option-expose-network)
- [`connectOptions`](https://playwright.dev/docs/api/class-testoptions#test-options-connect-options)
- [Selenium Grid (experimental)](https://playwright.dev/docs/selenium-grid)
- [`Reporter.preprocess`](https://playwright.dev/docs/api/class-reporter) and
  [`TestRun`](https://playwright.dev/docs/api/class-testrun)
- [Release notes](https://playwright.dev/docs/release-notes)
- The server's version check, header handling and option filtering:
  [playwrightServer.ts](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/src/remote/playwrightServer.ts)

**BrowserStack**

- [Capabilities](https://www.browserstack.com/docs/automate/playwright/playwright-capabilities)
- [Browsers, OS and versions](https://www.browserstack.com/docs/automate/playwright/browsers-and-os)
- [Session status](https://www.browserstack.com/docs/automate/playwright/mark-test-status)
- [Session details](https://www.browserstack.com/docs/automate/playwright/get-session-details)
- [Local testing](https://www.browserstack.com/docs/automate/playwright/local-testing/how-local-testing-works)
- [Real iOS devices](https://www.browserstack.com/docs/automate/playwright/playwright-ios/nodejs)
- [Self-hosted grids](https://www.browserstack.com/docs/automate-self-hosted/overview/what-is-automate-self-hosted)
- [Re-runs in Test Reporting & Analytics](https://www.browserstack.com/docs/test-reporting-and-analytics/features/re-run)
- [Queueing](https://www.browserstack.com/docs/automate/selenium/queue-tests)
- [Region restriction](https://www.browserstack.com/docs/automate/playwright/geo-political-region-restriction)
- [Pricing](https://www.browserstack.com/pricing?product=automate)

**Other vendors**

- TestMu AI: [Playwright](https://www.testmuai.com/support/docs/playwright-testing/),
  [capabilities](https://www.testmuai.com/support/docs/capabilities-for-playwright/),
  [HyperExecute](https://www.testmuai.com/support/docs/hyperexecute-yaml-parameters/),
  [pricing](https://www.testmuai.com/pricing/)
- TestingBot: [Playwright options](https://testingbot.com/support/web-automate/playwright/options),
  [pricing](https://testingbot.com/pricing)
- Sauce Labs: [Playwright](https://docs.saucelabs.com/web-apps/automated-testing/playwright/),
  [the runner's source](https://github.com/saucelabs/sauce-playwright-runner),
  [Jobs API](https://docs.saucelabs.com/dev/api/jobs/), [pricing](https://saucelabs.com/pricing)
- Perfecto: [Playwright](https://help.perfecto.io/perfecto-help/content/perfecto/automation-testing/playwright.htm)
- Azure Playwright Workspaces:
  [overview](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/overview-what-is-microsoft-playwright-workspaces),
  [limits](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/resource-limits-quotas-capacity),
  [local applications](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/how-to-test-local-applications),
  [`@azure/playwright`](https://www.npmjs.com/package/@azure/playwright),
  [prices](https://azure.microsoft.com/en-us/pricing/details/app-testing/)
- Checkly: [`pw-test`](https://www.checklyhq.com/docs/cli/checkly-pw-test/),
  [private locations](https://www.checklyhq.com/docs/platform/private-locations/overview/)

**Grids a team runs**

- [Browserless](https://github.com/browserless/browserless) (license, images, routes)
- [Moon](https://aerokube.com/moon/latest/)
- [Selenoid (archived)](https://github.com/aerokube/selenoid)
- Selenium Grid: [components](https://www.selenium.dev/documentation/grid/components/),
  [GraphQL](https://www.selenium.dev/documentation/grid/advanced_features/graphql_support/),
  [Helm chart](https://github.com/SeleniumHQ/docker-selenium/tree/trunk/charts/selenium-grid),
  [SeleniumGreed](https://blog.leakix.net/2026/02/seleniumgreed-rce/)
- [Selenosis](https://github.com/alcounit/selenosis), [Selenwright](https://github.com/aqa-alex/selenwright),
  [BrowserThing](https://github.com/mbroton/browserthing)
- [Testcontainers for .NET: Playwright](https://dotnet.testcontainers.org/modules/playwright/)
- The `x-playwright-attachment` header:
  [packages/playwright/src/index.ts](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright/src/index.ts)
- [Testkube: Playwright](https://docs.testkube.io/articles/examples/playwright-basic) and
  [standalone limits](https://docs.testkube.io/articles/install/standalone-agent#agent-limitations-in-standalone-mode)

**CI dispatch and precedents**

- GitHub:
  - [`workflow_dispatch` returns run ids](https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids)
  - [REST API version 2026-03-10](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes)
  - [25 inputs](https://github.blog/changelog/2025-12-04-actions-workflow-dispatch-workflows-now-support-25-inputs/)
  - [Script injections](https://docs.github.com/en/actions/concepts/security/script-injections)
- GitLab: [pipeline inputs](https://docs.gitlab.com/ci/inputs/),
  [restricted pipeline variables](https://docs.gitlab.com/ci/variables/#restrict-pipeline-variables)
- Bitbucket: [Pipelines API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/)
- Allure TestOps: [GitHub integration](https://docs.qameta.io/allure-testops/integrations/github) and
  [allurectl test plans](https://docs.qameta.io/reference/ecosystem/allurectl/)
