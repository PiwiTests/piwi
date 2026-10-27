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
  - [Compare With](#compare-with)
- [Status bar](#status-bar)
- [Runs](#runs)
  - [Playwright runner](#playwright-runner)
  - [Commands and notifications](#commands-and-notifications)
  - [Running the test at the caret](#running-the-test-at-the-caret)
  - [Breakpoints](#breakpoints)
  - [Run control](#run-control)
  - [Code from a stop](#code-from-a-stop)
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

## Starting the service

The plugin starts the service through the platform's LSP API (`PiwiLspServerDescriptor`), with the project's Node.js
interpreter and `--stdio --clientProcessId=<the IDE's process id>`. The platform passes no process id of its own, and
with this one the service exits within seconds of the IDE's end, however the IDE ends.

**Node.js 20 or later.** The service starts only once `node --version` says 20 or later (`Glue.nodeProblem`).
Otherwise:

- the start fails with that reason, which `PiwiProjectService.startFailed` keeps (`startProblem`) and says once;
- the status bar item reads `Piwi: Node.js`, and its menu opens the Node.js settings first (`openNodeSettings`,
  `settings.nodejs`), after which the service starts again (`restartServer`), as it does on **Refresh** while it does
  not run.

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
run or believe what the repository holds. A supported file opened meanwhile says once that Piwi waits for the trust
(`Glue.UNTRUSTED`); the next file opened once the project is trusted starts the service.

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

- a gutter icon, with the details as its tooltip; its click runs what the line names (Open in Dashboard);
- the `PIWI_FAILING_TEST` background over a failing test;
- `PIWI_FAILING_LINE` on the line it failed at, with the reason as the tooltip. The test's background goes around that
  line, since two backgrounds on one line have no set order.

The colors are on **Piwi**'s color settings page (`PiwiColorSettingsPage.kt`), with defaults in
`resources/colorSchemes/`. A test the run in progress runs has the `AllIcons.RunConfigurations.TestState.Run` icon,
then that run's result. Code Vision (`PiwiCodeVisionProvider.kt`) draws the summary's other lines and skips the test
lines.

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

The keys are in the **Coverage** group of `PiwiColorSettingsPage.kt`, with no background by default; each also marks
the scroll bar. The uncovered changes are `Glue.CoverageKind.UNCOVERED`, and their tooltip ends on
`Glue.UNCOVERED_EXPLAINED`. The run and not-run defaults are the dashboard's colors (`COVERAGE_MARK_COLORS` in
`@piwitests/core/coverage`, checked by `apps/application/tests/unit/coverage-mark-colors.test.ts`).

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

**Show Coverage Marks** (`Piwi.ToggleCoverageMarks`, a `ToggleAction` under **Tools → Piwi**, kept in
`PiwiLocalSettings.coverageMarks`, on by default) is hidden, not only disabled, until a file showed marks. A file
without line coverage draws nothing.

## Native views and pushes

Besides what the LSP client draws, every view is native, and all stay available while the IDE indexes (`DumbAware`):

- Code Vision, from `piwi/fileSummary`;
- the status bar, from `piwi/runStatus`, with the run in progress (`live`);
- the **Piwi** tool window, from `piwi/failures` (the LSP client highlights open files only), with the connection from
  `piwi/status` (`Glue.connectionSummary`) and the run (`Glue.runHeader`) in its header;
- the actions under **Tools → Piwi**.

The service pushes each of the three answers when it changes (`piwi/statusChanged`, `piwi/runStatusChanged`,
`piwi/failuresChanged`). `PiwiProjectService` keeps a pushed answer as it comes, and tells its listeners once, on the
event thread, for all the pushes received meanwhile.

It reads the three answers whole (`refreshStatus`) only when the plugin starts (the tool window and the status bar item
are created), on **Refresh**, on the status bar's **Read the Latest Run Again**, and after new credentials. One read
runs at a time, and a read asked for meanwhile follows it. A push that arrives during a read wins over the answer read.

## Tool window

### Tree and nodes

The tool window (`PiwiFailuresToolWindow.kt`) is a `Tree` on a `DefaultTreeModel` of `Glue.failureNodes`: the tree the
service grouped (`FailuresResult.tree`), with each run's age. Its nodes are the ones VS Code's view has: the run,
**Your runs since**, then the failures grouped by file, cluster, owner or flat. How the service builds the tree:
[The failures answer](../../packages/editor/ARCHITECTURE.md#the-failures-answer) in the editor service's reference.

- **The grouping** is chosen with the toolbar's `ToggleAction`s and kept in `PiwiLocalSettings.failuresGrouping`. It is
  sent with every `piwi/failures`, and read again at once by `PiwiProjectService.regroup`; the service keeps it for
  what it pushes.
- **Several configs.** When several Playwright configs have something to show, each has a node (`AllIcons.Nodes.Module`)
  above its tree, and the header line names no run.
- **The editor's own run in progress** shows on the run of its config (`liveRoot`).
- **A row.** A `ColoredTreeCellRenderer` draws a failure's title, headline, run and place. The run is
  `Glue.FailureNode.note`, which the service writes with `failureRunNote` in `packages/editor/src/failure-tree.ts`:
  `your run #N`, `edited since run #N` with the information icon, `fixed` with the passed icon. `TreeSpeedSearch` finds
  a title.
- **Updates.** The tree is built again only when its nodes changed, for instance when `piwi/failuresChanged` reports
  that edits moved them. It keeps the expanded and selected nodes by key. When only what the nodes say changed
  (`Glue.sameShape`, such as the editor's own run counting its tests), each row is redrawn in place.
- **The stripe title** reads `Piwi (n)` while `n` tests fail.

### Navigation and actions

The panel is an `OccurenceNavigator`: Next and Previous Occurrence, and the toolbar's arrows, go from failure to
failure, beside Expand All and Collapse All. Double-click or Enter opens a failure's line, or a run's page.

The right-click menu (`PopupHandler.installPopupMenu`) acts through `PiwiCommands`:

- on a failure: run the test, open the trace, the screenshot or the page, copy the context for an agent
  (`piwi/agentContext`), and, on a CI failure while the desktop app runs, pass it to the app;
- on a config's node: re-run that config's failing tests, choose its baseline and open its run (`ConfigAction`,
  `Glue.FailureNode.root`);
- on a run's node: choose its baseline and open its run.

**Re-run the Failing Tests** (`Piwi.RerunFailing`, under **Tools → Piwi** and in the toolbar) runs
`FailuresResult.rerun`, one run per Playwright config (`PiwiCommands.rerunFailing`), or one config's alone from its node
(`Glue.failingRuns`). **Run This Test** runs `Glue.failureRunArgs`. Both name the failure's config
(`WorkspaceFailure.root`).

### Compare With

**Compare With…** (`Piwi.CompareWith`, under **Tools → Piwi** and in the toolbar) is a popup of
`Glue.baselineEntries`, for the context of the file at hand or of the node it runs from (`CompareWithAction.choose`).
The entries are:

- the default ladder;
- each branch of `RunStatus.branches`;
- a run by its id, typed in `Messages.showInputDialog` and read by `piwi/runId` on a pooled thread; a balloon says when
  the text is not a run id;
- the local runs only.

`PiwiProjectService.setBaseline` keeps the choice in `PiwiLocalSettings.baselines` (by config folder,
`Glue.encodeBaseline`, the ladder as no entry) and sends `piwi/setBaseline`; `credentials()` sends them all as
`baselines`. The header line names the baseline (`Glue.runHeader`). What the ladder is:
[Latest run and baseline](../../packages/editor/ARCHITECTURE.md#latest-run-and-baseline) in the editor service's
reference.

## Status bar

The status bar item (`PiwiStatusBar.kt`, `Glue.statusView`) is a `CustomStatusBarWidget` around a `JBLabel`, since the
platform's text presentations take no color. It shows:

- an icon (`Glue.StatusIcon`): the plugin's, an `AllIcons` icon for the connection and for a failing or passed run,
  `AnimatedIcon.Default` for a run in progress or a read;
- the text, in the theme's error foreground (`NamedColorUtil.getErrorForeground`) while tests of the run it counts fail,
  a run in progress by its own failures (`StatusView.error`), and in the status bar's foreground
  (`JBUI.CurrentTheme.StatusBar.Widget.FOREGROUND`) otherwise.

**Which config.** It speaks for the context of the selected editor's file (`Glue.statusContext`: the deepest config
folder holding it, else the first connected one; `PiwiStatusBarWidget.shownFile`), and is drawn again on
`FileEditorManagerListener.selectionChanged`. With several contexts, the tooltip names that config
(`ContextStatus.label`, else its folder's name), and another context's run is never shown for it.

**A click** opens `PiwiStatusBarWidget.actions()` (`createActionGroupPopup`, with the selected editor's data context;
the disabled actions are left out). First comes what the state calls for (`Glue.StatusAction`):

- connected: **Read the Latest Run Again** (`PiwiProjectService.refreshRun`: `piwi/refreshRun`, then `refreshStatus`,
  on a pooled thread; the item reads `Piwi: refreshing…` meanwhile);
- the instance does not answer (`Piwi: unreachable`, `problemKind`): **Refresh**;
- not connected: **Connect**;
- the service cannot start: the Node.js settings;
- the service has not started yet: **Settings**;
- while a recording runs: going to its block, and its controls;
- while a run is live: its controls ([Run control](#run-control)). The item reads `Piwi: paused · checkout.page.ts:12`
  while a test is stopped (`Glue.runControlStatus`).

Then come the registered actions, by id: Re-run the Failing Tests, Open the Failures (the tool window), Open the Latest
Run in the Dashboard, Open in Dashboard, Compare With…, Run the Test at the Caret, Record Here, Refresh, Connect and
Settings.

**The tooltip** says the same as VS Code's, in plain text: the counts, the local runs, the run in progress and when the
run was read (`Glue.relativeTime`), the baseline (`Glue.baselineLine`), and the reporter version the project installs.

**Open the Latest Run in the Dashboard** (`Piwi.OpenLatestRun`, under **Tools → Piwi** and in the tool window's
toolbar) opens the run the status bar shows.

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
still reports.

The runner's classes belong to the `JavaScript` plugin (`intellij.aqua.runners.playwright.js`, the same signatures in
2024.1 and 2026.x). The plugin reaches them only once `PlaywrightRunnerGate.available()`, which names none of them. Any
other command, an IDE without the runner, or a run the runner does not take, runs in the console.

### Commands and notifications

`PiwiCommands.run` runs a command in the Run tool window:

- its **Rerun** (`RunContentExecutor.withRerun`) stops the command if it runs, and starts it again with the same
  environment once its process ended and the service heard it (`piwi/commandEnded`), so the rerun's workers start a
  session of their own;
- `RunOutputLinks` (`Glue.fileLinks`) links the script paths the output names relative to the command's folder to their
  line; the IDE's console links the absolute ones;
- for a test run (`RunCommand.ref`), a `ProcessListener` sends `piwi/commandEnded` with the exit code when the process
  ends. A rerun keeps the ref, by which the service recognizes it as the editor's own run in the instance's event stream
  ([The editor's own run](../../packages/editor/ARCHITECTURE.md#the-editors-own-run) in the editor service's reference).

**Notifications.** A `piwi/notice` is a balloon (`PiwiCommands.notify`). So is `piwi/runEnded` (`PiwiCommands.runEnded`,
`Glue.runVerdict`), with **Open the Failures**, **Open in Dashboard**, and **Re-run Failing** when something fails. The
run's balloon follows `PiwiLocalSettings.runNotifications` (**Settings → Tools → Piwi**: `always`, `failures`, `never`;
in `.idea/workspace.xml`, on this machine only). A run with `repeat` (**Verify ×3**) is reported whatever the setting,
as `Run #124 · Failed 1 of 3`, a warning when one of the runs failed.

**Diagnostic severity.** The severity of a failure's diagnostic is `PiwiLocalSettings.failureSeverity`
(`Glue.FAILURE_SEVERITIES`, in the Runs group of the same page), sent in `credentials()`. The LSP client shows an
information as a weak warning.

### Running the test at the caret

Three actions, under **Tools → Piwi** and in the editor's menu of a spec (`Glue.isSpecFile`) in a project with a
Playwright config (`RunInSpecAction`):

- **Run the Test at the Caret** (`Piwi.RunTestAtCursor`, `Ctrl+Alt+Shift+K`);
- **Verify the Test at the Caret ×3** (`Piwi.VerifyTestAtCursor`);
- **Run This Spec** (`Piwi.RunSpec`).

Each asks `piwi/testAt` for the caret on a pooled thread, and saves the spec's document on the event thread when it
has unsaved changes. Then it runs as `PiwiCommands.runTests` does (`PiwiCommands.runTestAt`): the test by its id when
Piwi knows it, else by its location (`Glue.testAtRun`); to verify, by its location, three times (`Glue.VERIFY_REPEAT`).
When there is no test, a balloon says so. The gutter icon's click stays Open in Dashboard.

### Breakpoints

Every test run passes the IDE's breakpoints to the service: `PiwiCommands.runTests` (Code Vision, **Run this test**,
**Run the Test at the Caret**, **Run This Spec**, **Run the Tests That Reach This File**, **Re-run the Failing Tests**)
and **Run Selection…**. The breakpoints come from `PiwiProjectService.breakpoints`:

1. `XDebuggerManager.getInstance(project).breakpointManager.allBreakpoints`, keeping the enabled `XLineBreakpoint`s in
   local files, in a read action;
2. then `Glue.runBreakpoints`, keeping those in script files under a Playwright config's folder.

The checkbox under **Settings → Tools → Piwi** (`PiwiLocalSettings.breakpoints`, on this machine only) turns them off.

When the command carries `PIWI_PAUSE_AT` or `PIWI_RUN_CHANNEL` (a run the IDE or Piwi Picker can pause), or says the
run pauses at a `page.pause()` (`RunCommand.pauses`), `PiwiCommands.startRun` adds `PIWI_EDITOR_SEND`: the pairing
address `PiwiSendHandler` serves, with its token from `PasswordSafe` (created when missing). `startRun` also shows
`RunCommand.notice` (a reporter too old for breakpoints) once, as a warning balloon. What the service does with the
breakpoints: [Breakpoints and picked locators](../../packages/editor/ARCHITECTURE.md#breakpoints-and-picked-locators)
in the editor service's reference.

### Run control

`PiwiRunControl.kt` shows and steers the runs started here (`PiwiRunSessions`), with Piwi's own actions and no debug
session. The initialization options say so (`runControl`). What the service does:
[Run control](../../packages/editor/ARCHITECTURE.md#run-control) in the editor service's reference.

**Sessions.** The plugin keeps the latest `piwi/runSessionChanged` of each ref (`PiwiLsp4jClient.runSessionChanged`,
`Glue.withSession`) until one says `ended`, or the service's process ends (`watch`, from
`PiwiLspServerDescriptor.startServerProcess`).

**A stop.** A stop opens its file at its line once (`Glue.stopKey`), at the line it stands on now. It is drawn as the
execution point:

- a range highlighter on the document's markup model in `PIWI_EXECUTION_POINT` (**Line a run is stopped at** in
  `PiwiColorSettingsPage.kt`, falling back on `DebuggerColors.EXECUTIONPOINT_ATTRIBUTES`), with
  `AllIcons.Debugger.NextStatement` in the gutter, whose click and right-click list the stop's controls
  (`stopActions`);
- a block inlay above the line in each editor of the file (`StopInlay`, added again in an editor opened later:
  `EditorFactoryListener`): `Glue.pausedText` (`Paused · <title> · attempt N`, the attempt on a retry only), then
  **Resume**, **Step**, **Run to Caret** and **Finish** as links. An `EditorMouseListener` on the multicaster clicks
  them in the editors of its own project (`StopInlay.controlAt`, the hand cursor over one).

A stop in a file the VFS has not loaded is looked for on disk off the event thread, once
(`refreshAndFindFileByNioFile`); its Paused Page shows meanwhile.

**Edits since the run started.** A run's lines are the documents as they stood when it started (`started`, else when
first heard, a rerun under the ref of a run that ended included). `Glue.EditLog` keeps the edits that move lines while a run is live or starting (a `DocumentListener` on
the multicaster, `Glue.lineEdit`). They bring a stop to the line it stands on now (the mark, an inlay drawn later, the
caret's match, `Glue.stopsFor`), and the caret's line back to the run's for Run to Caret, which is refused on a line
written since.

**The actions** (`RunControlAction`): `Piwi.PauseRun`, `Piwi.ResumeRun`, `Piwi.StepRun`, `Piwi.RunToCaret`,
`Piwi.FinishRun`, `Piwi.ShowPausedPage` and `Piwi.StopRun`.

- They are under **Tools → Piwi**, and first in the status bar item's menu while a run is live; the item reads
  `Piwi: paused · checkout.page.ts:12` while one is stopped (`Glue.runControlStatus`).
- They are enabled only while they apply (`Glue.runControls`), and act on the stop at the caret's line, else the only
  one, else one chosen in a popup (`Glue.stopsFor`).
- They send `piwi/runControl` on a pooled thread, naming the stop they answer (`since`); an answer with `ok: false` is a
  balloon.
- **Pause the Run** pauses every run of the project. **Stop the Run** ends the process of the ref (`track`, from
  `PiwiCommands.run` and the IDE's Playwright runner). The Run tool window's own toolbar (`RunContentExecutor`'s Rerun,
  Stop and Close) takes no other action.

**Shortcuts.** The actions use the debugger actions' shortcuts, in every keymap (`use-shortcut-of`): Pause and Resume
`Resume`'s (`F9` in the default keymap), Step `StepOver`'s, Run to Caret `RunToCursor`'s, Finish `StepOut`'s. They are
enabled only while they apply, and from the keyboard only while no debug session runs (`ActionPlaces.KEYBOARD_SHORTCUT`,
`XDebuggerManager.debugSessions`), so the debugger keeps its keys. While a run is live, `PiwiRunActionPromoter` (an
`ActionPromoter`) puts them first among the actions a key runs: a keymap that gives the key to another action too (the
VSCode keymaps' `F5`, `Debug`; NetBeans' `F4`, `EditSource`) runs Piwi's while it applies, the other once it does not.

**The paused page.** A stop with no pause bar asks `piwi/pausedPage` and shows the JPEG (`Glue.pausedImageBytes`, at
most `Glue.MAX_IMAGE_DATA`, decoded only within `Glue.decodableImage`) in the **Paused Page** tab of the Piwi tool
window, again at each such stop.

**Breakpoints during a run.** An `XBreakpointListener` sends the breakpoints `PiwiProjectService.breakpoints` gives to
each live run 100 ms after a burst of changes, and the settings page does when the breakpoints checkbox changes. They go
as lines of the run's code (`Glue.runPlaces`): a breakpoint the run was given, known by the `XLineBreakpoint` itself,
keeps its line while it only moved with the edits (`XLineBreakpointImpl.updatePosition` firing `breakpointChanged`);
one added or dragged is mapped back through them. They go only to a run whose places differ from those its command
started with or was last sent (`Glue.breakpointUpdates`, `PiwiCommands.startRun` recording the first).

**A held failure** (`reason: 'failure'`, `Glue.isFailure`) is `Failed · <how it failed> · attempt N`, with
`AllIcons.RunConfigurations.TestError` in the gutter, **Resume** alone among its controls (`Glue.stopControls`), and
`Piwi: failed · checkout.spec.ts:12` in the status bar.

The run control's calls of the service go through `RunRemote`, which `PiwiRunControlTest` replaces.

### Code from a stop

What the service does: [Code from a stop](../../packages/editor/ARCHITECTURE.md#code-from-a-stop) in the editor
service's reference.

**The actions.** A stop also offers the code actions its worker takes (`RunWorker.takes`, `Glue.stopActions`): after
the controls in its inlay, its gutter popup and the status bar item's menu, and under **Tools → Piwi** while some stop
offers them (`StopCodeAction`: `Piwi.PickAtStop`, `Piwi.RecordAtStop`, `Piwi.AssertAtStop`, `Piwi.AssertRegionAtStop`,
`Piwi.MockAtStop`, no shortcut). They are **Pick a Locator**, **Record Here**, **Assert** and **Assert a Region** at a
stop the pause bar shows, **Mock a Request** at any; the inlay names them shorter (`StopLink.inlayLabel`). Each is a
`piwi/stopAction` on a pooled thread naming its stop, its answer a balloon. Mock a Request lists `piwi/stopRequests`
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
  saved), else a warning balloon offers **Copy the Code**.

The block is scrolled to without taking the focus, and its sentence is a balloon, a warning with what its reader should
check (`Glue.stopCodeNotice`).

**The count at the caret.** While a stopped worker counts locators, a `CaretListener` on the multicaster has the end of
the caret's line in the stopped file say how many elements the locator there matches on the stopped page
(`piwi/locatorAtCaret`, an after-line-end inlay, `CaretCountInlay`): asked 200 ms after the caret settles (an
`Alarm`), one request at a time, an answer the caret left dropped, asked again when the caret comes back
(`Glue.CaretAsks`); `3 matches`, `no match`, a refusal for three seconds, nothing on a line holding no locator
(`Glue.caretText`). The caret leaving the file takes the page's outline down.

## Finding Playwright configs

Once the project is open, `PiwiProjectService.findPlaywright` looks for Playwright configs on a pooled thread
(`Glue.findPlaywright`, with the editor service's depth and skipped folders). It searches:

1. the project folder (in Rider, the solution's folder, above `.idea/.idea.<name>`), the folder the IDE guesses and the
   base directories;
2. when those hold none, the Git repository around them.

The tool window, the status bar item and the service wait for the search. The service's workspace folders are the
folders it searched (`createInitializeParams`).

**Searching again.** **Refresh** searches again, and so does `watchConfigs`, a second after the IDE reports one of
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
**Open the Failures** (the tool window) and **Learn More** (`Glue.DOCS_URL`). `PiwiPluginTest` checks the flag.

## Recording

What the service does during a recording: [Recorder](../../packages/editor/ARCHITECTURE.md#recorder) in the editor
service's reference.

### Starting a recording

**Record Here** (`PiwiRecordingActions.kt`) is under **Tools → Piwi**, in the editor's menu, in Alt+Insert's Generate
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
  other typed in), then the plugin sends `piwi/record`; a popup asks for the Playwright project when the answer lists
  `projects`. The choices stay in `PiwiLocalSettings`.
- **A tab closed** while `piwi/record` is pending cancels the recording, in a balloon.

**Record a New Test File…** (also under **New**) creates the spec first, in a config folder. Its name dialog says why
a name is refused (`InputValidatorEx`).

**Recording from a paused test.** A test paused in a run started here can ask to record from there
(`piwi/recordRequested`, `PiwiLsp4jClient.recordRequested`). Its file opens at the paused line and its recording starts
with no dialog, as Record Here's would (`PiwiRecordFlow.recordFromTest`: `piwi/record` with the `handoff`). A recording
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
block again) or **Keep My Edits** (Stop: nothing more is written).

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
from `PasswordSafe`. **Pair with Piwi Picker** copies the pairing address. The handler mirrors
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

**Finding the file.** The handler looks the run's path up under `root`, the Playwright config folders, the project
folder and the content roots (`Glue.candidatePaths`), ranking first the projects connected to the `project` named.
It opens only a file inside an open project, and answers JSON with CORS, so the dashboard knows the file opened.

## Connect

**Connect** (`PiwiConnect.kt`):

1. When the desktop app runs, it first lists the app beside the instance the project names (`Glue.connectChoices`).
2. It asks the instance whether it needs a key.
3. A key comes from the browser sign-in (the device authorization Piwi Picker uses, `/api/extension/connect`) or is
   pasted.
4. Then it asks for the project.

An instance on this machine is tried on every loopback address (`Glue.loopbackAlternatives`), since a server started on
`localhost` may listen on `::1` only. It is never reached through the IDE's proxy, and the address that answered is the
one saved. Connect runs from **Settings → Tools → Piwi** (`PiwiConfigurable.kt`), the tool window's toolbar and
**Tools → Piwi**.

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
grouping, the breakpoints setting, the Playwright runner setting, the run notifications, the coverage marks, the
failure severity, how the agent signs in to Piwi's MCP server, and the baselines.

A project's settings never select another instance's key, and choosing the desktop app never changes the instance, its
project or its key. The old key entry shared by every instance is deleted once (`forgetSharedKey`).

## MCP server configuration

**Copy the MCP Server Configuration** (`CopyMcpConfigurationAction`) writes the servers of `piwi/mcp` as `mcpServers`
entries that run `mcp-remote` (`Glue.mcpConfiguration`), with the key in `env`, never on the command line.

With `PiwiLocalSettings.mcpAuthorization` at `sign-in` (`Glue.MCP_AUTHORIZATIONS`, in the AI Assistant group of the
settings page, sent in `credentials()`), the service hands an instance's server without a key, and `mcp-remote` signs
in through the instance's OAuth. The notification says which (`Glue.mcpAuthorizationNote`).

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

To invoke an action from code, use `ActionManager.tryToExecute`, not `ActionUtil.invokeAction` (no code does either
today).

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
the actions, the edits above a stop and Run to Caret from them, the paused page of a file the VFS has not loaded, the
breakpoint listener (a breakpoint moved as the platform moves one outside tests, which a unit test does not), the
promoter, the runs of the IDE's Playwright runner (a rerun under an ended ref included), the code actions, a failure's
stop, the code a stop made written in one command (one undo, once the service knows the document) and the count at
the caret.
