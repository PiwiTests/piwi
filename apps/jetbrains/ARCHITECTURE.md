# JetBrains plugin architecture

How the JetBrains plugin in `apps/jetbrains/` works: the build, how it starts the editor service, what it draws from
each answer, its tool window, status bar, runs and recording, and what the platform requires. The rules are in
[`AGENTS.md`](AGENTS.md). What the service answers, and why, is in
[`packages/editor/ARCHITECTURE.md`](../../packages/editor/ARCHITECTURE.md): this file describes only what the plugin
does with it. It is reference material: open the section for the area you change.

## Contents

- [Build](#build)
- [Starting the service](#starting-the-service)
  - [Proxy](#proxy)
  - [Restarts](#restarts)
  - [Untrusted projects](#untrusted-projects)
- [LSP integration](#lsp-integration)
- [Test results in the editor](#test-results-in-the-editor)
- [Coverage marks](#coverage-marks)
- [Native views and pushes](#native-views-and-pushes)
- [Tool window](#tool-window)
  - [Tree and nodes](#tree-and-nodes)
  - [Navigation and actions](#navigation-and-actions)
  - [Compare with](#compare-with)
- [Status bar](#status-bar)
- [Runs](#runs)
  - [Playwright runner](#playwright-runner)
  - [Commands and notifications](#commands-and-notifications)
  - [Running the test at the caret](#running-the-test-at-the-caret)
  - [How a run starts](#how-a-run-starts)
  - [Breakpoints](#breakpoints)
  - [Run control](#run-control)
  - [Code from a stop](#code-from-a-stop)
  - [CI runs of the branch](#ci-runs-of-the-branch)
- [Finding Playwright configs](#finding-playwright-configs)
  - [First-run notification](#first-run-notification)
- [Recording](#recording)
  - [Starting a recording](#starting-a-recording)
  - [Writing the recorded block](#writing-the-recorded-block)
  - [Warnings, quick fixes and the banner](#warnings-quick-fixes-and-the-banner)
  - [Pause, Stop and undo](#pause-stop-and-undo)
- [Send to editor](#send-to-editor)
- [Open in IDE](#open-in-ide)
- [Connect](#connect)
- [Settings and secrets](#settings-and-secrets)
- [MCP server configuration](#mcp-server-configuration)
- [Platform compatibility](#platform-compatibility)
- [Threading](#threading)
- [Dynamic plugin loading](#dynamic-plugin-loading)
- [Change notes](#change-notes)
- [Screenshots](#screenshots)
- [The JDK](#the-jdk)
- [Tests](#tests)

## Build

The plugin is a Gradle project in Kotlin, built with the IntelliJ Platform Gradle Plugin. Like `apps/desktop`, it is
not an npm workspace.

The build copies the editor service from `packages/editor/dist/` (`npm run editor:build`) into the plugin's `server/`
directory: `piwi-language-server.cjs`, and beside it `piwi-recorder-launcher.cjs`, `piwi-use-reporter.cjs`,
`record-ide.js` and `record-ide-messages.json`. What each file is:
[Build output](../../packages/editor/ARCHITECTURE.md#build-output) in the editor service's reference.

`buildPlugin`, `runIde` and `verifyPlugin` fail when one of these files is missing (`prepareSandbox` in
`build.gradle.kts`). The tests start the language server from `dist/` (the `piwi.editor.server` system property) and
need none of the others.

**Settings search.** The release's `buildPlugin` builds the searchable options index (`searchableOptions=true`, set for
every Gradle run of `reusable-publish-jetbrains.yml`, `buildSearchableOptions` in `build.gradle.kts`): it runs the IDE
headless and lists the words of every label of **Settings → Tools → Piwi** and of every action, so Settings search and
Find Action find them. The checks skip it, for the time it takes. `PiwiSearchableOptions` (`search.optionContributor`)
adds the words the labels lack, such as Playwright, dashboard and token, in every build; `PiwiPluginTest` reads them.

## Starting the service

The plugin starts the service through the platform's LSP API (`PiwiLspServerDescriptor`), with the project's Node.js
interpreter and `--stdio --clientProcessId=<the IDE's process id>`. The platform passes no process id of its own, and
with this one the service exits within seconds of the IDE's end, however the IDE ends.

**Node.js 20 or later.** The service starts only once `node --version` says 20 or later (`Glue.nodeProblem`).
Otherwise:

- the start fails with that reason, which `PiwiProjectService.startFailed` keeps (`startProblem`) and says once;
- the status bar item reads `Piwi: Node.js`, and its menu opens the Node.js settings first (`openNodeSettings`,
  `settings.nodejs`), after which the service starts again (`restartServer`), as it does on **Reload Piwi** while it
  does not run.

**The first file.** The service starts with the first supported file opened, since 2024.1 has no way to start it
without one. Until then the status is null, and the status bar and the tool window say so.

### Proxy

The service's process gets the IDE's HTTP proxy for the instance the project names
(`PiwiLspServerDescriptor.proxyEnvironment`). The plugin asks the default `ProxySelector`, which holds the IDE's proxy
settings, for that address, or for a public address while no instance is saved. The answer becomes `HTTPS_PROXY` and
`HTTP_PROXY`, with this machine's names in `NO_PROXY` (`Glue.proxyEnvironment`): the variables the service's
`src/http.ts` reads. With no proxy for the instance, nothing is set.

### Restarts

The platform stops a service whose start failed. One way that happens: the platform sends the open files on a pooled
thread, and a tab opened or closed meanwhile throws a `ConcurrentModificationException` there.

So a service whose process ends within 30 s of its start is started again two seconds later
(`PiwiLspServerDescriptor.startServerProcess` hands the process to `PiwiProjectService.watchServer`;
`Glue.restartsService`), at most three times in five minutes. It is not started again when another one starts or runs,
or when Node.js is the problem.

### Untrusted projects

In a project opened in safe mode (`PiwiProjectService.trusted`, the platform's `isTrusted`), the plugin starts no
editor service, runs no command (`PiwiCommands.run`, `startRun`) and reads no `.env` for Open in IDE: each of them would
run or believe what the repository holds. The status bar item reads `Piwi: waiting for trust`, with a warning
icon, and its tooltip, the Piwi tool window and the settings page say why (`Glue.WAITING_FOR_TRUST`), and a supported
file opened meanwhile says it once in a balloon (`Glue.UNTRUSTED`). Trusting the project starts Piwi:
`PiwiProjectService.watchTrust` hears it on `TrustedProjectsListener.TOPIC` (experimental, not internal, in 2024.1),
tells the views, starts the service for the open files and offers the first-run notification it held back.

## LSP integration

`PiwiLspServerSupportProvider.kt` registers the service.

- **What the platform draws.** The platform's LSP client renders the service's diagnostics, quick fixes and hover in
  open files.
- **Client commands.** `LspCommandsSupport` runs the client commands the service names, through `PiwiCommands.kt`.
  `piwi.desktopJob` (from a quick fix or a flaky test's Code Vision line) and the job's updates
  (`piwi/desktopJobChanged`, shown with a button that shares the verdict) are there too.
- **The plugin's own requests.** They go through the service's lsp4j proxy, which the platform hands only to a
  request's sender: `Lsp4jAccess` takes it from a `sendRequestSync` that sends nothing, never from `getLsp4jServer()`
  (deprecated, then removed by 2026.2). Every status, Code Vision, gutter and tool-window answer depends on it.
- **Notifications.** `PiwiLsp4jClient` receives the service's own notifications (`piwi/statusChanged`,
  `piwi/runStatusChanged`, `piwi/failuresChanged`, `piwi/coverageChanged`, `piwi/recordingChanged`,
  `piwi/recordRequested`, `piwi/runEnded`, `piwi/notice`, `piwi/desktopJobChanged`, `piwi/runSessionChanged`).
- **The Language Services widget.** `createLspServerWidgetItem` gives the service's entry Piwi's icon and the gear that
  opens the settings.

## Test results in the editor

`PiwiTestAnnotator.kt` is an external annotator on JavaScript, so on its TypeScript dialects too. It draws each test's
latest result from `piwi/fileSummary`:

- a gutter icon, with the summary the service writes as its tooltip (`Glue.testResultTooltip`); its click runs what the
  line names (Open in dashboard), and its right-click menu holds **Run with Piwi** and **Verify ×3 with Piwi**, the
  registered `Piwi.RunTestAtCursor` and `Piwi.VerifyTestAtCursor` acting on the test's line (`TEST_LINE`) rather than
  the caret's, at the line a range marker follows through edits;
- the `PIWI_FAILING_TEST` background over a failing test;
- `PIWI_FAILING_LINE` on the line it failed at, with no tooltip of its own: the service's diagnostic and hover say
  why. The test's background goes around that line, since two backgrounds on one line have no set order.

The colors are on **Piwi**'s color settings page (`PiwiColorSettingsPage.kt`), with defaults in
`resources/colorSchemes/`. A test the run in progress runs has the `AllIcons.RunConfigurations.TestState.Run` icon,
then that run's result. Code Vision (`PiwiCodeVisionProvider.kt`) draws the summary's other lines and skips the test
lines. The platform keeps one entry per provider and line (`EditorCodeVisionContext`), so each entry of a line has its
provider: `PiwiCodeVisionProvider` the first, `PiwiCodeVisionSlot2` to `PiwiCodeVisionSlot8` the next ones, each after
the one before (`Glue.codeVisionSlot`, `Glue.CODE_VISION_SLOTS`). They share the group `piwi.summary`, which
`PiwiCodeVisionSettings` names Piwi in the Code Vision settings. The IDE shows as many entries per line as those
settings say (five by default, `visibleMetricsAboveDeclarationCount`); a line's entries past the eighth are not drawn.

**One summary per file and text.** The annotator and Code Vision share one `piwi/fileSummary` per file and state of its
text (`PiwiProjectService.fileSummary`, `Glue.SummaryCache`). It is asked again after a push from the service, or after
five seconds.

**Drawing open files again.** The open files are drawn again with `DaemonCodeAnalyzer.restart(PsiFile)`, never the
whole daemon, as `Glue.redraw` says:

- the run as the files show it changed (`Glue.runsInFiles`): every file Piwi reads;
- only the run's `liveTests` moved: only the files whose tests show a result (`showsTests`), at most once a second;
- only the run in progress moved: none.

## Coverage marks

`PiwiCoverageMarks.kt` draws `piwi/coverage` on each open file the service reads (C# among them, for Rider). It asks
when the file opens, and again after each `piwi/statusChanged`. What the service computes:
[Coverage marks](../../packages/editor/ARCHITECTURE.md#coverage-marks) in the editor service's reference.

**How a mark is drawn.** Each span of `Glue.coverageMarks` is a range highlighter on the document's markup model
(`DocumentMarkupModel`), with a `LineMarkerRendererEx` that paints a bar at the left of the gutter, in the error stripe
color of its key:

| Lines                                                                         | Key                             |
| ----------------------------------------------------------------------------- | ------------------------------- |
| Lines tests ran                                                               | `PIWI_COVERAGE_RUN`             |
| Executable lines no test runs                                                 | `PIWI_COVERAGE_NOT_RUN`         |
| Lines changed since the coverage run                                          | `PIWI_COVERAGE_CHANGED`, dashed |
| In a file no test reaches, its uncovered changes (`CoverageResult.uncovered`) | `PIWI_UNCOVERED_CHANGE`         |

The keys are in the **Coverage** group of `PiwiColorSettingsPage.kt`, with no background by default; each but the
lines run also marks the scroll bar (the run marks' highlighter takes `setErrorStripeMarkColor(null)`), so a covered
file's scroll bar keeps its own marks, and a background set on any key tints its lines. The uncovered changes are `Glue.CoverageKind.UNCOVERED`, and their tooltip ends on
`Glue.UNCOVERED_EXPLAINED`. The four defaults are VS Code's and, for the run and not-run marks, the dashboard's
(`COVERAGE_MARK_COLORS` in `@piwitests/core/coverage`, checked by
`apps/application/tests/unit/coverage-mark-colors.test.ts`).

**Tooltips.** The bar is also an `ActiveGutterRenderer`. Hovered, the bar and the scroll bar mark show
`Glue.coverageMarkTooltip`: what the lines are and what the marks mean. Clicked, the bar shows the same as a hint. The
service's hover names the tests behind a line; the lines on a function come in `piwi/fileSummary`, through Code Vision.

**Updates.**

- The highlighters follow the edits.
- `piwi/coverageChanged` replaces a file's answer, draws it again, and has the file's Code Vision asked again
  (`PiwiProjectService.coverageChanged`).
- A drawing takes off and adds only the marks that changed (`Glue.coverageMarksDiff`): a highlighter stays while the
  answer holds its mark (kind, lines, tooltip) at the lines it covers now.
- A file renamed or moved, itself or with its folder (`VFS_CHANGES`), loses its marks and is asked again under its new
  URI. A deleted file is forgotten.

**Show coverage marks** (`Piwi.ToggleCoverageMarks`, a `ToggleAction` under **Tools → Piwi**, kept in
`PiwiLocalSettings.coverageMarks`, on by default) is hidden, not only disabled, until a file showed marks. A file
without line coverage draws nothing.

## Native views and pushes

Besides what the LSP client draws, every view is native, and all stay available while the IDE indexes (`DumbAware`):

- Code Vision, from `piwi/fileSummary`;
- the status bar, from `piwi/runStatus`, with the run in progress (`live`);
- the **Piwi** tool window, from `piwi/failures` (the LSP client highlights open files only), with one header line
  (`Glue.toolWindowHeader`): the connection from `piwi/status`, a link to the settings with `Glue.connectionSummary` in
  its tooltip (`3 Playwright configs` with several), and the baseline, a link to Compare with…; the run is the tree's
  own node;
- the actions under **Tools → Piwi**.

The service pushes each of the three answers when it changes (`piwi/statusChanged`, `piwi/runStatusChanged`,
`piwi/failuresChanged`). `PiwiProjectService` keeps a pushed answer as it comes, and tells its listeners once, on the
event thread, for all the pushes received meanwhile.

It reads the three answers whole (`refreshStatus`) only when the plugin starts (the tool window and the status bar item
are created), on **Reload Piwi**, on **Refresh the latest run** (`Piwi.RefreshRun`), and after new credentials. One read
runs at a time, and a read asked for meanwhile follows it. A push that arrives during a read wins over the answer read.

## Tool window

### Tree and nodes

The tool window (`PiwiFailuresToolWindow.kt`) is a `Tree` on a `DefaultTreeModel` of `Glue.failureNodes`: the tree the
service grouped (`FailuresResult.tree`), with each run's age. Its nodes are the ones VS Code's view has: the run,
**Your runs since**, then the failures grouped by file, cluster, owner or flat. How the service builds the tree:
[The failures answer](../../packages/editor/ARCHITECTURE.md#the-failures-answer) in the editor service's reference.
With no failure, the empty text is `Glue.failuresEmpty` of the state the service says (`FailuresResult.view`), with
links to the state's actions (`Glue.EmptyLink`: Connect…, Retry, Settings…, Compare with…).

- **The toolbar** holds, in VS Code's order, **Refresh the latest run**, **Re-run the failing tests**, **Open in
  dashboard**, **Compare with…** and the **Group by** drop-down, then the navigation (previous and next failure, expand
  and collapse all). The gear menu (`setAdditionalGearActions`) holds Connect… and Disconnect, Pair with Piwi Picker
  and the MCP configurations, Reload Piwi, Restart the editor service, Open log, Settings… and Documentation.
- **The tab** is Failures. The stripe title counts the failing tests (`Piwi (2)`), and the tool window's icon is
  `piwi_failing.svg`, the mark with a red dot, while tests fail: the new UI's stripe button shows the icon alone. Both
  are set from the factory's `init`, so the stripe button says so before the tool window is first opened.
- **Each node's tooltip** is the service's (`FailureTreeNode.tooltip`, kept in `Glue.FailureNode.tooltip`), one line
  each through `Glue.htmlTooltip`: a failure's title, headline, run, cluster and owner, a run's counts.
- **The grouping** is chosen in the **Group by** drop-down, of `ToggleAction`s, and kept in `PiwiLocalSettings.failuresGrouping`. It is
  sent with every `piwi/failures`, and read again at once by `PiwiProjectService.regroup`; the service keeps it for
  what it pushes.
- **Several configs.** When several Playwright configs have something to show, each has a node (`AllIcons.Nodes.Module`)
  above its tree, and the header line counts them.
- **The editor's own run in progress** shows on the run of its config (`liveRoot`), `running 4/9 · 1 failed`, counted
  as its own process tells the hub (`Glue.ownRunInProgress`, `RunSession.progress`, the instance's run matched to its
  session by ref alone), else as the instance does (`LiveRun`); the tree is drawn again as the run's sessions change.
- **A row.** A `ColoredTreeCellRenderer` draws a failure's title, run and place; its headline is in the hover, the
  service's tooltip, as in the VS Code extension. The run is `Glue.FailureNode.note`, which the service writes with
  `failureRunNote` in `packages/editor/src/failure-tree.ts`: `your run #N`, `edited since run #N` with the information
  icon, `fixed` with the passed icon. `TreeSpeedSearch` finds a title.
- **Updates.** The tree is built again only when its nodes changed, for instance when `piwi/failuresChanged` reports
  that edits moved them. It keeps the expanded and selected nodes by key. When only what the nodes say changed
  (`Glue.sameShape`, such as the editor's own run counting its tests), each row is redrawn in place.
- **The stripe title** reads `Piwi (n)` while `n` tests fail.

### Navigation and actions

The panel is an `OccurenceNavigator`: Next and Previous Occurrence, and the toolbar's arrows, go from failure to
failure, beside Expand All and Collapse All. Double-click or Enter opens a failure's line, or a run's page. The panel
gives the selected node's page as `DASHBOARD_URL`, which Open in dashboard opens before the file's test or the latest
run. Open in dashboard and Run selection… are enabled only while a context is connected (`piwiConnected`), Open in
dashboard also on a selected page, and Re-run the failing tests while failures are listed; `PiwiPluginTest` holds both.

The right-click menu (`PopupHandler.installPopupMenu`) acts through `PiwiCommands`, a failure's entries as the
registered `Piwi.Failure.*` actions (`FailureNodeAction`, the `Piwi.FailureActions` group), which read the selected node
(`FAILURE_NODE`) so their keys show and Find Action reaches them:

- on a failure: run the test, open the trace, the screenshot or the page, copy the context for an agent
  (`piwi/agentContext`), and, on a CI failure while the desktop app runs, pass it to the app;
- on a config's node: re-run that config's failing tests, choose its baseline and open its run (`ConfigAction`,
  `Glue.FailureNode.root`);
- on a run's node: choose its baseline and open its run.

**Icons.** Every action of `plugin.xml` draws its concept's glyph from the concept table of
[editor-ux-coherence.md](../../proposals/editor-ux-coherence.md#appendix-a-the-concept-table-first-draft): a platform
icon that has a New UI glyph on 2024.1 and 2026.3 (checked by hand against each `PlatformIconMappings.json`), or, where
no mapped platform icon says the concept, one Piwi draws in `src/main/resources/icons/` (16 px, 1 px strokes in the New
UI's `#6C707E`, with a `_dark` copy in `#CED0D6`): Connect, Disconnect, Pair, Pause and watch, Assert a region, Mock a
request, Share live and Stop sharing, Run the tests that reach this file, Reset the runs' MCP server token, Show the
stopped test's browser, Share with Playwright tools and a CI run. The exceptions are the two toggles, whose menu rows
show a check mark. The icons drawn in code come from `PiwiIcons`: the flaky and running marks (Piwi's, on the outcome
palette, held to `STATUS_COLORS` by `status-mark-colors.test.ts`) on the result icon and the CI run tab, the failed mark
(`TestError`) on the result icon, the status item, the tree and a held failure, Connect and Share live on the status
item, Open in dashboard's external link, a CI run's cloud, the hand-offs of this menu (an archive, an image, a desktop,
a branch) and the stop's code actions in its popups. `PiwiPluginTest` checks that every action but the toggles has one,
that each of Piwi's resolves to a file, and lists the actions that share a glyph.

**Re-run the failing tests** (`Piwi.RerunFailing`, under **Tools → Piwi** and in the toolbar) runs
`FailuresResult.rerun`, one run per Playwright config (`PiwiCommands.rerunFailing`), or one config's alone from its node
(`Glue.failingRuns`). **Run this test** runs `Glue.failureRunArgs`. Both name the failure's config
(`WorkspaceFailure.root`).

### Compare with

**Compare with…** (`Piwi.CompareWith`, under **Tools → Piwi** and in the toolbar) is a popup of
`Glue.baselineEntries`, for the context of the file at hand or of the node it runs from (`CompareWithAction.choose`).
The entries are:

- the default ladder;
- each branch of `RunStatus.branches`;
- a run by its id, typed in `Messages.showInputDialog` and read by `piwi/runId` on a pooled thread; a balloon says when
  the text is not a run id;
- the local runs only.

`PiwiProjectService.setBaseline` keeps the choice in `PiwiLocalSettings.baselines` (by config folder,
`Glue.encodeBaseline`, the ladder as no entry) and sends `piwi/setBaseline`; `credentials()` sends them all as
`baselines`. The header line names the baseline, a link to Compare with… (`Glue.toolWindowHeader`). What the ladder is:
[Latest run and baseline](../../packages/editor/ARCHITECTURE.md#latest-run-and-baseline) in the editor service's
reference.

## Status bar

The status bar item (`PiwiStatusBar.kt`, `Glue.statusView`) is a `CustomStatusBarWidget` around a `JBLabel`, since the
platform's text presentations take no color. It shows:

- an icon (`Glue.StatusIcon`): the plugin's, Connect's plug (`PiwiIcons.CONNECT`), an `AllIcons` icon for the
  instance unreachable and for a failing or passed run, Share live's broadcast while a run is shared,
  `AnimatedIcon.Default` for a run in progress or a read;
- the text, in the theme's error foreground (`NamedColorUtil.getErrorForeground`) while tests of the run it counts fail,
  a run in progress by its own failures (`StatusView.error`, or `Glue.runsFailing` while it counts the hub's
  progress), and in the status bar's foreground
  (`JBUI.CurrentTheme.StatusBar.Widget.FOREGROUND`) otherwise.

**Which config.** It speaks for the context of the selected editor's file (`Glue.statusContext`: the deepest config
folder holding it, else the first connected one; `PiwiStatusBarWidget.shownFile`), and is drawn again on
`FileEditorManagerListener.selectionChanged`. With several contexts, the tooltip names that config
(`ContextStatus.label`, else its folder's name), and another context's run is never shown for it.

**A click** opens `PiwiStatusBarWidget.actions()` (`createActionGroupPopup`, with the selected editor's data context;
the disabled actions are left out). First comes what the state calls for (`Glue.StatusAction`):

- connected: **Refresh the latest run** (`Piwi.RefreshRun`, `PiwiProjectService.refreshRun`: `piwi/refreshRun`, then
  `refreshStatus`, on a pooled thread; the item reads `Piwi: refreshing…` meanwhile);
- the instance does not answer (`Piwi: unreachable`, `problemKind`): **Reload Piwi**;
- the desktop app did not prove its token (`Piwi: restart the desktop app`, `desktop-unproven`): **Reload Piwi**; the
  service also reads it again as the restarted app rewrites its discovery file;
- not connected: **Connect**;
- the service cannot start: the Node.js settings;
- the service that ran stopped (`Piwi: not running`, `PiwiProjectService.serviceStopped`): **Restart the editor
  service**, then **Open log**; the tool window's header and the settings page say `Glue.NOT_RUNNING`;
- the service has not started yet: **Settings**;
- while a recording runs: going to its block, and its controls;
- while a run is live: each stop, as the choice among several names it, which goes to its line, then the run's controls
  ([Run control](#run-control)). The item reads `Piwi: stopped at a breakpoint · checkout.page.ts:12` (`Glue.stopWhy`)
  while a test is stopped (`Glue.runControlStatus`), and `Piwi: 3 of 9 · 1 failed` while the run goes on, from the
  progress its own process tells the service (`Glue.runProgressText`, `RunSession.progress`), with no instance and with
  the desktop app as the instance too, an agent's run ending with its label (`RunSession.label`), as its Run tab
  does (`Glue.labeledRunName`). Its tooltip says what each worker runs now (`Glue.workersNowText`: `Worker 2 ·
  cart › adds a mug · stopped`);
- while a run is shared live: the share's entries, the run page, its link and **Stop sharing…**, which asks first
  ([Run control](#run-control)).

A live run's section lists the `Piwi.RunControl` group, as **Tools → Piwi** does, in its order (`RUN_ACTIONS`, held to
the group by `PiwiPluginTest`): the controls, the page and the trace so far (`Piwi.OpenTraceSoFar`), the code actions,
sharing, then Stop. Every row that a registered action does is that action, the stops as `Piwi.ShowStop` and the run
pages as `Piwi.OpenRunPage`, each wrapped to act on its stop or page (`registeredWith`). Then come the registered
actions, by id: Re-run the failing tests, Open the failures (the tool window), Show the run's flaky tests
(`Piwi.ShowFlakyTests`, enabled while the tool window lists flaky tests for the item's config, `Glue.flakyTestsListed`;
it selects and opens that config's group, found in the tree's model, not its rows), Open the latest run in the dashboard
(unless a row above opens its page: one entry per page), Compare with…, Run the test at the caret, Record here, Reload
Piwi, Connect (in this popup only while a config is not connected) and Settings. The popup is titled Piwi.

**The tooltip** says the same as VS Code's, in plain text: the counts, the local runs, the run in progress and when the
run was read (`Glue.relativeTime`), the baseline (`Glue.baselineLine`), and the reporter version the project installs.

**Open the latest run in the dashboard** (`Piwi.OpenLatestRun`, under **Tools → Piwi** and in the status bar's popup)
opens the run the status bar shows.

## Runs

### Playwright runner

The **Run the tests in the IDE's Playwright runner** setting (`PiwiLocalSettings.playwrightRunner`) is off by default.
When it is on, a test run whose command is `npx playwright test …` (`Glue.playwrightTestArgs`) starts as a temporary
Playwright run configuration instead of a console (`PiwiPlaywrightRunner.kt`):

- its arguments go in `cliOptions`, with the command's environment and the config's folder;
- the IDE gives it the test tree, Debug and Rerun Failed Tests;
- each run of the configuration is followed (`PiwiRunSessions.followRunner`, `ExecutionManager.EXECUTION_TOPIC`), its
  Rerun, Rerun Failed Tests (a `WrappingRunConfiguration` of it) and Debug included: Stop ends its process, and its end
  is sent as `piwi/commandEnded`.

The IDE adds its own reporter with `PW_TEST_REPORTER`, which Playwright runs beside the config's, so the Piwi reporter
still reports. That variable is also how the reporter of a run Piwi did not start (the gutter's Run) knows an editor's
test runner started it, and follows the IDE ([Run control](#run-control)).

The runner's classes belong to the `JavaScript` plugin (`intellij.aqua.runners.playwright.js`, the same signatures in
2024.1 and 2026.x), which WebStorm, IntelliJ IDEA Ultimate and Rider bundle, among others. The plugin reaches them only once
`PlaywrightRunnerGate.available()`, which names none of them. Any other command, an IDE without the runner, or a run the
runner does not take, runs in the console; without the runner, the settings page's option is off and says why
(`Glue.NO_PLAYWRIGHT_RUNNER`).

### Commands and notifications

`PiwiCommands.run` runs a command in the Run tool window, its tab named after what it runs (`Glue.runTabName`: the
first test file and how many more, else the command up to its first option, `Piwi: piwi flake verify 12`). A command the service follows
(`piwi.runCommand` with `RunCommandArgs.follow`: a Flake Lab line, a fix plan's verification) is asked of
`piwi/followCommand`, the documents saved first, and started as a test run (`startRun`), or run as it is when the
service answers none. A chain (`a && b`, a fix plan's verification of several projects, `Glue.chained`) is the shell's
to run (`cmd.exe /c`, `/bin/sh -c`), never the IDE's Playwright runner's. The tab:

- its **Rerun** (`RunContentExecutor.withRerun`) stops the command if it runs, and starts it again with the same
  environment once its process ended and the service heard it (`piwi/commandEnded`), so the rerun's workers start a
  session of their own;
- `RunOutputLinks` (`Glue.fileLinks`) links the script paths the output names relative to the command's folder to their
  line; the IDE's console links the absolute ones;
- for a test run (`RunCommand.ref`), a `ProcessListener` sends `piwi/commandEnded` with the exit code when the process
  ends. A rerun keeps the ref, by which the service recognizes it as the editor's own run in the instance's event stream
  ([The editor's own run](../../packages/editor/ARCHITECTURE.md#the-editors-own-run) in the editor service's reference).

**Notifications.** Every balloon is made by `PiwiNotifier`: titled Piwi, with Piwi's icon, in the group of its kind
(`PiwiNotice`), each its own row in **Settings → Appearance & Behavior → Notifications**: `Piwi` for results (a run's
verdict, a job, a recording), `Piwi requests` for what waits for an answer (Debug in my editor, a run shared live, a
shared browser), sticky, `Piwi suggestions` for an offer made once (the MCP server, the desktop app, the first run), as
a suggestion, `Piwi problems` for what went wrong, and `Piwi confirmations` for what the person just did (Copied.,
Connected to …, the MCP configurations copied, `PiwiNotifier.confirm`). `PiwiCommands.notify` shows a warning or an
error as a problem, anything else, a refusal of the service included, as a result; a message that the service does not
run or did not answer is always a warning. An information carries Piwi's icon; a warning or an error keeps the
platform's, which says how serious it is. D25 lists the five group ids, which users' notification settings name. A
`piwi/notice` is shown through `PiwiCommands.notify`. So is `piwi/runEnded` (`PiwiCommands.runEnded`,
`Glue.runVerdict`), with **Open the failures**, **Open in dashboard**, and **Re-run failing** when something fails, or
**Only on failure** when nothing does while the setting is `always`. The run's balloon follows
`PiwiLocalSettings.runNotifications` (**Settings → Tools → Piwi**: `always`, `failures`, the default, `never`; in
`.idea/workspace.xml`, on this machine only). A run with `repeat` (**Verify ×3**) is reported whatever the setting, as
`Run #124 · Failed 1 of 3`, a warning when one of the runs failed. The balloon is titled by its run, `Piwi: run #124`
(`Glue.runVerdictTitle`), the verdict's words under it.

**Diagnostic severity.** The severity of a failure's diagnostic is `PiwiLocalSettings.failureSeverity`
(`Glue.FAILURE_SEVERITIES`, in the Runs group of the same page), sent in `credentials()`. The LSP client shows an
information as a weak warning.

### Running the test at the caret

Three actions, under **Tools → Piwi** and in the **Piwi** submenu of the editor's menu on a spec (`Glue.isSpecFile`)
in a project with a Playwright config (`RunInSpecAction`). The submenu, `Piwi.EditorPopup` (`PiwiEditorPopupGroup`),
holds the VS Code extension's sections in its order (run, record, a recording's controls), and it and **Tools → Piwi**
(`Piwi.Actions`, `compact`) leave out what does not apply; `PiwiPluginTest` holds both:

- **Run the test at the caret** (`Piwi.RunTestAtCursor`, `Ctrl+Alt+Shift+K`);
- **Verify the test at the caret ×3** (`Piwi.VerifyTestAtCursor`);
- **Run this spec** (`Piwi.RunSpec`).

Each asks `piwi/testAt` for the caret on a pooled thread, and saves the spec's document on the event thread when it
has unsaved changes. Then it runs as `PiwiCommands.runTests` does (`PiwiCommands.runTestAt`): the test by its id when
Piwi knows it, else by its location (`Glue.testAtRun`); to verify, by its location, three times (`Glue.VERIFY_REPEAT`).
When there is no test, a balloon says so. The gutter icon's click stays Open in dashboard; its right-click menu runs
and verifies the test the same way.

### How a run starts

Every test run takes the person's start options (`Glue.withRunStart`, `RunStartOptions` in the protocol), kept in
`PiwiLocalSettings.runHeaded` and `runHoldFailures` (`Glue.HOLD_FAILURES_CHOICES`): `headed = true` when **Run headed**
is on, nothing otherwise (the service runs it headless but for a spec with a `page.pause()`, and for a run with
breakpoints while the project's reporter is older than 0.62.0 or of a version unknown, or the run has no run channel),
`holdFailures` when Hold failures is On or Off (Auto sends nothing, so the service decides). That covers
`PiwiCommands.runTests`, a verification included, and **Run selection…**; a debug run (`RunTestsArgs.debug`) is sent as
built. **Tools → Piwi → Run headed** (`Piwi.RunHeaded`, a `ToggleAction`), **Hold failures from each run's start…**
(`Piwi.RunHoldFailures`, a popup) and **Settings → Tools → Piwi** change them.

### Breakpoints

Every test run passes the IDE's breakpoints to the service: `PiwiCommands.runTests` (Code Vision, **Run this test**,
**Run the test at the caret**, **Run this spec**, **Run the tests that reach this file**, **Re-run the failing tests**)
and **Run selection…**. The breakpoints come from `PiwiProjectService.breakpoints`:

1. `XDebuggerManager.getInstance(project).breakpointManager.allBreakpoints`, keeping the enabled `XLineBreakpoint`s in
   local files, in a read action;
2. then `Glue.runBreakpoints`, keeping those in script files under a Playwright config's folder.

The checkbox under **Settings → Tools → Piwi** (`PiwiLocalSettings.breakpoints`, on this machine only) turns them off.

When the command carries `PIWI_PAUSE_AT` or `PIWI_RUN_CHANNEL` (a run the IDE or Piwi Picker can pause), or says the
run pauses at a `page.pause()` (`RunCommand.pauses`), `PiwiCommands.startRun` adds `PIWI_EDITOR_SEND`: the pairing
address `PiwiSendHandler` serves, with its token from `PasswordSafe` (created when missing, `runPairing`). The
descriptor names the same address to the service as it starts while a token is kept (`keptRunPairing`, `runPairing` in
its initialization options), and `PiwiSendToken.ensure` tells every open project's service once it mints one
(`piwi/setRunPairing`), so a run started in a terminal that follows the IDE posts its picks there too. `startRun` also shows
`RunCommand.notice` (a reporter too old for breakpoints) once, as a warning balloon. What the service does with the
breakpoints: [Breakpoints and picked locators](../../packages/editor/ARCHITECTURE.md#breakpoints-and-picked-locators)
in the editor service's reference.

### Run control

`PiwiRunControl.kt` shows and steers the runs started here (`PiwiRunSessions`), with Piwi's own actions and no debug
session. The initialization options say so (`runControl`). What the service does:
[Run control](../../packages/editor/ARCHITECTURE.md#run-control) in the editor service's reference.

**Sessions.** The plugin keeps the latest `piwi/runSessionChanged` of each ref (`PiwiLsp4jClient.runSessionChanged`,
`Glue.withSession`) until one says `ended`, or the service's process ends (`watch`, from
`PiwiLspServerDescriptor.startServerProcess`). A run started in a terminal (`RunSession.terminal`) is one too: its
stops say `run in a terminal` (`Glue.pausedText`), and it has no Stop, its process being the terminal's
(`RunControls.stoppable`). So is a run of a Playwright run configuration Piwi did not make, the gutter's Run included
(`RunSession.runner`), whose reporter follows the IDE as one in a terminal does: its stops say `run by the editor's
test runner`, and the Run tool window's Stop ends it.

**A stop.** A stop opens its file at its line once (`Glue.stopKey`, `Glue.StopsShown`), at the line it stands on now. It
takes the focus, decided as it opens, only as a stop of the worker slot (`parallelIndex`, which a worker restarted after
a failure keeps) the person is on, or while no other stop held had its file opened or left closed (its tab closed since
or not) and no Step or Run to caret from the IDE waits for its slot's next stop (`Glue.RESERVED_MILLIS` at most, while a
worker of the run holds the slot; another stop of that slot opening ends the wait, the stepped one not). The slot the
person is on is the one whose stop last took the focus (one chosen in the status bar item's menu included), or that they
last acted on: a control from the IDE (counted as it is sent; a refusal, `ok: false`, undoes what nothing changed since,
each answer by its token, and no answer undoes nothing: `refused`, `taken`; a control no service runs to take is
refused), a code action (`start`), or a press, a key, text, the wheel or a pick on the Paused page (`acted`,
`Glue.actsOnPage`; a pointer moving or a release is not acting). Acting that ends a wait, and a refusal, draw the stops
again, as going to a stop from the status bar item's menu does. The slot the Worker tab watches is not the person's for
that: the tab shows its page whatever the focus, while the focus chooses the stop the actions and the caret act on. A
file that never opened counts as none. Without the focus, the editor in use is left alone (`PiwiRunSessions.reveal`): a
file open in an editor already keeps its caret, so the actions still act on the stop at the caret, and while an editor
shows a file, another stays closed, the stop drawn when it opens, and counts as shown as an open file does; the platform
opens no file without selecting it (`FileEditorOpenOptions` is internal). With no editor shown, it opens with
`navigate(false)`. The status bar item's menu lists each stop (`GoToStopAction`, `Glue.stopLabel`), which opens its line
with the focus (`PiwiRunSessions.goTo`). It is drawn as the execution point:

- a range highlighter on the document's markup model in `PIWI_EXECUTION_POINT` (**Line a run is stopped at** in
  `PiwiColorSettingsPage.kt`, falling back on `DebuggerColors.EXECUTIONPOINT_ATTRIBUTES`), with
  `AllIcons.Debugger.NextStatement` in the gutter, whose click and right-click list the stop's controls (`stopActions`):
  the registered `Piwi.ResumeRun` to `Piwi.EndTest`, the code actions and the browser's, each acting on that stop
  (`STOP`, `registeredWith`) with its key shown;
- a block inlay above the line in each editor of the file (`StopInlay`, added again in an editor opened later:
  `EditorFactoryListener`): `Glue.pausedText` (`Paused · <title> · attempt N`, the attempt on a retry only), then
  **Resume**, **Step**, **Run to caret** and **Finish** as links, and **End test** at a stop whose worker takes `end`
  and is no failure (`Glue.canEnd`, `Glue.stopControls`). An `EditorMouseListener` on the multicaster clicks
  them in the editors of its own project (`StopInlay.controlAt`, the hand cursor over one).

A stop in a file the VFS has not loaded is looked for on disk off the event thread, once
(`refreshAndFindFileByNioFile`), and its file opens once found (`unopened`), the focus decided then; the Paused page
tab does not wait for it, and shows its page meanwhile when `Glue.StopsShown` gives it.

**Edits since the run started.** A run's lines are the documents as they stood when it started (`started`, else when
first heard, a rerun under the ref of a run that ended included). `Glue.EditLog` keeps the edits that move lines while a run is live or starting (a `DocumentListener` on
the multicaster, `Glue.lineEdit`). They bring a stop to the line it stands on now (the mark, an inlay drawn later, the
caret's match, `Glue.stopsFor`), and the caret's line back to the run's for Run to caret, which is refused on a line
written since.

**The actions** (`RunControlAction`): `Piwi.PauseRun`, `Piwi.ResumeRun`, `Piwi.StepRun`, `Piwi.RunToCaret`,
`Piwi.FinishRun`, `Piwi.EndTest` (**End the test**, `end`, enabled where `Glue.canEnd`, and while a Pause waits for
the call a test runs, where it sends `give-up`, naming the worker and no stop), `Piwi.ShowPausedPage` and
`Piwi.StopRun`.

- They are under **Tools → Piwi**, and in the status bar item's menu while a run is live, after the stops it lists; the
  item reads `Piwi: stopped at a breakpoint · checkout.page.ts:12` while one is stopped, its reason's words
  (`Glue.runControlStatus`), with the pause's icon, or the error's while every stop held is a failure
  (`Glue.heldFailuresOnly`).
- They are enabled only while they apply (`Glue.runControls`). Within `Glue.RESUMED_MILLIS` of an answer, until another
  stop of that slot opens, they act on a stop of the answered slot or on none, whatever the caret or another worker's
  new stop say, so a key pressed again answers no other worker. Otherwise they act on the stop at the caret's line, else
  on the only stop whose file or page the person was shown, else on one chosen in a popup (`Glue.stopsFor`,
  `Glue.StopsShown.choose`). The code actions, Show the paused page and Share follow the same rule, the moments after an
  answer aside.
- They send `piwi/runControl` on a pooled thread, naming the stop they answer (`since`); an answer with `ok: false` is a
  balloon.
- **Pause the run** pauses every run of the project. **Stop the run** ends the process of the ref (`track`, from
  `PiwiCommands.run` and the IDE's Playwright runner), as another tool's Stop through the hub does (`piwi/stopRun`,
  answered with `Glue.stopRunAnswer`). The Run tool window's own toolbar (`RunContentExecutor`'s Rerun,
  Stop and Close) takes no other action.

**Shortcuts.** The actions use the debugger actions' shortcuts, in every keymap (`use-shortcut-of`): Pause `Pause`'s
(none in the default keymap), Resume `Resume`'s (`F9`), Step `StepOver`'s, Run to caret `RunToCursor`'s, Finish
`StepOut`'s; End the test has none, the debugger having no action it stands for. They are enabled only while they apply,
and from the keyboard (`ActionPlaces.KEYBOARD_SHORTCUT`) only while the debugger does not take the key (`givesWayTo`,
over `XDebuggerManager.debugSessions`): Resume, Step, Run to caret and Finish give way to a suspended session, the only
one the debugger's resume and step act on, Pause to a running one, the only one the debugger's Pause acts on, and Stop
to any. Resume's key stays Piwi's for `Glue.RESUMED_MILLIS` after an answer, doing nothing without a stop, so a second
press starts no debug session. While a run is live, `PiwiRunActionPromoter` (an `ActionPromoter`) puts them first among
the actions a key runs: a keymap that gives the key to another action too (the VSCode keymaps' `F5`, `Debug`; NetBeans'
`F4`, `EditSource`) runs Piwi's while it applies, the other once it does not.

**The Worker tab.** **Tools → Piwi → Watch a worker's test** (`WatchWorkerAction`) and **Pause and watch a worker's
test** (`PauseAndWatchAction`) open a **Worker N** tab of the Piwi tool window (`PiwiRunSessions.showWorker`) on a
worker whose reporter shows its running test (`Glue.watchableWorkers`). It watches the worker's lane with
`piwi/laneView`, decodes `piwi/laneFrame` as the paused page decodes its frames, and says what the worker does
(`Glue.laneShown`). It only watches: a headless stop of its lane is the Paused page's, which takes the input, as any
other worker's is, and while the Worker tab is in sight (the tool window shows, with it selected:
`Glue.selectsPausedPage`), the Paused page shows a new page without being selected, so the Worker tab stays in sight.
The watch goes on while the Worker tab or the Page tab is in sight, ends once neither is, and starts again as one
shows (`laneSightChanged`, decided once the tool window's change of tabs is done); the run's end turns Watch off.

**The running line and the Page tab.** The descriptor sends `runningLine` in the initialization options, so the
service tells the call the watched slot's running test is in (`piwi/runningLine`, `PiwiRunSessions.runningLine`, taken
only for the slot watched then): an inlay after that line in each editor of its file (`RunningLineInlay`, drawn as the
count at the caret is), naming the worker and the call (`Glue.runningLineText`), at the line the edits since the run
started brought it to. A file no editor shows is not read: its document is drawn in once an editor opens it
(`getCachedDocument`, `editorCreated`), and a released editor is let go of (`editorReleased`). The service takes it
away (`call` null), and the plugin does too as the slot's test ends or stops, as another worker takes the slot, as the
run ends and as the watch does (`Glue.runningLinesShown`, `drawRunning` on every draw). A service that predates it
sends none. The watched slot's console errors and uncaught errors, from the events layer the watch asks for anyway, go
one line each into the **Page** tab of the Piwi tool window (`Glue.PageOutput`, `writePage`, a viewer `ConsoleView`),
each test named before its first line; the tab is added, never selected, on the first line, and closes: closed by the
person, it stays closed until the next run begins (`pageClosed`). Both tabs close
(`canCloseContents`, the failures tab alone kept): closed, the Worker tab stops its watch and Watch a worker's test
opens it again, and the Paused page stops its view and the next stop opens it again. **Open the trace so far**, beside
Watch while the slot's worker runs a test whose reporter answers trace asks (`Glue.canOpenTrace`, as the run model's
`canOpenTrace`; never on a CI lane), sends `piwi/openTrace` for the tab's slot (`PiwiRunSessions.openTrace`, through
`RunRemote`), one ask per slot at a time: the slot's button is off until the service answers its own ask, another
slot's takes a press. It says each sentence in a balloon, a warning when it is not `ok`, naming the worker it is for
(`Worker 1: …`, `Glue.traceAnswerText`) when the tab shows another slot by then: the service starts Playwright's trace
viewer on the machine the run runs on, and the trace's path never reaches the IDE.

**The paused page.** A stop with no pause bar asks `piwi/pausedPage` and shows the JPEG (`Glue.pausedImageBytes`, at
most `Glue.MAX_IMAGE_DATA`, decoded only within `Glue.decodableImage`) in the **Paused page** tab of the Piwi tool
window. The tab keeps the stop it shows while that stop is held (`Glue.StopsShown`). Once it went on after a Step or
a Run to caret from the IDE, the tab says so and waits for that slot's next stop while a worker of the run holds the
slot, `Glue.RESERVED_MILLIS` at most (`waitsUntil`: an `Alarm` draws again then); otherwise it opens the first new
stop no pause bar shows, else the first such stop held. **Show the paused page** moves it to the stop chosen. Where
its worker takes `pick-at` and the image names its viewport (`Glue.picksOnImage`), a click on the image picks the
element under it (`piwi/pickAt`, the point scaled to the page's CSS pixels by `Glue.pagePoint`), its locator going
where a pick goes, the answer said under the image.

For a stop taking `view`, **Watch** subscribes through `piwi/pageView` on the existing LSP connection. Frames
(`piwi/pageFrame`) decode off the event thread, with one decode in flight and only the latest waiting frame. Native
checkboxes keep **Interact** off until chosen; input goes through `piwi/pageInput`, at most one batch in flight, with
coalesced pointer moves, and a release only after the input queued before it. A stop without `input-clicks` gets a
click with its count, a left click waiting 250 ms for a second one, and a drag once the pointer moves 4 pixels, as the
Runs window's `ViewInputBatcher` sends them. While interacting, the image takes the Undo, Redo and Select All
shortcuts for the page (a shortcut set registered on it, which the IDE runs before its keymap). Turning Interact on
only routes the input: the person's first click, key, text, wheel or pick drives the stop, in the service. Interact
going off, whatever turns it off, gives back the stop it was last on for (`PausedPagePanel.interactOff`,
`PiwiRunSessions.giveBack`: `piwi/driveStop` with `on: false`, `RunRemote.driveStop`); the plugin never sends
`on: true`. Every call of the tab, its watches included, goes on one serial chain (`pageCalls`), each once the one
before was answered. The give-back goes from the input queue (`pageInputs`): once the input queued before it, the
click held back and the release included, was sent and answered, and before the input queued after it, so that input
drives the stop no more. A watch ending sends what was queued for it, in order, then `piwi/pageView` off
(`stopPageView`); where Interact is on as it ends (Watch off, the tab hidden or closed, a watch refused, another
slot's stop), Interact goes off first (`PausedPagePanel.letGo`), so the input held, the give-back and the watch-off
reach the service in that order. Escape while Interact is on lets go of the input held, then turns Interact off and
focuses its checkbox, but goes to the page while an action runs in the test's window there (`PausedPagePanel.acting`,
from the stop's `acting`). Shift+click picks. Hiding, closing, resuming or showing another stop ends the watch; another
worker's new stop does not.
Watch is remembered within the tab. Interact stays selected for the next stop of the same worker slot shown while
Watch stays on (`Glue.keepsInteract`, `PiwiRunSessions.pageSlot`), disabled until that stop's watch is accepted
and taking input then. It goes off as it is unchecked or Escape is pressed, as Watch is turned off or refused, as
the tab hides (between stops too: `PausedPagePanel.ended` keeps a listener for it) or closes, at another slot's stop,
at a stop that takes no input (`PausedPagePanel.watching` and `configureLive` with `keepInteract`) and as its run ends
or every run goes away (`PiwiRunSessions.runGone`, queued from `heard` before the draw, so a rerun under the ref starts
with it off). The Worker tab has no Interact. No Picker pairing or port forwarding is needed for the panel, and older
reporters keep the still image.

**Breakpoints during a run.** An `XBreakpointListener` sends the breakpoints `PiwiProjectService.breakpoints` gives to
each live run 100 ms after a burst of changes, and the settings page does when the breakpoints checkbox changes. They go
as lines of the run's code (`Glue.runPlaces`): a breakpoint the run was given, known by the `XLineBreakpoint` itself,
keeps its line while it only moved with the edits (`XLineBreakpointImpl.updatePosition` firing `breakpointChanged`);
one added or dragged is mapped back through them. They go only to a run whose places differ from those its command
started with or was last sent (`Glue.breakpointUpdates`, `PiwiCommands.startRun` recording the first). The service
hears them as they stand too (`piwi/setBreakpoints`, from `PiwiRunSessions.breakpointsChanged`, also as the status
changes, only when they differ): a run started in a terminal starts with them.

**A held failure** (`reason: 'failure'`, `Glue.isFailure`) is `Held at its failure · <how it failed> · attempt N`, with
`AllIcons.RunConfigurations.TestError` in the gutter, **Resume** alone among its controls (`Glue.stopControls`), and
`Piwi: failed · checkout.spec.ts:12` in the status bar.

The run control's calls of the service go through `RunRemote`, which `PiwiRunControlTest` replaces.

### Code from a stop

What the service does: [Code from a stop](../../packages/editor/ARCHITECTURE.md#code-from-a-stop) in the editor
service's reference.

**The actions.** A stop also offers the code actions its worker takes (`RunWorker.takes`, `Glue.stopActions`): after
the controls in its inlay, its gutter popup and the status bar item's menu, and under **Tools → Piwi** while some stop
offers them (`StopCodeAction`: `Piwi.PickAtStop`, `Piwi.RecordAtStop`, `Piwi.AssertAtStop`, `Piwi.AssertRegionAtStop`,
`Piwi.MockAtStop`, no shortcut). They are **Pick a locator**, **Record here**, **Assert** and **Assert a region** at a
stop the pause bar shows, **Mock a request** at any; the inlay names them shorter (`StopLink.inlayLabel`). Each is a
`piwi/stopAction` on a pooled thread naming its stop, its answer a balloon. Mock a request lists `piwi/stopRequests`
in a popup, the latest first, filtered by URL as you type (`setNamerForFiltering`; `RequestRenderer`: the method and
URL, then the status, type, size or `no size`, and when it finished: `Glue.requestDetails`).

**The code a stop makes**, from here or Piwi Picker (`piwi/stopCode`, `PiwiLsp4jClient.stopCode`; the initialization
options say the plugin writes it, `stopCode`), is written in one `WriteCommandAction` on the file's `Document`
(`PiwiRunSessions.write`, `Glue.stopCodeWrites`: the edits as offsets, the last in the file first), in an editor, so
the platform sends the service the change:

- a file no editor shows is opened first, and written once the platform told the service it opened it (`whenOpened`:
  its `LspServer.getDocumentVersion` known, asked every 50 ms by an `Alarm` on the event thread, three seconds at
  most);
- it is written only into the version the service placed it in (`LspServer.getDocumentVersion`, else the file as
  saved), else a warning balloon offers **Copy the code**.

The block is scrolled to without taking the focus, and its sentence is a balloon, a warning with what its reader should
check (`Glue.stopCodeNotice`).

**The count at the caret.** While a stopped worker counts locators, a `CaretListener` on the multicaster has the end of
the caret's line in the stopped file say how many elements the locator there matches on the stopped page
(`piwi/locatorAtCaret`, an after-line-end inlay, `CaretCountInlay`): asked 200 ms after the caret settles (an
`Alarm`), one request at a time, an answer the caret left dropped, asked again when the caret comes back
(`Glue.CaretAsks`); `3 matches`, `no match`, a refusal for three seconds, nothing on a line holding no locator
(`Glue.caretText`). The caret leaving the file takes the page's outline down.

### CI runs of the branch

`PiwiCiRuns.kt` shows the CI runs of the branch while they run, read-only, as the service tells them
(`piwi/ciSessionChanged`, `PiwiLsp4jClient.ciSessionChanged`; the service's side: [CI runs of the
branch](../../packages/editor/ARCHITECTURE.md#ci-runs-of-the-branch)). The plugin keeps the latest of each run until
one says `ended`, or the service's process ends (`Glue.withCiSession`, `PiwiCiRuns.watch`).

- **The CI run tab** of the Piwi tool window (**CI Runs (2)** for several) is added, not selected, while one runs, and
  removed once none does; closed, it opens again for a run it did not list. It lists each run as `CI run #78`, its
  branch and progress beside it, then **Open run #78**, its tests, and under a running test of a run that can be
  watched, **Watch** and **Watch on the dashboard** (`Glue.ciRows`). A double click or Enter opens a test at the call
  it is at, else its spec, **Watch** the lane in the Worker tab, and a link in the browser. Each tab has a list model
  of its own, let go with the tab; a push that changes no row draws nothing, and one that does keeps the selected row
  selected by its key (`CiRow.key`). No row pauses, steers, shares or holds the run.
- **A CI lane in the Worker tab** (`PiwiRunSessions.showCiWorker`, in place of the slot it watched) is watched with
  `piwi/ciWatch` through `RunRemote.ciWatch` and drawn from `piwi/ciFrame` (`PiwiLsp4jClient.ciFrame`, decoded off the
  event thread, the newest alone waiting), named `CI run #78 · worker 2` (`Glue.ciLaneTitle`) and captioned from the
  CI sessions (`Glue.ciLaneCaption`, which `PiwiCiRuns` hands on as they change). It has Watch alone: no Interact, no
  pick, no input. Why the watch ended (`ended`) or was refused shows under the caption, Watch then off, and a refusal
  offers **Watch on the dashboard** in a notification. Another CI lane takes the watch's place on the service's side
  without an `on: false`; a local slot, the tab closed or hidden, and a `piwi/ciWatch` the service did not answer
  within 20 s end it.
- **The lane's layers** show under the Worker tab's image, in a splitter (`PausedPagePanel.withLayers`,
  `LaneLayersPanel`), a local slot's (`piwi/laneLayer`) and a CI lane's (`piwi/ciLayer`) alike: **Why it waits**
  (`Glue.waitsView`), then the **Events**, **Text** and **Filmstrip** tabs (`Glue.eventLine`, `Glue.withLaneLayer`,
  `Glue.findIn` for the Text tab's search). `Glue.withLaneLayer` keeps one image per call as the worker sends the strip
  again, and starts the call log and the strip anew for another test, another worker (a retry's), or an image placed at
  or before the strip's last of a call it does not hold. The watch asks for the call log and the events, and for the text or the
  filmstrip while its tab is selected (`Glue.laneLayersAsked`), changing them on the open watch once it was accepted
  (`relayer`), a change the service refused not held as asked (`Glue.layersAfterAnswer`); **Take the text again**
  sends `text: true`, and is off until the service answers (`LaneLayersPanel.textAsking`). A CI lane, whose instance and
  reporter say nothing of it, says until its first layer but the call log comes that an older one of either sends the
  images alone (`Glue.ciLaneLayersNote`). The layers reach the tab in the order they came, one pooled thread at a time
  (`drawLayers`), each filmstrip image decoded and scaled off the event thread, and only once its JPEG header names a
  size within twice the thumbnail's (`Glue.stripImageBytes`, `Glue.jpegSize`): the image kept for the enlarged view is
  640 by 400 pixels at most. New text keeps the Text tab's caret and scroll where the person left them; only the search
  moves them. Every text from the run goes into a `JBTextArea`, an `html.disable` label or a
  `ColoredListCellRenderer`, never HTML, and each tooltip of it (an event's address, an image's number and title)
  through `Glue.htmlTooltip`, which escapes it: the platform renders a component's tooltip as HTML whatever
  `html.disable` says.
- **The CI position** of each running test is an after-line-end inlay in the inlay hints' color, italic, with no
  gutter icon, highlight or link (`CiMarkInlay`, `Glue.ciMarksIn`), in each open editor of its file, drawn again as
  the sessions change and as an editor opens. The editors open are read, never a file from disk. The tests of several
  runs on one line share one inlay.

`GlueTest` checks the rows and their keys, the marks, the CI lane's title and caption, and that a session and a CI
frame read as the service sends them.

## Finding Playwright configs

Once the project is open, `PiwiProjectService.findPlaywright` looks for Playwright configs on a pooled thread
(`Glue.findPlaywright`, with the editor service's depth and skipped folders). It searches:

1. the project folder (in Rider, the solution's folder, above `.idea/.idea.<name>`), the folder the IDE guesses and the
   base directories;
2. when those hold none, the Git repository around them.

The tool window, the status bar item and the service wait for the search. The service's workspace folders are the
folders it searched (`createInitializeParams`).

**Searching again.** **Reload Piwi** searches again, and so does `watchConfigs`, a second after the IDE reports one of
these changes:

- a config created, removed, renamed or moved (`Glue.isPlaywrightConfig`: every name Playwright reads a config from,
  `.mts` and `.cts` included);
- such a change of a folder where configs are searched (`Glue.mayHoldConfigs`), since the IDE reports a new folder
  without the files in it.

### First-run notification

A search whose answer changes offers the first-run notification (`PiwiProjectService.offerFirstRun`), once per
installation (`piwi.firstRunShown`, an application-level `PropertiesComponent` flag). It shows when all of these hold
(`Glue.showsFirstRun`):

- the project is trusted and holds a Playwright config;
- no context of the status is connected (the status is null until the service starts);
- nothing names an instance: the settings, `PIWI_DASHBOARD_URL` in the environment or in a config folder's `.env`, or
  the desktop app running.

The balloon says what Piwi does (`Glue.FIRST_RUN`), with **Connect…** (`PiwiConnectFlow.run`, as `Piwi.Connect`),
**Open the failures** (the tool window) and **Learn more** (`Glue.DOCS_URL`). `PiwiPluginTest` checks the flag.

A trusted project with no Playwright config whose MSBuild project (a `.csproj`, `.fsproj`, `.vbproj` or
`Directory.Build.props`, in the folders and repository the configs are searched in, `Glue.searchedFolders`) references
Playwright for .NET (`Glue.holdsDotnetPlaywright`) hears once, per project (`piwi.dotnetPlaywrightNoted`), that Piwi
reads Playwright Test suites in JavaScript and TypeScript (`Glue.DOTNET_PLAYWRIGHT_NOTE`, a suggestion,
`PiwiProjectService.noteDotnetPlaywright`). A reference added later is heard once the project opens again.

## Recording

What the service does during a recording: [Recorder](../../packages/editor/ARCHITECTURE.md#recorder) in the editor
service's reference.

### Starting a recording

**Record here** (`PiwiRecordingActions.kt`) is under **Tools → Piwi**, in the editor's menu, in Alt+Insert's Generate
menu (`Piwi.RecordHereGenerate`), and on Alt+Enter through `RecordHereIntention.kt`. It asks `piwi/pageCandidates`
where the caret is (`Glue.recordInto`): outside every test, function and class it records a new test; anywhere else,
the steps there, which the service refuses where they cannot go. Without an answer, nothing starts.

- **Where.** The recording actions are offered only in a script file under one of the project's Playwright config
  folders (`Glue.inConfigDirs`).
- **The chord.** `Ctrl+Alt+Shift+R` (`$default` keymap, the command key on macOS) records, and stops a recording.
  `Ctrl+Alt+Shift+F` re-runs the failing tests and `Ctrl+Alt+Shift+K` runs the test at the caret: the VS Code
  extension's chords. Which keymaps already use them:
  [`apps/vscode/ARCHITECTURE.md`](../vscode/ARCHITECTURE.md#keybindings).
- **The choices.** A dialog asks for the start page and the page expression (the candidates, the default first, any
  other typed in; the expression chosen last is selected again), then the plugin sends `piwi/record`; a popup asks for the Playwright project when the answer lists
  `projects`. The choices stay in `PiwiLocalSettings`.
- **A tab closed** while `piwi/record` is pending cancels the recording, in a balloon.

**Record a new test file…** (also under **New**) creates the spec first, where `piwi/newTestFile` offers it: beside the
spec at hand in a test folder, else in the test folder of the config holding the file at hand, created when it does
not exist yet. Its name dialog says why a name is refused (`InputValidatorEx`).

**Recording from a paused test.** A test paused in a run started here can ask to record from there
(`piwi/recordRequested`, `PiwiLsp4jClient.recordRequested`). Its file opens at the paused line and its recording starts
with no dialog, as Record here's would (`PiwiRecordFlow.recordFromTest`: `piwi/record` with the `handoff`). A recording
that cannot start (the file is being recorded into, or cannot be found, opened or written) is declined at once with the
reason (`piwi/declineRecord`). How the hand-off works:
[Recording from a paused test](../../packages/editor/ARCHITECTURE.md#recording-from-a-paused-test) in the editor
service's reference.

### Writing the recorded block

`PiwiRecording.kt` holds the recording sessions (`PiwiRecordings`) and applies `piwi/recordingChanged` on the event
thread.

- **The first update** writes the recorded block where `RecordResult.placement` says: on the line it names in the text
  the service read, followed through the changes made since `piwi/record` was sent (`DocumentChanges`,
  `Glue.followLineStart`, `Glue.firstBlockWrite`). A block on the file's last line keeps its final line break.
- **Each later update** replaces the block whole (`Glue.recordedBlock`), with the import lines the file lacks written
  after its imports in the same command (`RecordingUpdate.importEdit`). The service places the import edit in the text
  as it stands; `Glue.importWrite` makes it before or after the block's write, above the block.
- **Range markers** follow the block. Enter at the end of its last line goes below it.

### Warnings, quick fixes and the banner

- **The block** is tinted with `PIWI_RECORDING_BLOCK`, with a gutter mark that offers Stop, Pause and Resume.
- **Warnings.** The recording's warnings are weak warnings on their lines (`PiwiRecordingAnnotator`), kept after Stop
  until their line changes.
- **Quick fixes.** Once the recording stopped, a warning on a step with other verified locators
  (`RecordingStep.locators`, kept with the warning in `RecordingWarningMark`) offers each one as a quick fix
  (`UseRecordedLocatorFix`, through `newAnnotation(…).withFix`, `Glue.locatorChoices`). **Use getByTestId('pay')** puts
  it in place of the written locator, found on the line exactly once, in one command, and the line it changes no longer
  shows the warning. None is offered while it records, since the next update writes the block again.
- **The banner** over the file (`PiwiRecordingNotificationProvider`, `PiwiRecordingViews.kt`) shows the state, the step
  count and the actions. The status bar item shows them too, and its menu goes to the block first
  (`Glue.recordingStatus`).
- **Paused.** The service says `paused` in an update, for a pause from here or from the browser's bar; the plugin shows
  a pause from here at once.

### Pause, Stop and undo

**An edit inside the block** pauses the recording (`piwi/recordingCommand`), with **Resume** (the service sends the
block again) or **Keep my edits** (Stop: nothing more is written).

**Ending.** Closing the file or the project stops its sessions. A service that stops ends them with a last update, and
Stop ends a session at once when the service does not answer.

**After Stop**, a balloon says what was written (`Glue.recordingSummary`). While the service runs, when `piwi/testAt`
finds a test holding the block's last line, the balloon offers **Run** and **Verify ×3** (`Glue.RUN_RECORDED`,
`Glue.VERIFY_RECORDED`). They run that test through `PiwiCommands.runTestAt` from a range marker at the block's end, so
at the line the block ends on when clicked. No Code Vision offers them.

**One undo step.** A `StartMarkAction` goes in a command of its own just before the first write, and a
`FinishMarkAction` at the end, so one Undo after Stop goes back to before the recording, edits made in the file
meanwhile included. `PiwiRecordingTest` drives it with synthetic updates, the caret moving between writes.

## Send to editor

`PiwiSendHandler.kt` is the Send to editor endpoint: `POST /api/piwi/send` on the IDE's built-in server, with the token
from `PasswordSafe`. **Pair with Piwi Picker** copies the pairing address, and names the ports a JetBrains Gateway
backend's person forwards under **Ports** in the JetBrains Client, at the same numbers: the IDE's and the live run
hubs' (`Glue.forwardingHint`; the platform has no public way to forward one). The handler mirrors
`@piwitests/core/editor-send` (`Glue.parseSendPayload`, `Glue.sendAuthorized`).

**Threads.** A preflight without a challenge is answered on the I/O thread. Every other request is served on a pooled
thread, where the token, the file and its document are read: the built-in server's I/O thread touches neither the
password safe nor the disk. Only the writes run on the event thread.

**Who gets an answer.** `isOriginAllowed` allows an extension's origin on `/api/piwi/send` and `/api/piwi/live`, which
the token authenticates, and leaves the platform's `isAccessible` its check of `Host`, so a page reached under another
name than this machine's is refused. Every answer to a request carrying `x-piwi-editor-challenge`
(`Glue.isEditorChallenge`), whatever its path and status, the preflight and the 401 included, carries
`x-piwi-editor-proof` (`Glue.editorTokenProof`, mirroring `@piwitests/core/editor-send`, for the port the request
reached). So Piwi Picker sends the token only to an IDE that holds it. The CORS headers allow the challenge header and
expose the proof's.

**The live hubs.** With the same token and CORS rules (an extension's origin alone is named), `GET /api/piwi/live`
answers `{ hubs }` on a pooled thread: the hub of every editor service running on the machine, every IDE's and
project's, read at each request from their discovery files (`Glue.liveHubs`, in `PIWI_EDITORS_DIR` or
`~/.piwi/editors`: `Glue.editorsDir`). `Glue.liveHubs` reads as the service's own reader does:

- nothing from a folder that is a link, another user's, or one other users can enter, and only the files this user
  owns, not links;
- a file that reads as a discovery file of this machine (`Glue.machineName`, in any case) naming the process its file
  name names is deleted when `ProcessHandle` finds that process gone; any other file is skipped and left;
- `Glue.parseEditorDiscovery` mirrors `@piwitests/core/editor-discovery`, and keeps the WebSocket's address and token,
  the pid, version, client, workspace folders and start, never the run channel's token.

A request without the token is a 401; one whose token cannot be read, or whose folder cannot be read, a 500. How the
service writes the files: [The discovery file](../../packages/editor/ARCHITECTURE.md#the-discovery-file) in the editor
service's reference.

**Which project.** The endpoint is the IDE's, so every project's runs name it. A locator with `at` goes to the project
whose run made it (`Glue.pickProject`): the open project with a run stopped in the file `at` names under one of its
config folders, else the one holding that file, the focused one first among several; else, and for anything else sent,
the project focused last.

**What it inserts.**

- A locator with `at`, picked while a run was paused at a breakpoint, asks `piwi/applyPick` and replaces the range of
  the answer in a write command. A replacement that fails (a read-only file, a line changed since) answers 422 with the
  reason, shown in a balloon too. When the line holds no locator, the file is not in the project, or the service does
  not run or does not answer, the locator goes to the caret and the balloon says why (`Glue.pickNotice`).
- A recorded flow goes through `piwi/renderSteps` with the caret, for its page expression and its line's indentation,
  and its import edit apart, made with the insertion (`Glue.importWrite`).
- With no editor open, a scratch file (`piwi-picker.ts`) takes the insertion and the answer's `file` is null, as with
  the VS Code extension's untitled editor.

## Open in IDE

`PiwiOpenHandler.kt` serves the dashboard's Open in IDE:
`GET /api/piwi/open?file=…&line=…&column=…[&root=…][&project=…][&check]` on the built-in server, a `RestService`.
With `check`, it only says whether it would open the file. The dashboard side is `useOpenInIde` and `ide-links.ts` in
`apps/application`: a change to the query or the answer changes both.

**Who gets an answer.** Only a page whose `Origin` is one of these (`OpenOrigins.kt` is the pure half):

- the Piwi instance an open project is connected to: its settings, `PIWI_DASHBOARD_URL` in a Playwright config
  folder's `.env`, and the instances the editor service reports. Such a page finds files only in the projects connected
  to it;
- the desktop app, or `PIWI_DASHBOARD_URL` in the IDE's environment: their pages find files in every open project.

Every other request for the path gets a 403 from the handler itself, whatever the platform's origin rules or **Allow
unsigned requests** trust. The first page refused in a session is named in a notification.

**Where the addresses come from.** Each project keeps a snapshot (`PiwiProjectService.readKnownAddresses`), read on a
pooled thread once the configs are found, with each status, and when the connection is saved. So the I/O thread reads
no `.env` file.

**Finding the file.** The handler looks the run's path up under `root` and the project's folders (`Glue.openRoots`:
the service's config folders, the Playwright config folders, the folders searched for them, the project folder above
Rider's `.idea` and the content roots; `Glue.candidatePaths`), ranking first the projects connected to the `project`
named.
It opens only a file inside an open project, and answers JSON with CORS, so the dashboard knows the file opened.

**Debug in my editor.** With `debug=1`, the request also names the test's spec (`spec`), its title after its describe
blocks' (`test`), its Playwright project (`playwrightProject`) and the failed execution (`execution`), each checked by
`Glue.parseOpenRequest` (a positive whole line and execution, a title and a project of plain text, a project no shell
expands, a path without `..`, no field twice). Both files are found as an open's file is, then checked by their
canonical paths, every symbolic link followed (`Glue.debugFileRefusal`): in the same folders `Glue.openRoots` gives, so
a spec Open in IDE opens beside a Rider solution may be debugged too, and under a Playwright config's folder, the check
that bounds it, the config folders being among those folders; a script file and a spec. A refusal answers 400 with the
reason and says it in a notification; otherwise the failing line opens and `PiwiDebugLink` asks in a notification, the
answer saying `debug: "asked"`. Only **Debug** runs the test, through `PiwiCommands.runTests` (the IDE's breakpoints,
the Playwright runner when it is on) with `RunTestsArgs.debug`; the service keeps the failing line as the run's own
breakpoint until the stop, so the IDE's breakpoints are left as they are.

## Connect

**Connect** (`PiwiConnect.kt`):

1. When the desktop app runs, it first lists the app beside the instance the project names (`Glue.connectChoices`).
2. It asks the instance whether it needs a key.
3. A key comes from the browser sign-in (the device authorization Piwi Picker uses, `/api/extension/connect`) or is
   pasted.
4. Then it asks for the project.

An instance on this machine is tried on every loopback address (`Glue.loopbackAlternatives`), since a server started on
`localhost` may listen on `::1` only. It is never reached through the IDE's proxy, and the address that answered is the
one saved. Connect runs from **Settings → Tools → Piwi** (`PiwiConfigurable.kt`), the tool window's gear menu and
**Tools → Piwi**. On the settings page it takes the URL typed there, Apply or not, and applies nothing: Connect and
Disconnect save the connection themselves, then the page shows the connection rows as saved, and its other edits stay
pending until Apply or Cancel. The page opens on the connection in use (`Glue.connectionSummary`) with **Reconnect**
(`sendCredentials`) and, while the service cannot start, **Node.js settings…**, which selects the Node.js page of the
open Settings dialog and starts the service again as the dialog closes; then the instance, whose **Test connection**
reaches the URL in the field, saved or not, with Connect's `reach` and says the answer under it
(`Glue.testConnectionText`, `Glue.testConnectionFailure`); then the desktop app, whose field reads **Desktop app
project:**. When the environment or a `.env` names another instance than the saved one (`Glue.overriding`, the first
config that does), the page says so above the fields (`Glue.overriddenText`), the desktop app's place before it
included, and the empty fields show its address and, while it is read, its project. The page follows the status while
the dialog shows (`PiwiProjectService.onChangeInDialogs`). The tool window's empty text links the Node.js settings while
the service cannot start. Disconnect is enabled only while something is saved to forget, and says so from **Tools →
Piwi** otherwise (`Glue.NOTHING_SAVED`). A failure is said in words (`Glue.connectFailure`): a certificate the IDE does
not trust names its host and **Settings → Tools → Server Certificates**, and a 404 says the address is not a Piwi
instance.

`PiwiProjectService.desktop()` asks the service (`piwi/desktop`). While the service has not started, it reads the app's
discovery file itself (`Glue.parseDesktopDiscovery`, `Glue.linkedDesktopProject`), so Connect finds the app before any
file is opened.

## Settings and secrets

| What                                               | Where                                           |
| -------------------------------------------------- | ----------------------------------------------- |
| The instance URL and the project (`PiwiSettings`)  | `.idea/piwi.xml`, which a repository may commit |
| The API key, **per instance** (`Glue.apiKeyEntry`) | the IDE's `PasswordSafe`                        |
| Choices made on this machine (`PiwiLocalSettings`) | `.idea/workspace.xml`                           |

`PiwiLocalSettings` holds the choice of the desktop app and its project, a recording's choices, the failures'
grouping, the breakpoints setting, the Playwright runner setting, how a run starts (headed, Hold failures), the run
notifications, the coverage marks, the failure severity, how the agent signs in to Piwi's MCP server, whether the runs
are served to agents and the port they were last served at, and the baselines. The runs' MCP server's token is in the `PasswordSafe`.

A project's settings never select another instance's key, and choosing the desktop app never changes the instance, its
project or its key. The old key entry shared by every instance is deleted once (`forgetSharedKey`).

## MCP server configuration

**Copy the MCP server configuration** (`CopyMcpConfigurationAction`) writes the servers of `piwi/mcp` as `mcpServers`
entries that run `mcp-remote` (`Glue.mcpConfiguration`), with the key in `env`, never on the command line. Every
entry runs one exact release, `Glue.MCP_REMOTE` (`npx -y mcp-remote@<version>`, a release with the fix for
CVE-2025-6514), over streamable HTTP alone (`--transport http-only`): `npx` with no version runs whatever npm serves
that day, with the key or the token in its environment.

With `PiwiLocalSettings.mcpAuthorization` at `sign-in` (`Glue.MCP_AUTHORIZATIONS`, in the AI Assistant group of the
settings page, sent in `credentials()`), the service hands an instance's server without a key, and `mcp-remote` signs
in through the instance's OAuth. The notification says which (`Glue.mcpAuthorizationNote`).

**The runs' MCP server.** The editor service serves this project's runs to the agents of this machine as an MCP server
of its own ([Agents](../../packages/editor/ARCHITECTURE.md#agents) in its reference). The initialization options say
whether (`agents`, from `PiwiProjectService.agentsOptions`): `PiwiLocalSettings.serveRunsToAgents` (**Serve the test
runs this project starts to the agents of this machine**, in the AI Assistant group of the settings page, which sends
`piwi/agents` on a change), the port it listened at last (`agentsPort`) and the token, kept in the `PasswordSafe`
per project (`Glue.agentsTokenEntry` of `Project.getLocationHash`, a new one when none is kept: `Glue.newAgentsToken`).
So a configuration copied once still connects after a restart. When another program holds the kept port, the service
takes another with a new token, tells it (`piwi/agentsChanged`, `PiwiLsp4jClient.agentsChanged`) and says in a
`piwi/notice` to copy the configuration again: `PiwiProjectService.agentsHeard` keeps the new port and token, as it
does for every answer of `piwi/agents`. **Reset the runs' MCP server token** (`ResetRunsMcpTokenAction`, after
`MessageDialogBuilder.yesNo`) sends `piwi/agents` with `newToken` and keeps the new token the same way.

**Copy the runs' MCP server configuration for agents** (`CopyRunsMcpConfigurationAction`) asks `piwi/agents`, keeps
the port it answers (`Glue.portOf`) and writes a `piwi-runs` entry bridged by `mcp-remote`
(`Glue.runsMcpConfiguration`), the token in `env` (`PIWI_RUNS_AUTH`), for an agent that starts only commands; **…for
Claude Code or Cursor** (`CopyRunsMcpHttpConfigurationAction`) writes the `mcpServers` entry of type `http` they read
(`Glue.runsMcpHttpConfiguration`), the token as a bearer header. Both notifications say to keep it out of every file
of the repository. The AI Assistant (`com.intellij.ml.llm`, not bundled) has no public API to add
an MCP server, and the MCP Server plugin's `mcpServer.mcpToolset` extension point, which adds tools to the IDE's own
server, starts at 2025.2 (the plugin compiles against 2024.1, [Platform compatibility](#platform-compatibility)), so
the person pastes the entry.

**Share with Playwright tools** (`ShareWithPlaywrightAction`, `Piwi.ShareWithPlaywright`, and the last item of a stop's
gutter popup, at a stop whose worker takes `bind`: `Glue.canShare`) asks first (`MessageDialogBuilder.yesNo`,
`Glue.SHARE_WARNING`), then sends `piwi/stopBind` on a pooled thread; the notification names the command that joins
the browser (`Glue.sharedText`), with **Copy the command** and **Stop sharing**. A stop an agent asked for reads
`Paused by the agent · …` (`RunStop.by`, `Glue.pausedText`).

**Who else is there.** The Paused page tab's caption (`Glue.stopCaption`, kept as it changes by `draw`), the Worker
tab's (`Glue.laneShown`), the gutter arrow's tooltip and a stop's entry in the status bar item's menu
(`Glue.stopPresence`) add who drives the stop (`Glue.driverText`, from `RunStop.driver`: `You drive this stop`, `An
agent drives this stop: your input takes control` where the stop takes input) and who else watches its page
(`Glue.watchersText`, from `RunWorker.watchers`, the IDE itself named `you` and left out when alone). The status bar
item's tooltip of a run names the other tools that have each run open (`Glue.runsPresenceText`, from
`RunSession.presence`). A click, key or wheel through Interact, or a pick, takes a stop from the agent; Interact going
off, Escape included, gives it back.

**Share the run live** (`ShareRunLiveAction`, `Piwi.ShareRunLive`, while a run is live) shares a run on the team
instance its reporter reports to (`piwi/shareRun` through `RunRemote.shareRun`, `RunSession.live`): the only run it
fits, else the one chosen (`Glue.liveTarget`). The first share in the project since it opened asks what goes out and
to whom (`MessageDialogBuilder.yesNo`, `Glue.shareLiveWarning`), a run its workers have not said anything of yet
included; a run known not to be shareable is asked without it, and the service says why. Shared, the notification
offers **Copy the run page's link** and **Stop sharing…**, as does **Stop sharing the run live…**
(`StopSharingRunAction`, while one is shared). The status bar item counts the views open of every shared run
(`Glue.liveStatus`, `Glue.runControlStatus` at a stop), its tooltip where (`Glue.sharedLiveText`), and its menu holds
the share's entries (`Glue.liveMenu`: **Open the run page**, **Copy the run page's link**, **Stop sharing the run…**
for each shared run, named when several are, and **Stop sharing this project's runs…** while they are shared), first
while the item shows the share, else after the run's controls. Every way to stop a share, the run's or the project's,
asks first (`PiwiRunSessions.confirmStopSharing`, `Glue.stopSharingQuestion`), about the run picked: one that ended or
is shared no more is not asked about, and `Glue.SHARE_ENDED` says so.

## Platform compatibility

**The oldest supported platform is 2024.1** (`pluginSinceBuild=241`): the first whose LSP API sends requests through
the server (`sendRequestSync`) and lists servers in the Language Services widget. Compile against it, and look an API
newer than 2024.1 up at run time, or do not use it.

**Verification.** `verifyPlugin` checks the latest WebStorm, IntelliJ IDEA Ultimate and Rider too. CI verifies on
2024.1 and the latest WebStorm for a pull request, and on every IDE on `main` (`reusable-jetbrains.yml`).

**Tests.** The platform's test framework is pinned (`platformTestFrameworkVersion`): it is published with IntelliJ
IDEA's build numbers, just after WebStorm's. The test sandbox disables the Swagger plugin, whose test service ships
with its own tests only.

**No internal API** (`@ApiStatus.Internal`, such as `LspServerManager.addLspServerManagerListener`): the Marketplace
refuses an upload that uses one, and `verifyPlugin` fails on it (`INTERNAL_API_USAGES`).

**Deprecated APIs.** An API deprecated on the newest platform is replaced by one that 2024.1 has too, since the
Marketplace's Plugin Verifier counts every use. The replacements in use:

| Instead of                          | Use                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `ReadAction.compute`                | `Application.runReadAction(Computable)`                                            |
| `SimpleListCellRenderer.create`     | a `SimpleListCellRenderer` subclass                                                |
| `CredentialAttributes(…)` in Kotlin | `PiwiCredentials.attributes`, in Java, so it binds to the one-argument constructor |

To invoke an action from code, use `ActionManager.tryToExecute`, not `ActionUtil.invokeAction`.

What stays has no replacement in 2024.1:

- the LSP API, renamed in 2026.3 (`LspServer` → `LspClient`, `LspServerSupportProvider` → `LspIntegrationProvider`,
  `LspServerManager` → `LspClientManager`, `…ServerDescriptor` → `…ClientDescriptor`, `lspCommandsSupport` →
  `lspCustomization.commandsCustomizer`);
- `DaemonCodeAnalyzer.restart(PsiFile)` (2026.x adds the reason that `restart(PsiFile, Object)` takes).

**Kotlin compiles without its compatibility bridges** (`jvmDefault`): the verifier counts each bridge as a use of the
default method it calls.

## Threading

Nothing blocks the event thread, and nothing in a read action waits on the service without giving way:

- the daemon (Code Vision) waits with `awaitCancellably`, which a write action cancels;
- `orNull` waits the same way, and a task's Cancel stops it;
- reads of the disk and of the password safe run on a pooled thread.

A request that fails is written to `idea.log` under `#dev.piwitests.jetbrains` with its cause, as a warning at most
once a minute and at debug between, since the daemon asks on every pass; one that answers nothing in its time is
logged at debug, a cancel not at all, and a failed Connect at info. An action that needs the service says
`Glue.SERVICE_NOT_RUNNING` while it does not run (open a test file, or Tools → Piwi → Restart the editor service), and
`Glue.SERVICE_NO_ANSWER` when the running service did not answer, in a balloon and in the Paused page and Worker tabs
alike; `PiwiCommands.notify` shows a balloon that says either as a warning, with **Restart the editor service** and
**Open log** (`Glue.offersServiceFixes`). An action that needs an instance says `Glue.CONNECT_FIRST` with **Connect…**
while none is connected.

## The log

`PiwiLog`, one per project, keeps the editor service's log for the Piwi tool window's **Log** tab, as VS Code's output
channel does, its last `Glue.LOG_LINES` lines (`Glue.LogBuffer`):

- each start, with the Node.js interpreter, from `createCommandLine`, and why a start failed, every
  `ExecutionException` of `startServerProcess` (which calls `createCommandLine`);
- the service's stderr, from a listener `startServerProcess` adds before the platform reads the process, removed as it
  ends: the service writes its errors there (`logError` in `main.ts`), and Node.js a crash's stack, whose indented
  frames continue the line before them (`Glue.logLines`);
- each end and its exit code (`watchServer`). The end of the latest process drops the pushed answers, without asking a
  service that is gone, and the tool window says the service stopped, with **Restart the editor service** and **Open
  log** (`Glue.serviceDownText`), as the status bar item does (`Piwi: not running`), until a process starts again;
- each failed request under its method, once a minute per method: `piwiServer()` hands out a proxy of the service
  (`PiwiLog.logged`) that watches every request's future, whoever waits for it.

`Lsp4jClient.logMessage` is final, and wrapping its `LspServerNotificationsHandler` would call an override-only API, so
`window/logMessage` stays the platform's. **Open log** (`Piwi.OpenLog`) opens the tab, a read-only console, closable;
**Restart the editor service** (`Piwi.RestartService`, `restartService`) writes its line, then `restartServer`; with no
service running and no test file open, the IDE has no file to start it for, and a balloon says to open one.

## Dynamic plugin loading

The plugin loads and unloads without a restart: no `require-restart`, and the verifier says it can be enabled or
disabled without one. On load and unload:

- the platform stops the editor service with the LSP provider, and runs `PiwiStartupActivity` for the projects already
  open;
- every listener has a project service as parent;
- the work a service queues expires with it (`gone`: the service disposed, not only its project);
- work that may outlive the plugin, such as a run's end, reaches the service with `getServiceIfCreated`, never
  `project.service<…>()`.

The plugin has no application component and no thread of its own.

## Change notes

The Marketplace's What's new is the `<change-notes>` of the built `plugin.xml`, which `build.gradle.kts` fills from
the `CHANGE_NOTES` environment variable. `reusable-publish-jetbrains.yml` sets it, before its first Gradle run, to the
release's `ide` entries of the root `CHANGELOG.md` as HTML (`node scripts/ide-changelog.mjs --format html` from the
repository root). A commit with the `ide` scope is what puts a line in it. A build without the variable ships no
change notes.

## Screenshots

`scripts/take-screenshots.mjs` writes the plugin's illustrations, `apps/docs/public/screenshots/jetbrains-*.png`,
shown by the docs and the README. The Marketplace listing's images are uploaded by hand from them.

**How it runs.** It starts an Xvfb display and, for each scene, launches the latest WebStorm release (downloaded into
`.ide/`, gitignored, on the first run):

- on the fixture project of `apps/vscode/scripts/lib/editor-fixture.mjs`, against its stub instance;
- with the built plugin unpacked from `build/distributions/`;
- with the scene's file and line on the command line, which is what puts the caret there with the editor focused (the
  editor state of a pre-written `workspace.xml` is not restored on a fresh project).

The keys a scene needs go through `scripts/xinput.py` (XTEST), through the shortcuts of a keymap the script writes
where the IDE's actions have none (the Piwi tool window, the notifications). ImageMagick's `import` captures the screen.
The config the script writes turns off the IDE's own lines above the code (code authors, usages), so the ones above the
code are Piwi's. An image whose status bar does not draw Piwi's item with the fill of the dark theme's `TestError` icon and
the error color of its label, which the fixture's failures call for, is not written: the capture goes to the temporary
directory instead (`statusItemFailing`).

**The license.** The IDE's config directory stays in `.ide/config` across runs, because the license lives there. On a
machine without one, the IDE shows its license dialog:

- `--start-trial` answers its Start trial tab, which claims the release's 30-day trial with no account (an internet
  connection suffices; a version's trial is claimed once per machine);
- `--config` copies an activated IDE's config directory in instead.

An EAP build asks for a JetBrains account, so it cannot serve.

**Other options.** `--ide` names another installed release, `--probe` captures the IDE as it stands without driving
it, and `--keep` leaves the run's directory with the IDE's logs. What was found about the IDE on the way (the license,
the launcher, the properties that keep it quiet, what a check in the real IDE would need) is recorded in
[`proposals/real-editor-checks.md`](../../proposals/real-editor-checks.md).

## The JDK

The Gradle daemon runs on the JDK 21 that `gradle/gradle-daemon-jvm.properties` names, whatever `JAVA_HOME` points to.
The wrapper itself starts on an older JVM (Gradle documents JVM 8 or later for its wrapper and client). The build
compiles with a JDK 21 toolchain (`jvmToolchain(21)`), as bytecode for Java 17, the runtime of the oldest supported
platform.

When the machine has no JDK 21, Gradle downloads one into `~/.gradle/jdks`: for the daemon, from the links in
`gradle/gradle-daemon-jvm.properties`, and for the toolchain, through the foojay resolver in `settings.gradle.kts`. CI
(`reusable-jetbrains.yml`) installs JDK 21, so it downloads nothing.

Moving to another JDK changes both: `./gradlew updateDaemonJvm --jvm-version=<n>` regenerates the properties file, and
`jvmToolchain` follows in `build.gradle.kts`.

## Tests

`./gradlew test` runs two kinds of tests:

- **Unit tests**, with no IDE: `GlueTest` (the pure half), `OpenOriginsTest` (who may use Open in IDE) and
  `Lsp4jAccessTest` (the lsp4j proxy taken from a request's sender).
- **Platform tests** on WebStorm 2024.1: `PiwiPluginTest`, `PiwiRecordingTest`, `PiwiOpenHandlerTest` and
  `PiwiRunControlTest`.

The platform test `testTheBundledServiceAnswersThroughTheDescriptor` (`PiwiPluginTest`) starts the bundled service with
the descriptor's command line against a stub instance, and reads its answers with the Kotlin protocol classes, a run's
session and controls with a fake worker on the run channel among them, and the code from a stop (`piwi/stopRequests`,
`piwi/stopAction`, the `piwi/stopCode` it sends, `piwi/locatorAtCaret`).

`PiwiRunControlTest` drives the run controls with the sessions the service would send: the execution point, the inlay,
the actions, the edits above a stop and Run to caret from them, the paused page of a file the VFS has not loaded, the
breakpoint listener (a breakpoint moved as the platform moves one outside tests, which a unit test does not), the
promoter, the runs of the IDE's Playwright runner (a rerun under an ended ref included), the code actions, a failure's
stop, the code a stop made written in one command (one undo, once the service knows the document), the count at the
caret, and a stop's browser shared only once the person said yes.
