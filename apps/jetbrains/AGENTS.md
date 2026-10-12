# JetBrains plugin — agent guide

Rules for working inside `apps/jetbrains/` (the Piwi plugin for WebStorm, IntelliJ IDEA Ultimate, Rider and the other
JetBrains IDEs with the LSP API, published as `dev.piwitests.piwi` on the
[JetBrains Marketplace](https://plugins.jetbrains.com/plugin/34674-piwi) by `reusable-publish-jetbrains.yml` on each release
tag). Read [`../../AGENTS.md`](../../AGENTS.md) and [`../../packages/editor/AGENTS.md`](../../packages/editor/AGENTS.md)
first.

## What it is

A Gradle project in Kotlin with the IntelliJ Platform Gradle Plugin; like `apps/desktop`, not an npm workspace. The
build copies the editor service from `packages/editor/dist/` (`npm run editor:build`) into the plugin's `server/`
directory: `piwi-language-server.cjs`, and beside it the recorder's launcher (`piwi-recorder-launcher.cjs`), the
reporter that prints a Playwright project's options (`piwi-use-reporter.cjs`), the recorder's IDE bundle
(`record-ide.js`) and its messages (`record-ide-messages.json`). `buildPlugin`, `runIde` and `verifyPlugin` fail
without one of them; the tests start the language server from `dist/` and need none of the others. The plugin starts
the service through the platform's LSP API with the project's Node.js interpreter, once `node --version` says 20 or
later (`Glue.nodeProblem`): otherwise the start fails with that reason, which `PiwiProjectService.startFailed` keeps
(`startProblem`) and says once, the status bar item reads `Piwi: Node.js` and opens the Node.js settings
(`openNodeSettings`, `settings.nodejs`), after which the service starts again (`restartServer`), as on **Refresh**
while it does not run.

- `PiwiLspServerSupportProvider.kt` registers the service; the LSP client renders its diagnostics, quick fixes and
  hover in open files, and `LspCommandsSupport` runs the client commands it names (`PiwiCommands.kt`; `piwi.desktopJob`,
  from a quick fix or a flaky test's Code Vision line, and the `piwi/desktopJobChanged` notifications, with the share
  button, are there too). The plugin's
  own requests go through the service's lsp4j proxy, which the platform hands only to a request's sender:
  `Lsp4jAccess` takes it from a `sendRequestSync` that sends nothing, never from `getLsp4jServer()` (deprecated, then
  removed by 2026.2). Every status, Code Vision, gutter and tool-window answer depends on it. Its
  `createLspServerWidgetItem` gives the Language Services widget Piwi's icon and the gear that opens the settings.
- `PiwiTestAnnotator.kt` (an external annotator on JavaScript, so on its TypeScript dialects too) draws each test's
  latest result from `piwi/fileSummary`: a gutter icon, the details as its tooltip, the `PIWI_FAILING_TEST`
  background over a failing test, and `PIWI_FAILING_LINE` on the line it failed at, with why as the tooltip; the test's
  background goes around that line, since two backgrounds on a line have no set order (`PiwiColorSettingsPage.kt`,
  defaults in `resources/colorSchemes/`). A test the run in progress runs has `AllIcons.RunConfigurations.TestState.Run`,
  then that run's result. Code Vision skips those lines. The annotator and Code Vision share one `piwi/fileSummary`
  per file and state of its text (`PiwiProjectService.fileSummary`, `Glue.SummaryCache`: asked again after a push from
  the service or five seconds). The open files are drawn again (`DaemonCodeAnalyzer.restart(PsiFile)`, never the
  whole daemon) as `Glue.redraw` says: every file Piwi reads when the run as the files show it changes
  (`Glue.runsInFiles`), only the files whose tests show a result (`showsTests`), at most once a second, when only the
  run's `liveTests` moved, none when only the run in progress moves.
- The rest is native: Code Vision from `piwi/fileSummary`, the status bar from `piwi/runStatus` (with the run in
  progress, `live`), the **Piwi** tool window from `piwi/failures` (the LSP client highlights open files only) with
  the connection from `piwi/status` and the run (`Glue.runHeader`), and the actions under **Tools → Piwi**, all
  available while the IDE indexes (`DumbAware`). The service pushes each of the three answers when it changes
  (`piwi/statusChanged`, `piwi/runStatusChanged`, `piwi/failuresChanged`): `PiwiProjectService` keeps the pushed answer
  as it comes and tells its listeners once on the event thread for the pushes meanwhile. It reads the three whole
  (`refreshStatus`, one read at a time, another asked for meanwhile following it) only when the plugin starts, on
  Refresh and after new credentials; a push that comes during that read wins over it.
- The tool window (`PiwiFailuresToolWindow.kt`) is a `Tree` on a `DefaultTreeModel` of `Glue.failureTree`, the nodes
  VS Code's view has: the run, **Your runs since**, then the failures grouped by file, cluster, owner or flat (the
  toolbar's `ToggleAction`s, kept in `PiwiLocalSettings.failuresGrouping`). A `ColoredTreeCellRenderer` draws a
  failure's title, headline, run (`Glue.failureRunNote`: `your run #N`, `edited since run #N` with the information
  icon, fixed with the passed icon) and place; `TreeSpeedSearch` finds a title. The tree is built again only when
  its nodes changed, from `piwi/failuresChanged` as the edits move them too, keeping the expanded and selected nodes
  by key; when only what the nodes say changed (`Glue.sameShape`, such as the editor's own run counting its tests),
  each row is redrawn in place. The panel is an `OccurenceNavigator`: Next and Previous Occurrence, and the toolbar's
  arrows, go from failure to failure, beside Expand All and Collapse All. Double-click or Enter opens a failure's line,
  or a run's page; the right-click menu
  (`PopupHandler.installPopupMenu`) runs the test, opens the trace, the screenshot or the page, copies the context for
  an agent (`piwi/agentContext`) and, on a CI failure while the desktop app runs, passes it to the app, through
  `PiwiCommands`. **Re-run the Failing Tests** (`Piwi.RerunFailing`, **Tools → Piwi** and the toolbar) runs
  `Glue.rerunFailingArgs`, one run per Playwright config, and **Run This Test** `Glue.failureRunArgs`: both name the
  failure's config (`WorkspaceFailure.root`). **Compare With…** (`Piwi.CompareWith`, **Tools → Piwi** and the toolbar) is a popup of
  `Glue.baselineEntries` (the ladder, each of `RunStatus.branches`, a run by its id through `Messages.showInputDialog`,
  the local runs only) for the context of the file at hand; `PiwiProjectService.setBaseline` keeps the choice in
  `PiwiLocalSettings.baselines` (by root, `Glue.encodeBaseline`, the ladder as no entry), sends `piwi/setBaseline`, and
  `credentials()` sends them all as `baselines`. The header line names it (`Glue.runHeader`). The service
  starts with the first supported file opened (2024.1 has no way to start it without one): until then the status is
  null, and the status bar and tool window say so.
- The status bar item (`PiwiStatusBar.kt`, `Glue.statusView`): a click runs `PiwiProjectService.refreshRun`
  (`piwi/refreshRun` then `refreshStatus`, on a pooled thread, `Piwi: refreshing…` meanwhile), **Refresh** while the
  instance does not answer (`Piwi: unreachable`, `problemKind`, `StatusAction.RETRY`), and Connect while not
  connected. Its tooltip says the same as VS Code's in plain text: the counts, the local runs, the run in progress and
  when the run was read (`Glue.relativeTime`), the baseline (`Glue.baselineLine`), and the reporter version the project
  installs. **Open the Latest Run in the Dashboard** (`Piwi.OpenLatestRun`, under
  **Tools → Piwi** and in the tool window's toolbar) opens the run the status bar shows.
- `PiwiCommands.run` runs a command in the Run tool window, whose **Rerun** (`RunContentExecutor.withRerun`) stops it
  if it runs and starts it again with the same environment; `RunOutputLinks` (`Glue.fileLinks`) links the script paths
  its output names relative to the command's folder to their line, the IDE's console linking the absolute ones. For a test run (`RunCommand.ref`), a `ProcessListener`
  sends `piwi/commandEnded` with the exit code when the process ends; a rerun keeps the ref, by which the service
  recognizes it as the editor's own through the instance's event stream. A `piwi/notice` is a balloon
  (`PiwiCommands.notify`), and so is `piwi/runEnded` (`PiwiCommands.runEnded`, `Glue.runVerdict`), with **Open the
  Failures**, **Open in Dashboard** and, when something fails, **Re-run Failing**, as
  `PiwiLocalSettings.runNotifications` allows (**Settings → Tools → Piwi**: `always`, `failures`, `never`, in
  `.idea/workspace.xml`, on this machine only).
- Breakpoints: `PiwiCommands.runTests` (every test run: Code Vision, **Run this test**, **Run the Tests That Reach
  This File**, **Re-run the Failing Tests**) and **Run Selection…** pass the IDE's breakpoints to the service
  (`PiwiProjectService.breakpoints`: `XDebuggerManager.getInstance(project).breakpointManager.allBreakpoints`, the
  enabled `XLineBreakpoint`s in local files, in a read action, then `Glue.runBreakpoints`: script files under a
  Playwright config's folder), unless the checkbox under **Settings → Tools → Piwi** (`PiwiLocalSettings.breakpoints`,
  on this machine only) turns them off. `PiwiCommands.startRun` adds `PIWI_EDITOR_SEND`, the pairing address
  `PiwiSendHandler` serves with its token from `PasswordSafe` (created if missing), when the command carries
  `PIWI_PAUSE_AT`, and shows `RunCommand.notice` (a reporter too old for breakpoints) once as a warning balloon.
- Once the project is open, `PiwiProjectService.findPlaywright` looks for Playwright configs on a pooled thread
  (`Glue.findPlaywright`, with the editor service's depth and skipped folders): in the project folder (in Rider, the
  solution's folder, above `.idea/.idea.<name>`), the folder the IDE guesses and the base directories, then, when those
  hold none, in the Git repository around them. The tool window, the status bar item and the service wait for it, and
  the service's workspace folders are the folders it searched (`createInitializeParams`). **Refresh** searches again,
  and so does `watchConfigs`, a second after the IDE reports a config created, removed, renamed or moved
  (`Glue.isPlaywrightConfig`, every name Playwright reads one from, `.mts` and `.cts` included), or such a folder where
  configs are searched (`Glue.mayHoldConfigs`): the IDE reports a new folder without the files in it.
- **Recording** (`PiwiRecordingActions.kt`): **Record Here** (**Tools → Piwi**, the editor's menu, Alt+Insert's
  Generate menu, and Alt+Enter through `RecordHereIntention.kt`) asks
  `piwi/pageCandidates` where the caret is: outside every test, function and class a new test, anywhere else the
  steps there, which the service refuses where they cannot go (`Glue.recordInto`); without an answer, nothing starts.
  **Record a New Test File…** (also under **New**) creates the spec first. A dialog asks for the start page and the
  page expression (the candidates, the default first, any other typed in), then `piwi/record`, and a popup for the
  Playwright project when it answers with `projects`; the choices stay in `PiwiLocalSettings`.
- `PiwiRecording.kt` holds the recording sessions (`PiwiRecordings`) and applies `piwi/recordingChanged` on the event
  thread: the first update writes the recorded block where `RecordResult.placement` says, on the line it names in the
  text the service read, followed through the changes made since `piwi/record` was sent (`DocumentChanges`,
  `Glue.followLineStart`, `Glue.firstBlockWrite`; a block on the file's last line keeps its final line break). Each
  later one replaces it whole (`Glue.recordedBlock`) with the import lines the file lacks after its imports in the same
  command (`Glue.importInsertion`: the service sends only the lines whose names the file does not bind, and a line the
  file holds as written is left out), and range markers follow it; Enter at the end of its last line is below it. The
  block is tinted with `PIWI_RECORDING_BLOCK`, with a gutter mark offering Stop, Pause and Resume; its warnings are
  weak warnings on their lines (`PiwiRecordingAnnotator`), kept after Stop until their line changes; the banner over
  the file (`PiwiRecordingNotificationProvider`, `PiwiRecordingViews.kt`) shows the state, the step count and the
  actions, and the status bar item shows them too, a click going to the block (`Glue.recordingStatus`). The service
  says `paused` in an update for a pause from here or from the browser's bar; the client shows one from here at once.
  An edit inside the block pauses the recording
  (`piwi/recordingCommand`) with **Resume** (the service sends the block again) or **Keep My Edits** (Stop: nothing
  more is written). Closing the file or the project stops its sessions; a service that stops ends them with a last
  update, and Stop ends one at once when the service does not answer. One undo step: a `StartMarkAction` in a command
  of its own just before the first write, a `FinishMarkAction` at the end, so one Undo after Stop goes back to before
  the recording, edits made in the file meanwhile included; `PiwiRecordingTest` drives it with synthetic updates, the
  caret moving between writes.
- `PiwiSendHandler.kt` is the Send to editor endpoint: `POST /api/piwi/send` on the IDE's built-in server, with the
  token from `PasswordSafe`; **Pair with Piwi Picker** copies the pairing address. It mirrors
  `@piwitests/core/editor-send` (`Glue.parseSendPayload`, `Glue.sendAuthorized`). A locator with `at`, picked while a
  run was paused at a breakpoint, asks `piwi/applyPick` and replaces the range it answers in a write command; when the
  line holds no locator, it is inserted at the caret, and the balloon says why (`Glue.pickNotice`). A recorded flow goes through
  `piwi/renderSteps` with the caret, for its page expression, and its import lines apart, added like a recording's.
- `PiwiOpenHandler.kt` is the dashboard's Open in IDE: `GET /api/piwi/open?file=…&line=…&column=…[&root=…][&check]` on
  the built-in server, a `RestService`. It answers only a page whose `Origin` is the Piwi instance an open project is
  connected to (its settings, `PIWI_DASHBOARD_URL` in the environment or in a Playwright config folder's `.env`, the
  instances the editor service reports) or the desktop app, and an instance's page finds files only in the projects
  connected to it; `OpenOrigins.kt` is the pure half. Every other request for the path gets a 403 from the handler
  itself, whatever the platform's origin rules or **Allow unsigned requests** trust, and the first refused page of the
  session is named in a notification. It looks the run's path up under the Playwright config folders, the project folder
  and the content roots (`Glue.candidatePaths`), opens only a file inside an open project, and answers JSON with CORS so
  the dashboard knows it opened. The dashboard side is `useOpenInIde` / `ide-links.ts` in `apps/application`; a change
  to the query or the answer changes both.
- `Protocol.kt` mirrors `packages/editor/src/protocol.ts` for lsp4j; `Glue.kt` is the pure half, tested without an IDE.
- **Connect** (`PiwiConnect.kt`) asks the instance whether it needs a key, then signs in with the browser (the device
  authorization Piwi Picker uses, `/api/extension/connect`) or takes a pasted key, then the project. When the desktop
  app runs, it first lists the app beside the instance the project names (`Glue.connectChoices`). An instance on this
  machine is tried on every loopback address (`Glue.loopbackAlternatives`: a server started on `localhost` may listen
  on `::1` only), never through the IDE's proxy, and the address that answered is saved. It runs from
  **Settings → Tools → Piwi** (`PiwiConfigurable.kt`), the tool window's toolbar and **Tools → Piwi**.
- `PiwiProjectService.desktop()` asks the service (`piwi/desktop`) and, while the service has not started, reads the
  app's discovery file itself (`Glue.parseDesktopDiscovery`, `Glue.linkedDesktopProject`): Connect finds the app
  before any file is opened.
- The instance URL and project live in `.idea/piwi.xml`; the API key in the IDE's `PasswordSafe`, **per instance**
  (`Glue.apiKeyEntry`): a project's settings, which a repository may commit, never select another instance's key. The
  choice of the desktop app and its project, and a recording's choices, live in `.idea/workspace.xml`
  (`PiwiLocalSettings`, with the failures' grouping, the breakpoints setting, the run notifications and the
  baselines), on this machine only;
  choosing the app never touches the instance, its project or its key.

## Rules

- **The oldest supported platform is 2024.1** (`pluginSinceBuild=241`): the first whose LSP API sends requests
  through the server (`sendRequestSync`) and lists servers in the Language Services widget. Compile against it;
  `verifyPlugin` checks the latest WebStorm, IntelliJ IDEA Ultimate and Rider too (CI verifies on 2024.1 and the
  latest WebStorm for a pull request, on every IDE on `main`). An API newer than 2024.1 is looked
  up at run time or not used. Its test framework is pinned (`platformTestFrameworkVersion`: it is published with
  IntelliJ IDEA's build numbers, just after WebStorm's), and the test sandbox disables the Swagger plugin, whose test
  service ships with its own tests only.
- **An API deprecated on the newest platform is replaced by one 2024.1 has too**: the Marketplace's Plugin Verifier
  counts every use. `Application.runReadAction(Computable)` rather than `ReadAction.compute`,
  `ActionManager.tryToExecute` rather than `ActionUtil.invokeAction`, a `SimpleListCellRenderer` subclass rather than
  its `create`, `PiwiCredentials.attributes` (Java, so it binds to the one-argument constructor) rather than
  `CredentialAttributes(…)` in Kotlin. What stays has no replacement in 2024.1: the LSP API, renamed in 2026.3
  (`LspServer` → `LspClient`, `LspServerSupportProvider` → `LspIntegrationProvider`, `LspServerManager` →
  `LspClientManager`, `…ServerDescriptor` → `…ClientDescriptor`, `lspCommandsSupport` →
  `lspCustomization.commandsCustomizer`), and `DaemonCodeAnalyzer.restart(PsiFile)` (2026.x adds the reason
  `restart(PsiFile, Object)` takes). Kotlin compiles without its
  compatibility bridges (`jvmDefault`), each of which the verifier counts as a use of the default method it calls.
- **No logic the VS Code extension would need too.** A new feature is a service request first.
- **Nothing blocks the event thread, and nothing in a read action waits on the service without giving way**: the daemon
  (Code Vision) waits with `awaitCancellably`, which a write action cancels, `orNull` waits the same way (a task's
  Cancel stops it), and reads of the disk and of the password safe run on a pooled thread.
- **A push from the service is never answered with a read of the same answer**, and the files are drawn again with
  `DaemonCodeAnalyzer.restart(PsiFile)` for the files a change shows in, never with the whole daemon's `restart()`.
- A change to `protocol.ts` updates `Protocol.kt` in the same change.
- **The plugin loads and unloads without a restart** (no `require-restart`, and the verifier says it can be enabled or
  disabled without one): the platform stops the editor service with the LSP provider and runs `PiwiStartupActivity`
  for the projects already open; every listener has a project service as parent, the work a service queues expires
  with it (`gone`: the service disposed, not only its project), and work that may outlive the plugin, such as a run's
  end, reaches the service with `getServiceIfCreated`, never `project.service<…>()`. No application component, no
  thread of the plugin's own.

## Workflow

```bash
npm run editor:build -w packages/editor   # from the repository root: the bundle the plugin ships
./gradlew test                     # unit tests of Glue.kt, and platform tests on WebStorm 2024.1
./gradlew buildPlugin              # build/distributions/piwi-jetbrains-<version>.zip
./gradlew verifyPlugin             # the Plugin Verifier on `verifyIdes` (gradle.properties; -PverifyIdes=WS:2024.1 for one)
./gradlew runIde                   # a sandboxed WebStorm with the plugin
```

**The JDK.** Gradle runs on the JDK 21 that `gradle/gradle-daemon-jvm.properties` names, whatever `JAVA_HOME` points to
(the wrapper starts on JDK 11 or later), and the build compiles with a JDK 21 toolchain (`jvmToolchain(21)`). When the
machine has no JDK 21, the foojay resolver in `settings.gradle.kts` downloads one into `~/.gradle/jdks`. Moving to
another JDK changes both: `./gradlew updateDaemonJvm --jvm-version=<n>` regenerates the file, and `jvmToolchain` follows
in `build.gradle.kts`. CI (`reusable-jetbrains.yml`) installs JDK 21, so it downloads nothing.

The platform test `testTheBundledServiceAnswersThroughTheDescriptor` starts the bundled service with the descriptor's
command line against a stub instance, and reads its answers with the Kotlin protocol classes.
