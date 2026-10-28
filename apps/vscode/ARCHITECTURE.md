# VS Code extension architecture

How the VS Code extension in `apps/vscode/` works: what it draws from each answer of the editor service, its views and
commands, recording, and its test suites. The rules are in [`AGENTS.md`](AGENTS.md). What the service answers, and why,
is in [`packages/editor/ARCHITECTURE.md`](../../packages/editor/ARCHITECTURE.md): this file describes only what the
extension does with it. It is reference material: open the section for the area you change.

## Contents

- [Overview](#overview)
- [Service, lenses and credentials](#service-lenses-and-credentials)
  - [Proxy and the log](#proxy-and-the-log)
- [Settings and stored state](#settings-and-stored-state)
- [Walkthrough](#walkthrough)
- [Coverage marks](#coverage-marks)
- [Failures view](#failures-view)
- [Runs](#runs)
  - [Run notifications and tests in progress](#run-notifications-and-tests-in-progress)
  - [Test runs as tasks](#test-runs-as-tasks)
  - [Running the test at the cursor](#running-the-test-at-the-cursor)
  - [Breakpoints](#breakpoints)
  - [Run control](#run-control)
  - [Code from a stop](#code-from-a-stop)
- [Status bar](#status-bar)
  - [Compare with](#compare-with)
- [Open in IDE](#open-in-ide)
- [Send to editor](#send-to-editor)
- [Recording](#recording)
  - [Recording a test](#recording-a-test)
  - [Locator quick fixes](#locator-quick-fixes)
  - [Edits, recording from a paused test, and Stop](#edits-recording-from-a-paused-test-and-stop)
  - [Undo during a recording](#undo-during-a-recording)
- [Testing view](#testing-view)
  - [Test items](#test-items)
  - [Results and test runs](#results-and-test-runs)
- [Connect](#connect)
- [The pure half](#the-pure-half)
- [Keybindings](#keybindings)
- [Changelog](#changelog)
- [Screenshots](#screenshots)
- [Nightly suite](#nightly-suite)
- [Integration suite](#integration-suite)

## Overview

The extension is a thin client of the editor service. `npm run vscode:build` builds the service, then `build.mjs`
bundles the extension into `dist/extension.cjs` (esbuild, with `vscode` as an external module) and copies the service
beside it:

- `dist/piwi-language-server.cjs`, the service;
- the recorder's files the service looks for next to itself: `piwi-recorder-launcher.cjs`, `piwi-use-reporter.cjs`,
  `record-ide.js` and `record-ide-messages.json`.

`build.mjs` fails when one of these files is missing. What each file is:
[Build output](../../packages/editor/ARCHITECTURE.md#build-output) in the editor service's reference. The requests and
notifications named below: [Protocol](../../packages/editor/ARCHITECTURE.md#protocol), in the same reference.

## Service, lenses and credentials

`src/extension.ts` starts the service with `vscode-languageclient` and draws its answers.

**Each file's summary.** The extension asks `piwi/fileSummary` once per text version of a file and per drawing of the
files (`summaryOf`), and draws it in two places:

- A test's line goes to the gutter: an icon from `media/` and a hover with the test's details, **Run**
  (`piwi.runTests` with `SummaryLine.testCaseId`) and **Open in dashboard** (`testDecorations`, `testHoverMarkdown`,
  `TEST_HOVER_COMMANDS` in `src/glue.ts`). A failing test gets the `piwi.failingTestBackground` color, and the line it
  failed at gets `piwi.failingLineBackground`. That line keeps its color after it changed since the run, and the hover
  says so.
- Every other line of the summary (the file's line, a locator's tests) is a CodeLens.

The gutter is drawn with CodeLens turned off too (`decorateVisible`). `piwi/failuresChanged` and `piwi/coverageChanged`
draw the CodeLens and the gutter again, once for all the notifications of a 50 ms burst (`filesChanged`, `coalesced`
in `src/glue.ts`).

**The runs.** `piwi/runStatus` goes to the status bar: the tests still failing, those fixed locally since the latest
run (`failingTests`, `resolved`), and the run in progress (`live`). A notification that moves only the run in progress
leaves the CodeLens and the gutter as they are (`runsInFiles`). What the item shows: [Status bar](#status-bar).

**The service's commands.** The extension implements the commands the service names: `piwi.openInDashboard`,
`piwi.runTests`, `piwi.openTrace`, `piwi.openScreenshot`, `piwi.runCommand`, `piwi.copyText`,
`piwi.copyAgentContext` and `piwi.desktopJob`. `piwi.desktopJob` comes from a quick fix or from a flaky test's lens;
the job's updates (`piwi/desktopJobChanged`) show as notifications, with a button that shares the verdict.

**The credentials.** The connection is the instance (`piwi.serverUrl`), the project (`piwi.project`), the API key
(kept in `SecretStorage`), the choice of the desktop app, the baselines, `piwi.failureSeverity` (sent as
`failureSeverity`) and `piwi.mcpAuthorization` (sent as `mcpAuthorization`). The extension hands it to the service in
two ways:

- `piwi/setCredentials`, when a setting or the key changes: 250 ms after the last change of a burst, and only when the
  connection differs from the one last handed (`handChangedCredentials`), since each handing makes the service read
  everything again. The MCP servers are then asked again (`mcpServersChanged`).
- the initialization options of each start of the service (`handed`), since the client starts the service again after
  it stops unexpectedly.

**The MCP server.** Where the editor has `vscode.lm.registerMcpServerDefinitionProvider` (VS Code 1.101 and later),
the extension provides Piwi's MCP server through it. The API is looked up at run time: `engines.vscode` stays at the
oldest version `vscode-languageclient` supports, for Cursor and VSCodium. Once per machine, a notification says where
the server went, or, in an editor without that API, offers to copy its configuration (`offerMcp`).

**The runs' MCP server.** The service serves the runs this window starts to the agents of this machine
([Agents](../../packages/editor/ARCHITECTURE.md#agents)) while `piwi.serveRunsToAgents` says so: from the start (the
initialization options' `agents.enabled`), and as the setting changes (`piwi/agents`, sent too after each start of the
service for its address: `onDidChangeState`). The extension provides it beside Piwi's own, as the provider
`piwi.runs` (**Piwi runs**), an HTTP definition with the token as a bearer `Authorization` header (`runsMcpHeaders`),
changed as the service answers or tells (`piwi/agentsChanged`, `agentsHeard`). The token is the workspace's
(`agentsTokenKey`: `piwi.agentsToken <workspace>` in `SecretStorage`, made once) and the port the last one the service
listened at (`piwi.agentsPort`), both in the initialization options (`agents`), so **Piwi: Copy the runs' MCP server
configuration for agents** (`piwi.copyRunsMcpConfiguration`, `runsMcpConfiguration`, as an `mcpServers` entry for
Claude Code and Cursor or VS Code's `mcp.json`, `RUNS_MCP_FORMATS`) gives an agent outside the editor a configuration
that still connects after a restart, while the port stays free. When another program holds that port, the service
takes another with a new token and says so: the extension keeps both, and the provider's entry follows. **Piwi: Reset
the runs' MCP server token** (`piwi.resetRunsMcpToken`, after a modal warning) has the service take a new token
(`piwi/agents` with `newToken`), kept the same way.

### Proxy and the log

The service's environment is the extension host's, with the editor's proxy settings on top (`serviceEnvironment` in
`src/glue.ts`):

- `http.proxy` becomes `HTTPS_PROXY` and `HTTP_PROXY`, with a `Basic` `http.proxyAuthorization` as the proxy URL's
  credentials;
- `http.noProxy` becomes `NO_PROXY`;
- `http.proxyStrictSSL` turned off sets `NODE_TLS_REJECT_UNAUTHORIZED=0`;
- `NODE_EXTRA_CA_CERTS` passes through from the extension host's environment.

A setting left empty keeps the environment's own variable. A change of one of these settings starts the service again,
250 ms after the last change of a burst (`proxyChanged`). **Piwi: Open the log** (`piwi.openLog`) shows the client's
output channel, where `piwi.trace.server` writes the traffic with the service.

## Settings and stored state

The settings (`contributes.configuration` in `package.json`):

| Setting                  | Values, default first                    | What it does                                                                                    |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `piwi.serverUrl`         | a URL                                    | The instance. Connect writes it in the workspace settings.                                      |
| `piwi.project`           | a project name                           | The project. Connect writes it in the workspace settings.                                       |
| `piwi.breakpoints`       | `true`, `false`                          | Test runs pass the editor's breakpoints ([Breakpoints](#breakpoints)).                          |
| `piwi.runNotifications`  | `always`, `failures`, `never`            | The notification at a run's end ([Runs](#runs)).                                                |
| `piwi.failureSeverity`   | `error`, `warning`, `information`, `off` | The severity of a failure's diagnostic.                                                         |
| `piwi.mcpAuthorization`  | `key`, `sign-in`                         | How the agent signs in to Piwi's MCP server. Application scope: a workspace cannot override it. |
| `piwi.serveRunsToAgents` | `true`, `false`                          | The runs this window starts served to agents (**Piwi runs**).                                   |
| `piwi.testExplorer`      | `true`, `false`                          | Piwi's tests in the Testing view ([Testing view](#testing-view)).                               |
| `piwi.trace.server`      | `off`, `messages`, `verbose`             | The traffic with the service in the log.                                                        |

What the extension stores:

- **`SecretStorage`**: the API key of each instance (`piwi.apiKey <url>`), the Send to editor token
  (`piwi.sendToken`) and the runs' MCP server's token of each workspace (`piwi.agentsToken <workspace>`). The old key
  slot shared by every instance (`piwi.apiKey`) is deleted once (`forgetSharedKey`).
- **Global state** (this machine): `piwi.walkthroughOpened`, `piwi.mcpOffered`, `piwi.sendPort`,
  `piwi.sharedKeyForgotten`.
- **Workspace state** (this machine and this workspace, never a file the team shares): the desktop app chosen with
  Connect and its project (`piwi.desktop`, `piwi.desktopProject`, `piwi.desktopOffered`), the baselines
  (`piwi.baseline`), `piwi.coverageShown`, `piwi.failuresGrouping`, `piwi.followEditor`, a recording's choices
  (`piwi.recordStartUrl`, `piwi.recordPage`, `piwi.recordProject`), and the runs' MCP server's port
  (`piwi.agentsPort`).

The context keys the extension sets, which `package.json` reads in `when` clauses: `piwi.active`, `piwi.failuresView`,
`piwi.followEditor`, `piwi.hasCoverage`, `piwi.recording`, `piwi.recordingPaused`, and the run control's
`piwi.runActive`, `piwi.runPausable`, `piwi.runStopped`, `piwi.runResumed` and `piwi.runCanShare`
([Run control](#run-control)).

## Walkthrough

**Get started with Piwi** is the walkthrough (`contributes.walkthroughs`). Its steps are: connect, the failures, a run,
a recording, the MCP server, and the settings.

- Each step's media is a Markdown file of `walkthrough/`, which `.vscodeignore` ships.
- Each step has a button that runs a command of the extension: `piwi.connect`, `piwi.failures.focus`,
  `piwi.rerunFailing`, `piwi.recordFile`, `piwi.copyMcpConfiguration`, `piwi.openSettings`.
- Each step is checked off by its completion events (`onContext:piwi.active`, `onView:piwi.failures`, `onCommand:…`).

The walkthrough opens once per machine (`piwi.walkthroughOpened` in global state), on the first activation in a
workspace that holds a Playwright config (`PLAYWRIGHT_CONFIGS` in `src/glue.ts`, the activation event's glob). It does
not open when `workbench.welcomePage.walkthroughs.openOnInstall` is off, nor in the integration suite's window
(`ExtensionMode.Test`). **Piwi: Get started** (`piwi.getStarted`) opens it again (`WALKTHROUGH`).

`tests/walkthrough.test.ts` checks that each step names a contributed command or view, a context key the extension
sets, and a shipped Markdown file: a step that still names a renamed command, view or context key fails it.

## Coverage marks

Each visible file the service reads (C# files among them) is asked `piwi/coverage` once, and again after a
`piwi/statusChanged`. The answer is drawn as whole-line left borders (`coverageDecorations` in `src/glue.ts`):

| Lines                                                                         | Color                        | Style  |
| ----------------------------------------------------------------------------- | ---------------------------- | ------ |
| Lines tests ran                                                               | `piwi.coverageRunBorder`     | solid  |
| Executable lines no test runs                                                 | `piwi.coverageNotRunBorder`  | solid  |
| Lines changed since the coverage run                                          | `piwi.coverageChangedBorder` | dashed |
| In a file no test reaches, its uncovered changes (`CoverageResult.uncovered`) | `piwi.uncoveredChangeBorder` | solid  |

The first two colors default to the dashboard's (`COVERAGE_MARK_COLORS` in `@piwitests/core/coverage`, checked by
`apps/application/tests/unit/coverage-mark-colors.test.ts`). Every mark but the lines run also shows in the overview
ruler.

`piwi/coverageChanged` replaces a file's answer and draws it again, with the file's lenses. An edit asks for nothing:
the service pushes the marks it moved. The service's hover names the tests behind a line and ends on what the marks
mean, since VS Code shows no hover on a decoration's border. What the service computes:
[Coverage marks](../../packages/editor/ARCHITECTURE.md#coverage-marks) in the editor service's reference.

**Piwi: Toggle the coverage marks** (`piwi.toggleCoverage`) hides or shows them; the choice is kept in workspace state
(`piwi.coverageShown`, shown by default). The command is in the palette only once a file showed marks
(`piwi.hasCoverage`), so a workspace without coverage shows nothing of it.

## Failures view

`src/failures-view.ts` is the **Failures** view of the **Piwi** panel (`viewsContainers.panel`), a `TreeView`.

**Where its failures come from.**

- It shows what `piwi/failuresChanged` pushes (`show`). A push is never answered with a read.
- It reads `piwi/failures`, with its grouping, 200 ms after the extension starts or after a `piwi/statusChanged`, and
  when the grouping changes.
- It is drawn again when a `piwi/runStatusChanged` moves the editor's own run in progress (`ownLiveRun`).

**Its nodes** are the tree the service grouped (`FailuresResult.tree`), drawn by `failureNodes` in `src/glue.ts` with
each run's age. From the top: the run, **Your runs since**, then the failures by file, cluster, owner or flat. The
editor's own run in progress shows on the run of its Playwright config (`liveRoot`). When several configs have something
to show, each has a node of its own (icon `root-folder`) above its tree. **Group the failures by…**
(`piwi.groupFailuresBy`) changes the grouping, kept in workspace state (`piwi.failuresGrouping`). How the service builds
the tree: [The failures answer](../../packages/editor/ARCHITECTURE.md#the-failures-answer) in the editor service's
reference.

**Actions.** A node's `contextValue` decides its inline actions and its context menu (`view/item/context` in
`package.json`):

- A failure: `piwi.failure.<state>`, then `trace`, `screenshot`, `agent` and `desktop` for what it offers.
  **Copy context for agent** asks `piwi/agentContext`.
- A Playwright config's node: `piwi.context`, with `failing` and `run`. It runs **Re-run the failing tests**,
  **Open in dashboard** and **Compare with…** for that config.
- A run's node runs **Compare with…** for its config (`FailureNode.root`).

**Re-run the failing tests** (`piwi.rerunFailing`) runs `FailuresResult.rerun`, one run per Playwright config, or one
config's alone from its node (`failingRuns`). **Run this test** runs `failureRunArgs`. Both name the failure's config
(`root`).

**The rest of the view.**

- The badge counts the failing tests (`FailuresResult.failing`).
- **Follow the active editor** (`piwi.toggleFollowEditor`, `piwi.stopFollowingEditor`, kept as `piwi.followEditor`)
  reveals the active file's first failure.
- The welcome content follows the `piwi.failuresView` context key.
- The view's `getChildren` is in the API `activate` returns (`failureChildren`).

## Runs

### Run notifications and tests in progress

When a run started from the editor ends, `piwi/runEnded` shows as a notification (`runVerdict` in `src/glue.ts`), as
the `piwi.runNotifications` setting allows (`always`, `failures`, `never`):

- a warning with **Re-run failing** when something fails, an information message otherwise;
- both with **Open the failures** (`piwi.failures.focus`) and **Open in dashboard**.

A run with `repeat` (**Verify ×3**) is reported whatever the setting, as `Piwi: run #124 · Failed 1 of 3`, a warning
when one of the runs failed. A `piwi/notice` is shown as a warning or an information message, as its severity says.

A test the run in progress runs has the `running` gutter icon (`media/test-running.svg`), then that run's result.
`runsInFiles` keeps the run's `liveTests`, so the files are drawn again as its tests begin and end, at most once a
second (`filesRedraw`, `drawFiles` in `src/extension.ts`), and at once when the latest run changes.

### Test runs as tasks

A test run carries its own ref (`RunCommand.ref`, also in its environment). It runs as a VS Code task (`runAsTask`):

- a `vscode.Task` of the `piwi` type (`taskDefinitions` in `package.json`, `{ type: 'piwi', ref }`);
- its command is a `ShellExecution` in the Playwright config's folder, named `playwright test` and its arguments
  (`runTaskName` in `src/glue.ts`);
- it runs in a dedicated terminal, shown and cleared.

Its start sends `piwi/commandStarted`, and `tasks.onDidEndTaskProcess` sends `piwi/commandEnded` with the exit code, on
every VS Code version and in every shell. **Tasks: Rerun Last Task** runs the same command with the same ref:
`tasks.onDidStartTaskProcess` sends `piwi/commandStarted` for it, and the service follows it as a rerun of a ref it
knows.

A command without a ref (`piwi.runCommand`: the Flake Lab, a trace viewer) runs in a terminal instead (`runInTerminal`),
reused per folder and environment.

### Running the test at the cursor

Three commands, in the palette and in the editor's context menu of a spec:

- **Piwi: Run the test at the cursor** (`piwi.runTestAtCursor`);
- **Piwi: Verify the test at the cursor ×3** (`piwi.verifyTestAtCursor`);
- **Piwi: Run this spec** (`piwi.runSpec`), shown while `piwi.active`.

Each asks `piwi/testAt` for the cursor and saves the spec when it has unsaved changes. Then it runs through `runTests`
(`runTestAt`, `runSpec`): the test by its id when Piwi knows it, else by its location (`testAtRun` in `src/glue.ts`);
to verify, by its location, three times (`VERIFY_REPEAT`). When there is no test, a message says so. The first two
commands take a `{ uri, line }` argument (`testLineArg`) for the test at another line: the notification after a
recording names the line its block ends on.

### Breakpoints

Every test run passes the editor's breakpoints to the service (`breakpoints`), as the `piwi.breakpoints` setting allows
(on by default). That covers every run through `runTests` (the lenses, the gutter hover's **Run**, **Run this test**,
**Run the test at the cursor**, **Run this spec**, **Run the tests that reach this file**, **Re-run the failing
tests**) and **Run selection…**. The breakpoints passed are the enabled `vscode.SourceBreakpoint`s in script files under
a Playwright config's folder (`runBreakpoints` in `src/breakpoints.ts`).

When the answer's environment carries `PIWI_PAUSE_AT` or `PIWI_RUN_CHANNEL` (a run the editor or Piwi Picker can
pause), or the command says the run pauses at a `page.pause()` (`RunCommand.pauses`), `startRun` adds the pairing
address as `PIWI_EDITOR_SEND`. It starts the send listener when it is not running, minting its token as **Pair with
Piwi Picker** does, but copies nothing. The listener takes the port Pair with Piwi Picker saved, else, while another
window holds it, any free one, which it does not save (`sendPairing` in `src/send-listener.ts`: only the pairing Piwi
Picker is given saves its port). A `RunCommand.notice` (a reporter too old for breakpoints) shows as a warning, once
per notice. The API `activate` returns gives the latest run's command (`lastRun`). What the service does with the
breakpoints: [Breakpoints and picked locators](../../packages/editor/ARCHITECTURE.md#breakpoints-and-picked-locators)
in the editor service's reference.

### Run control

`src/run-view.ts` shows and steers the runs started here (`registerRunControl`), with Piwi's own commands and no debug
session. The initialization options say so (`runControl: true`). What the service does:
[Run control](../../packages/editor/ARCHITECTURE.md#run-control) in the editor service's reference.

**Sessions.** The extension keeps the latest `piwi/runSessionChanged` of each ref until one says `ended`, or the service
stops (`onDidChangeState`).

**Commands.**

- **Pause** (`piwi.pauseRun`: the running workers of every run of the window) and **Stop** (`piwi.stopRun`, which
  terminates the ref's task), while a run is live;
- **Resume**, **Step**, **Run to the cursor** (`run-to` the caret's line) and **Finish** (`piwi.resumeRun`,
  `piwi.stepRun`, `piwi.runToCursor`, `piwi.finishRun`), while a worker is stopped.

All but Stop send `piwi/runControl`, the four that answer a stop naming it (`since`); an answer with `ok: false` shows
as an information message. The commands show in the status bar beside the run's progress (`controlItems`), and in the
palette and on keys while they apply: the context keys `piwi.runActive`, `piwi.runPausable` and `piwi.runStopped`, and
`piwi.runResumed` for two seconds after an answer (`RESUMED_KEY_MS`). The keys: [Keybindings](#keybindings).

**A stop.** A stop opens its file at its line once (`stopKey`). It is drawn as the execution point:
`media/execution-point.svg` in the gutter, and the line's background in `piwi.executionPointBackground` (the debugger's
stack frame color by default), with a hover that holds the controls. A CodeLens above it reads `pausedText`
(`Paused · <title> · attempt N`, the attempt on a retry only) after `$(debug-pause)`, then Resume, Step, Run to cursor
and Finish, each naming its worker and its stop; one whose stop went on says `the test went on.` (`targetStop`). The
choice among several stops shows the same text after `$(debug-pause)`; the hover and the paused page's caption show it
as plain text. A key or a palette command acts on the stop at the caret's line, else the only one, else asks
(`stopsFor`).

**Edits since the run started.** A run's lines are the documents as they stood when it started (`started`, else when it
is first heard, a rerun under the ref of a run that ended included: `heardSession`). `EditLog` keeps the edits that
move lines while a run is live or starting (`workspace.onDidChangeTextDocument`, `lineEditOf`). They bring a stop to
the line it stands on now (the mark, the lens, the caret's match), and the caret's line back to the run's for Run to
the cursor, which is refused on a line written since. An event of several changes (the code a stop made, its undo) is
read change by change in the document after them all (`linesAbove`), so the mark follows it.

**The paused page.** A stop with no pause bar (`bar: false`) asks `piwi/pausedPage` and shows the JPEG in the
**Piwi: paused page** webview beside the editor, again at each such stop and on **Piwi: Show the paused page**
(`piwi.showPausedPage`). The webview takes images from `data:` only (`img-src data:`) and its one style by nonce
(`pausedPageHtml`). Where its worker takes `pick-at` and the image names its viewport (`picksOnImage`), a click on the
image picks the element under it: a script by the same nonce, the webview's only one, posts the click's offset and the
size the image is shown at, with which image it was on (`imageClickOf`); the extension maps it to the page's CSS pixels
(`pagePoint`) and asks `piwi/pickAt`, the locator going where a pick goes and the answer said under the caption. A
click on an image the view no longer shows picks nothing.

**Breakpoints during a run.** The breakpoints `breakpointsForRun` gives go to each live run as they change
(`vscode.debug.onDidChangeBreakpoints`, the `piwi.breakpoints` setting) with `piwi/setRunBreakpoints`, as lines of the
run's code (`runPlaces`). A breakpoint the run was given, known by `vscode.Breakpoint.id`, keeps its line while it only
moved with the edits; another is mapped back through them. They go only to a run whose places differ from those its
command started with or was last sent (`breakpointUpdates`), and once to a run as its first worker connects.

**A held failure** (`reason: 'failure'`) is `Failed · <how it failed> · attempt N` after `$(error)`, with Resume alone
among its controls. A stop an agent asked for (`RunStop.by: 'agent'`) reads `Paused by the agent · <title>`.

**Share with Playwright tools.** At a stop whose worker takes `bind` (`canShare`, the `piwi.runCanShare` context key),
the hover and the palette offer **Piwi: Share the stopped test's browser with Playwright tools**
(`piwi.shareWithPlaywright`). It warns first, in a modal, that any process of the user can then drive the browser
(`SHARE_WARNING`), and only a yes sends `piwi/stopBind`; the answer names the command that joins it
(`npx playwright cli attach piwi-<ref>-w<n>`), with **Copy the command** and **Stop sharing**. The browser is shared
until the test ends, never by an agent.

`src/run-control.ts` is the pure half, tested without an editor (`tests/run-control.test.ts`). The API `activate`
returns gives the sessions (`runSessions`), the lines drawn as the execution point (`executionPoints`), what the
paused page shows (`pausedPage`) and what the cursor's line says (`caretCount`).

### Code from a stop

What the service does: [Code from a stop](../../packages/editor/ARCHITECTURE.md#code-from-a-stop) in the editor
service's reference.

**The actions.** A stop's lens and hover also offer the code actions its worker takes (`RunWorker.takes`,
`stopActions`): **Pick a locator**, **Record here**, **Assert** and **Assert a region** at a stop the pause bar shows,
**Mock a request** at any. The lens names them shorter (`lens`), since its row is shared with the line's own lenses.
Each is a `piwi/stopAction` naming its stop. They are in the palette while a stop offers them (`piwi.pickAtStop`,
`piwi.recordAtStop`, `piwi.assertAtStop`, `piwi.assertRegionAtStop`, `piwi.mockAtStop`, the `piwi.runCan…` context
keys) and in the status bar's `$(code)` item, **Piwi: Write code at the stop…** (`piwi.codeAtStop`); none has a key.
Mock a request lists `piwi/stopRequests` in a quick pick, the latest first (`requestPicks`: the method and URL, which it
filters on, then the status, type, size or `no size`, and when it finished).

**The code a stop makes**, from here or Piwi Picker (`piwi/stopCode`, which the initialization options ask for:
`stopCode: true`), is one workspace edit in its document, opened when it is not. It is made only in the version the
service placed it in (else the file as saved; otherwise a warning offers **Copy the code**). The block is revealed
without taking the focus, and its sentence said, as a warning with what its reader should check (`stopCodeNotice`).

**The count at the cursor.** While a stopped worker counts locators (`takes` holds `locator`), the end of the cursor's
line in the stopped file says how many elements the locator there matches on the stopped page
(`piwi/locatorAtCaret`, `CaretCounts`): asked 200 ms after the cursor settles, one request at a time, an answer the
cursor left dropped, asked again when the cursor comes back; `3 matches`, `no match`, a refusal for three seconds,
nothing on a line holding no locator. The cursor leaving the file takes the page's outline down.

## Status bar

The status bar item (`statusBarView` in `src/glue.ts`) speaks for one Playwright config (`statusContext`): the deepest
config folder that holds the active editor's file, else the first connected config, else the first the instance did
not answer, else the first. It is drawn again from the answers it holds on `window.onDidChangeActiveTextEditor`.

**A click** depends on the state:

- connected: `piwi.refreshRun` (`piwi/refreshRun`), with the item's icon spinning meanwhile (`refreshingText`);
- the instance does not answer (`problemKind: 'unreachable'`, the `retry` action): **Piwi: Refresh**;
- not connected: **Piwi: Connect**;
- no Playwright config found: nothing.

**The tooltip** is a trusted `MarkdownString` whose commands are `STATUS_TOOLTIP_COMMANDS`. It holds, in order:

- the counts and the branch, and the config it speaks for when there are several (`StatusResult.contexts[].label`);
- the baseline, the local runs and the run in progress;
- when the run was read, `Updated 12 s ago · live` or `· read every minute` (`relativeTime`, written again every
  30 s);
- the instance and where its address comes from, the reporter version the project installs (`reporter 0.47.0`), and
  a hint when the desktop app runs but is not in use, or was chosen but does not run;
- links to `piwi.openRun`, `piwi.openInDashboard`, `piwi.compareWith` and `piwi.connect`, and to `piwi.refresh`
  (**Retry**) while the instance does not answer.

**Piwi: Open the latest run** (`piwi.openRun`) is in the palette too.

### Compare with

**Piwi: Compare with…** (`piwi.compareWith`, also in the failures view's title bar and in the tooltip) picks the
baseline of a config: the one of the node it runs from, else the active file's. The choices (`baselinePicks` in
`src/glue.ts`) are the default ladder, each branch of `RunStatus.branches`, a run by its id (typed in an input box and
read by `piwi/runId`), and the local runs only.

The choice is kept in workspace state (`piwi.baseline`, by config folder, the ladder as no entry: `withBaseline`) and
sent with `piwi/setBaseline`; the credentials carry the whole map (`baselines`). The tooltip and the view's run node
name the baseline (`baselineLine`); with the local runs alone, the run node reads `Your local runs`. What the ladder is:
[Latest run and baseline](../../packages/editor/ARCHITECTURE.md#latest-run-and-baseline) in the editor service's
reference.

## Open in IDE

The dashboard's **Open in IDE** reaches the extension through a URI handler (`vscode.window.registerUriHandler`, the
`onUri` activation event). The link is
`vscode://piwitests.piwi/open?file=<path as the run reported it>&line=&column=&root=`, built by the dashboard's
`buildVscodeExtensionUrl`.

`resolveOpenFile` in `src/glue.ts` finds the file as the service finds a run's path. It looks under `root` when that
lies in a workspace folder, then under the Playwright configs' folders, then under the workspace folders, and never
returns a file outside the workspace folders. The file opens at the 1-based line and column. When this window holds no
such file, a warning says so: VS Code hands the link to the window focused last.

## Send to editor

`src/send-listener.ts` is the Send to editor endpoint: `POST /piwi/send` on `127.0.0.1`, on the port kept in global
state (`piwi.sendPort`), with the token from `SecretStorage` (`piwi.sendToken`).

- **Piwi: Pair with Piwi Picker** starts it and copies the pairing address as the browser's machine reaches it
  (`pickerPairing`: `vscode.env.asExternalUri`, which a remote window forwards), on `127.0.0.1` whatever name VS
  Code gives it (`onLoopback`): `localhost` may resolve to `[::1]`, where another program could listen.
- A run's `PIWI_EDITOR_SEND` keeps the loopback address (`runPairing`), since the reporter runs where the extension
  does. Which port it takes: [Breakpoints](#breakpoints).

**Who gets an answer.** The listener answers only a request whose `Host` is `127.0.0.1` or `localhost` at its port, or
at the port of the browser's machine a remote window forwards to it (`forwarded`, set as the pairing address goes
through `asExternalUri`; a 403 otherwise: a page reached under another name). Every answer to a request carrying
`x-piwi-editor-challenge` (`isEditorChallenge`), whatever its route and status, the 401, the 403, the preflight and a
failure's 500 included, carries `x-piwi-editor-proof` (`editorTokenProof` of `@piwitests/core/editor-send`, for the
port the request named).
So Piwi Picker sends the token only to a listener that holds it. The CORS headers allow the challenge header and expose
the proof's.

**The live hubs.** With the same token and the same CORS rules (an extension's origin alone is named),
`GET /piwi/live` answers `{ hubs }`: the hub of every editor service running on the machine, read at each request from
their discovery files (`readLiveHubs` of `@piwitests/editor/discovery`, in `PIWI_EDITORS_DIR` or `~/.piwi/editors`).
Each hub carries the WebSocket's address and token, the pid, version, client, workspace folders and start, never a run
channel's token. So the one pairing reaches the runs of every window, the other windows' included. A request without
the token is a 401. The addresses are loopback ones: a remote window (`vscode.env.remoteName` set) lists its own
service's hub alone (`piwi/hub` names its address), at the loopback port of the browser's machine `asExternalUri`
forwards to it, on `127.0.0.1`, once `piwi/hub` with `forwarded` made the hub take that port in `Host` (`liveHubsHere`); none when
the forward is not a loopback `http:` address (Codespaces in the browser) or the service does not answer, and the
other windows' hubs never. How the files are read:
[The discovery file](../../packages/editor/ARCHITECTURE.md#the-discovery-file) in the editor service's reference.

What it inserts:

- A recorded flow is rendered by the service first (`piwi/renderSteps`, indented for the caret's line), and the
  service's import edit goes in the same edit.
- A locator with `at`, picked while a run was paused at a breakpoint, asks `piwi/applyPick` and applies the answer as a
  workspace edit on that line. When the line holds no locator, or the file is not in the workspace, the locator goes to
  the cursor and the notification says why (`pickNotice` in `src/glue.ts`).
- With no editor open, the text goes into a new untitled editor.

## Recording

What the service does during a recording: [Recorder](../../packages/editor/ARCHITECTURE.md#recorder) in the editor
service's reference.

### Recording a test

`src/recording.ts` records a test from the editor.

- **Piwi: Record here** asks `piwi/pageCandidates` where the caret is (`recordInto` in `src/glue.ts`): outside every
  test, function and class it records a new `test`; anywhere else, `steps` there.
- **Piwi: Record a new test file** creates a spec first (`file`), next to the active test file or in the config's
  `testDir`.

The start page and the page expression (asked when there are several candidates) are kept in workspace state, with the
Playwright project, which is asked only when `piwi/record` answers with the list of projects.

Nothing is written before the first `piwi/recordingChanged`. Each one then replaces the recorded block (the first one
at `RecordResult.placement`), with the service's import edit (`importEdit`) in the same edit. While it records:

- the block is tinted with `piwi.recordingBlockBackground`, with a CodeLens above it: the state, the step count, and
  Stop, Pause or Resume;
- the status bar shows the recording;
- the recording's warnings are diagnostics. Each stays after Stop until its line is edited in place (`editedLine`); an
  edit that adds or removes a line of the block removes them all.

### Locator quick fixes

Once the recording stopped, a warning on a step with other verified locators (`RecordingStep.locators`) offers each one
as a quick fix (a `CodeActionProvider` on the diagnostic, `locatorChoices` in `src/glue.ts`).
**Use getByTestId('pay')** puts it in place of the written locator, found on the line exactly once, as one workspace
edit. None is offered while it records, since the next update writes the block again.

### Edits, recording from a paused test, and Stop

The block follows the edits made around it. Typing inside it pauses the recording: **Resume** writes it again, **Keep
my edits** stops.

A test paused in a run started here can ask to record from there (`piwi/recordRequested`). Its file is shown at the
paused line and its recording starts at once, as one at the caret, with nothing asked (`recordFromTest`: `piwi/record`
with the `handoff`); the answer's sentence is shown. A recording that cannot start (the file is being recorded into,
cannot be opened, or the service failed) is declined at once with the reason (`piwi/declineRecord`). How the hand-off
works: [Recording from a paused test](../../packages/editor/ARCHITECTURE.md#recording-from-a-paused-test) in the editor
service's reference.

Closing the file or the window stops its recording. The notification after Stop says what was written
(`recordingSummary`: `Piwi: recorded 6 steps into checkout.spec.ts.`). When `piwi/testAt` finds a test holding the
block's last line, it offers **Run** and **Verify ×3** (`RECORDED_ACTIONS`), which run `piwi.runTestAtCursor` and
`piwi.verifyTestAtCursor` at that line, as the block stands when clicked. No CodeLens offers them: the recording's lens
goes away with Stop.

### Undo during a recording

A recording is one undo step. The block's writes go through the editor that shows the file: the first one opens an
undo stop and the later ones join it (`undoStopBefore: false`; the write Stop brings closes it), so one Undo after Stop
removes the block and its imports.

Three cases start another undo step: a save during the recording (auto save included), an edit of the file between
two writes, and a write while no editor shows the file (a workspace edit is an undo step of its own).

## Testing view

### Test items

`src/test-explorer.ts` lists Piwi's tests in VS Code's Testing view while `piwi.testExplorer` is on (the default). A
change of the setting creates or disposes it (`showTestExplorer`).

It is a `TestController` whose items come from `piwi/testItems`: the catalog's specs and the open ones. They are read
again in full when the connection or the runs change, and one spec alone 300 ms after its last edit or when it opens
(`withSpec`). What the service answers: [Test items](../../packages/editor/ARCHITECTURE.md#test-items) in the editor
service's reference.

`testTree` in `src/glue.ts` builds the tree: a node per Playwright config when there are several, then the spec's
folders, the spec, its describe blocks and its tests. Item ids are joined by `\x1f`, since VS Code refuses `\0` in an
id. An item is kept while its id stays, so its result stays too.

### Results and test runs

**The latest results** are published as one test run (`resultsRunName`, `testOutcome`: a failure's message and line
from `TestFailure`) whenever `resultsKey` changes. A read that made items anew publishes the results again. **A run in
progress** (`RunStatus.live`) is a test run of its own (`liveRunName`), showing `liveTests` as they come. It ends once
the run was read, and nothing is published again for it.

**The run profiles**, **Run with Piwi** and **Verify ×3 with Piwi**, run the picked tests through `runTests`
(`testRunsOf`: one run per config, by id when every test has one, else by location). The commands are queued in their
test run, which:

- follows the runs from its first command on (a command that ends while the next starts is kept in `endedEarly`);
- takes each command's run in progress by its ref (`LiveRun.ref`), or by its config when the service no longer keeps
  the command;
- ends once each command's task ended (`taskEnded`, from `tasks.onDidEndTaskProcess`, or at once for a task VS Code
  could not start) and its run was read.

A run that ended before it was followed is read from `piwi/runEnded` by its ref. 15 s after a task's end with neither,
a test no run gave a result for passes when every command exited with 0, and is an error otherwise
(`unfollowedOutcome`). **Cancel** terminates the commands' tasks and ends the test run; the tests it showed no result
for are skipped.

The spec URIs the service answers are spelled as VS Code spells a document's (`asEditorUris`). While the view lists the
tests, the gutter's own icons give way to the Testing view's, and a test's line keeps the hover (`testHover`). The API
`activate` returns gives what the view shows (`testExplorer`).

## Connect

**Piwi: Connect** (`connect` in `src/extension.ts`):

1. When the desktop app runs, it first lists the app beside the instance the workspace names (`connectChoices` in
   `src/glue.ts`).
2. Otherwise it asks for the instance's address, then asks the instance whether it needs a key.
3. A key comes from the browser sign-in (the device authorization Piwi Picker uses) or is pasted.
4. Then it asks for the project, and saves the address and the project in the workspace settings and the key in
   `SecretStorage`.

The requests to the instance (`needsKey`, `startSignIn`, `waitForSignIn`, `listProjects`) are in `src/connect.ts`, which
uses no VS Code API and is tested against a stub (`tests/connect.test.ts`). The order in which the service picks a
connection:
[Connection order and watching `HEAD`](../../packages/editor/ARCHITECTURE.md#connection-order-and-watching-head) in the
editor service's reference.

## The pure half

`src/glue.ts` is the pure half, tested without an editor (`tests/glue.test.ts`). It computes:

- the status bar item and the failures view's nodes;
- the MCP configuration to paste, and the file an open link names;
- the recorded block's text and writes, with the service's import edit, and how they follow a change (`writeBlock`,
  `followBlock`, `followEdit`), and the quick fixes of a recorded line's warning (`locatorChoices`);
- what runs the test at a line (`testAtRun`);
- the Testing view's tree and results (`testTree`, `testOutcome`, `testRunsOf`).

`src/connect.ts`, `src/breakpoints.ts`, `src/send-listener.ts` and `src/run-control.ts` use no VS Code API either, each
with its unit test.

## Keybindings

The default keybindings (`contributes.keybindings`) are the JetBrains plugin's chords for the same actions:

| Chord (`cmd` instead of `ctrl` on macOS) | Command                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ctrl+shift+alt+r`                       | `piwi.record` in a TypeScript or JavaScript editor, `piwi.stopRecording` while recording |
| `ctrl+shift+alt+f`                       | `piwi.rerunFailing`                                                                      |
| `ctrl+shift+alt+k`                       | `piwi.runTestAtCursor`, in a focused editor                                              |

**VS Code** binds `ctrl+shift+alt` (`cmd` on macOS) with these letters, checked in the `microsoft/vscode` sources
(1.145): `a`, `c`, `g`, `i` (Linux only), `l`, `n` (VS Code for the Web only) and `o`. It binds none of `r`, `f` and
`k`. `ctrl+alt+<key>` and the `ctrl+k` chords are taken too.

**The JetBrains IDEs** (`intellij-community` sources, October 2026):

- The platform's `$default` keymap, which every bundled keymap descends from, binds `ctrl+alt+shift` with `c`, `e`,
  `h`, `i`, `j`, `l`, `n`, `s`, `t`, `v` and `w`. Its bundled plugins add `d` (database grid), `p` (Java), `o`
  (Python), and `a`, `k`, `m` and `r` (Kotlin, in IntelliJ IDEA: `ctrl+alt+shift+K` converts a Java file to Kotlin,
  `ctrl+alt+shift+R` reloads a Kotlin script's configuration). A list made earlier in the IDEs, closed-source plugins
  included, also named `u`, `x` and `y`.
- The macOS keymaps turn `$default`'s `ctrl` into `cmd`, and **Mac OS X 10.5+** binds `cmd+alt+shift+R` to Force
  Refresh.
- Keymaps installed as plugins, and preinstalled in some IDEs such as Rider, take the chords too. Visual Studio binds
  `R` and `K`, and ReSharper, which descends from it, adds `F`. On macOS, Visual Studio OSX binds `cmd+alt+shift` with
  `R` and `K`, ReSharper OSX and Visual Studio for Mac with `F`, and Xcode with `R`, `F` and `K`.

So the Piwi chords are free in VS Code and in the platform's own `$default` keymap, but meet the bindings above in
IntelliJ IDEA with Kotlin, on macOS and in those keymaps. Check a new chord against these lists.

**A run's controls** ([Run control](#run-control)) take the debugger's keys instead, only while they apply and no debug
session runs (`!inDebugMode`):

| Key                             | Command                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `shift+f5`                      | `piwi.stopRun`                                                                                                             |
| `f5`                            | `piwi.resumeRun`, which does nothing for two seconds after an answer (`piwi.runResumed`) rather than start a debug session |
| `f10`                           | `piwi.stepRun`                                                                                                             |
| `shift+f11`                     | `piwi.finishRun`                                                                                                           |
| `ctrl+f10` (`cmd+f10` on macOS) | `piwi.runToCursor`, in a focused editor                                                                                    |

**Pause** has no default key: it applies for as long as a test runs, and a key bound that long takes one from the
workbench (`f6` moves the focus between parts).

## Changelog

The Marketplace's Changelog tab shows the package's `CHANGELOG.md`. `reusable-publish-vscode.yml` writes it before
`vsce package`, from the `ide` entries of the root `CHANGELOG.md`, under their version and section
(`node scripts/ide-changelog.mjs --format md --all > apps/vscode/CHANGELOG.md` from the repository root). A commit with
the `ide` scope is what puts a line in it. The file is gitignored, and `.vscodeignore` lets it into the VSIX.

## Screenshots

`scripts/take-screenshots.mjs` writes the extension's illustrations, `apps/docs/public/screenshots/vscode-*.png`, shown
by the docs, the README and the Marketplace README. It:

- opens the fixture project of `scripts/lib/editor-fixture.mjs` (a small shop's suite with one brittle locator, two CI
  failures and a local run since) against the stub instance the same module serves;
- runs the VS Code that `scripts/lib/vscode-window.mjs` downloads, at the release `VSCODE_VERSION` pins (moved on
  purpose, since the workbench's DOM changes between releases);
- drives the window with Playwright's Electron support.

On Linux, run it under Xvfb at twice the window size for 2× images:
`xvfb-run -a -s "-screen 0 2880x1800x24" node scripts/take-screenshots.mjs`. A scene is a function of `SCENES`. A scene
that fails leaves `vscode-<scene>-failed.png`, the window as it stood, in the temporary directory.

The `run-control` scenes share one run of the coupon test, started with **Run the test at the cursor**. Its task's
`npx playwright` finds the stand-in command `scripts/lib/run-worker.mjs` writes into the fixture, which hands the
script the run channel, and the script plays the run's worker there, as the integration suite does: its reporter takes
every code action (`RUN_TAKES`), answers a count at the cursor with one match and lists three kept responses, which
`run-control-code` shows in Mock a request's list. The paused page is the fixture shop's page, rendered by Playwright's
Chromium. The window keeps its secrets in a file (`--password-store=basic`): without an OS keyring, `SecretStorage`
never answers and no run starts.

The JetBrains plugin's script reuses the fixture, so a change to the fixture means recapturing both sets. What was found
about driving VS Code this way is recorded in
[`proposals/real-editor-checks.md`](../../proposals/real-editor-checks.md).

## Nightly suite

The nightly suite (`tests/e2e/`, `npm run vscode:test:e2e`) opens the same fixture in the same window. It asserts on
the workbench's DOM what the in-process suites check as answers: the status bar's counts, the Problems panel's rows,
the quick fixes, the hover, CodeLens, the failures view and the Testing view.

`.github/workflows/nightly-vscode.yml` runs it every night and on demand, not on pull requests. A failure leaves the
HTML report, with a screenshot of the window.

- Find elements by ARIA role and name where the workbench gives one
  (`getByRole('tree', { name: 'Test Explorer' })`), and by a class name only where it does not.
- A step that opens a menu or a hover clears the notification toasts first (`clearNotifications`).

## Integration suite

The integration suite (`tests/integration/`) starts a stub instance, writes a fixture repository, and drives VS Code
(downloaded by `@vscode/test-electron`). CI runs it on pull requests that change the extension
(`reusable-e2e-vscode.yml`, from `ci.yml`). It drives VS Code in two ways:

- through its public commands (`vscode.executeCodeActionProvider`, `vscode.executeCodeLensProvider`, …);
- through the API `activate` returns:
  - `pageCandidates`: the service's answer for a position;
  - `failureChildren`: the failures view's nodes;
  - `lastRun`: the command a breakpoint's run was given;
  - `gutter`: the tests last drawn in a file's gutter;
  - `coverage`: a file's coverage answer, and whether its marks are shown;
  - `testExplorer`: the Testing view's tests, with the result last shown for each;
  - `runSessions`, `executionPoints`, `pausedPage` and `caretCount`: a run's stops, as a fake worker on the run
    channel plays them, and the code written there, a check's included, whose hand-off it plays too.
