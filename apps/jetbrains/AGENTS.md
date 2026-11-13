# JetBrains plugin: agent guide

Rules for working inside `apps/jetbrains/`: the Piwi plugin for WebStorm, IntelliJ IDEA Ultimate, Rider and the other
JetBrains IDEs with the LSP API, published as `dev.piwitests.piwi` on the
[JetBrains Marketplace](https://plugins.jetbrains.com/plugin/34674-piwi) by `reusable-publish-jetbrains.yml` on each
release tag. It is a Gradle project in Kotlin, not an npm workspace, and a thin client of the editor service. Read
[`../../AGENTS.md`](../../AGENTS.md) and [`../../packages/editor/AGENTS.md`](../../packages/editor/AGENTS.md) first. How
each feature works is in [`ARCHITECTURE.md`](ARCHITECTURE.md); the protocol is in
[`packages/editor/ARCHITECTURE.md`](../../packages/editor/ARCHITECTURE.md#protocol).

## Rules

### Platform

- **The oldest supported platform is 2024.1 (`pluginSinceBuild=241`): compile against it.** An API newer than 2024.1 is
  looked up at run time or not used. `verifyPlugin` also checks the latest WebStorm, IntelliJ IDEA Ultimate and Rider.
  ([Platform compatibility](ARCHITECTURE.md#platform-compatibility))
- **No internal API** (`@ApiStatus.Internal`, such as `LspServerManager.addLspServerManagerListener`). The Marketplace
  refuses an upload that uses one, and `verifyPlugin` fails on it (`INTERNAL_API_USAGES` in `build.gradle.kts`).
- **An API deprecated on the newest platform is replaced by one that 2024.1 has too.** The Plugin Verifier counts every
  use. The replacements in use, and the deprecated APIs that stay because 2024.1 has no replacement (the LSP API,
  `DaemonCodeAnalyzer.restart(PsiFile)`), are listed in
  [Platform compatibility](ARCHITECTURE.md#platform-compatibility).
- **Kotlin compiles without its compatibility bridges** (`jvmDefault` set to `NO_COMPATIBILITY`). The verifier would
  count each bridge as a use of the default method it calls.
- **The plugin loads and unloads without a restart** (no `require-restart`). Every listener has a project service as
  parent, queued work expires with the service (`gone`), and work that may outlive the plugin reaches the service with
  `getServiceIfCreated`, never `project.service<…>()`.
  ([Dynamic plugin loading](ARCHITECTURE.md#dynamic-plugin-loading))
- **No application component and no thread of the plugin's own.**

### Service and protocol

- **No logic the VS Code extension would need too.** A new feature starts as a service request.
- **A change to `protocol.ts` updates `Protocol.kt` in the same change.** `Protocol.kt` mirrors
  `packages/editor/src/protocol.ts` for lsp4j; `testTheBundledServiceAnswersThroughTheDescriptor` (`PiwiPluginTest`)
  reads the bundled service's answers with it.
- **A change to `@piwitests/core/editor-send` or `@piwitests/core/editor-discovery` updates `Glue.kt` in the same
  change.** `Glue.parseSendPayload`, `Glue.sendAuthorized` and `Glue.editorTokenProof` mirror the first,
  `Glue.parseEditorDiscovery` and `Glue.liveHubs` the second; `GlueTest` checks them.
  ([Send to editor](ARCHITECTURE.md#send-to-editor))
- **An action id is frozen at 1.0: keymaps name it.** Renaming one breaks users' keymaps, and a new one is registered in
  D25 of `proposals/1.0-stabilization.md` in the same change
  (`apps/application/tests/unit/editor-ids-register.test.ts`).
- **The run controls reach the service only through `RunRemote`**, which `PiwiRunControlTest` replaces.
  ([Run control](ARCHITECTURE.md#run-control))
- **Every request of the plugin's own goes through `piwiServer()`, whose proxy writes its failure in the Log tab**
  (`PiwiLog.logged`). Checked by `PiwiPluginTest` (`testTheLogTabShowsTheServicesLogAndTheRequestsThatFailed`).
  ([The log](ARCHITECTURE.md#the-log))
- **The plugin's own requests go through `Lsp4jAccess`, never `getLsp4jServer()`** (deprecated, then removed by
  2026.2). `Lsp4jAccess` takes the lsp4j proxy from a `sendRequestSync` that sends nothing; `Lsp4jAccessTest` checks
  it. ([LSP integration](ARCHITECTURE.md#lsp-integration))
- **A push from the service is never answered with a read of the same answer.** `PiwiProjectService` keeps each pushed
  answer, and reads the three answers whole only at start, on Reload Piwi, on Refresh the latest run and after new
  credentials (`refreshStatus`). ([Native views and pushes](ARCHITECTURE.md#native-views-and-pushes))
- **Open files are drawn again with `DaemonCodeAnalyzer.restart(PsiFile)`, and only those a change shows in, never
  with the whole daemon's `restart()`** (`Glue.redraw`).
  ([Test results in the editor](ARCHITECTURE.md#test-results-in-the-editor))
- **Nothing starts in an untrusted project.** In safe mode (`PiwiProjectService.trusted`), the plugin starts no editor
  service, runs no command (`PiwiCommands.run`, `startRun`) and reads no `.env` for Open in IDE.
  ([Untrusted projects](ARCHITECTURE.md#untrusted-projects))

### Threads

- **Nothing blocks the event thread, and nothing in a read action waits on the service without giving way.** The daemon
  waits with `awaitCancellably`, which a write action cancels, and reads of the disk and of the password safe run on a
  pooled thread. ([Threading](ARCHITECTURE.md#threading))
- **The built-in server's I/O thread touches neither the password safe nor the disk.** `PiwiSendHandler` answers only a
  preflight without a challenge there and serves every other request, `GET /api/piwi/live` included, on a pooled
  thread; `PiwiOpenHandler` reads the addresses each project last read (`PiwiProjectService.knownAddresses`, filled by
  `readKnownAddresses`), and only the writes run on the event thread.
  ([Send to editor](ARCHITECTURE.md#send-to-editor))
- **Every action and view stays available while the IDE indexes** (`DumbAware`).

### Settings and security

- **The API key lives in the IDE's `PasswordSafe`, per instance** (`Glue.apiKeyEntry`). A project's settings
  (`.idea/piwi.xml`), which a repository may commit, never select another instance's key.
  ([Settings and secrets](ARCHITECTURE.md#settings-and-secrets))
- **Choices made on this machine live in `.idea/workspace.xml`** (`PiwiLocalSettings`). Choosing the desktop app never
  changes the instance, its project or its key.
- **A text from a run never renders as HTML, and an image from a run is sized before it is decoded.** Labels set
  `html.disable`, and a tooltip goes through `Glue.htmlTooltip`, which escapes it: the platform renders every
  component's tooltip as HTML. A filmstrip image is decoded only once its JPEG header names a size within twice a
  thumbnail's (`Glue.stripImageBytes`). Checked by `GlueTest` and `PausedPagePanelTest`.
- **Open in IDE answers only a page of a known origin**: the Piwi instance an open project is connected to, the
  desktop app, or the `PIWI_DASHBOARD_URL` of the IDE's environment (which reaches every open project). An instance's
  page finds files only in the projects connected to it. Every other request gets a 403 from `PiwiOpenHandler` itself (`OpenOrigins.kt`, `OpenOriginsTest`,
  `PiwiOpenHandlerTest`); a change to its query or answer changes the dashboard's `useOpenInIde` and `ide-links.ts` in
  `apps/application` too. ([Open in IDE](ARCHITECTURE.md#open-in-ide))
- **A debug request (`debug=1` on `/api/piwi/open`) runs nothing until the person clicks **Debug** in a notification,
  and names files, a line and a title, never a command.** `Glue.parseOpenRequest` checks each field and refuses one
  given twice, `PiwiOpenHandler` checks both files again by their canonical paths (`Glue.debugFileRefusal`), and the
  service builds the run. Checked by `GlueTest`. ([Open in IDE](ARCHITECTURE.md#open-in-ide))
- **The Send to editor endpoint proves it holds the token on every answer to a challenge, and `GET /api/piwi/live`
  lists hubs only, never a run channel's token.** `isOriginAllowed` allows an extension's origin on `/api/piwi/send`
  and `/api/piwi/live` alone, and leaves the platform's `isAccessible` its check of `Host`. Checked by `PiwiPluginTest`
  (`testPiwiPickersChallengeAloneIsAnsweredWithTheProofOnTheLiveEndpoint`,
  `testPiwiPickerListsTheLiveHubsThroughThePairing`). ([Send to editor](ARCHITECTURE.md#send-to-editor))
- **The runs' MCP server's token lives in the `PasswordSafe`, one per project, and a stop's browser is shared only
  after the person said yes to `Glue.SHARE_WARNING`, every time.** The service gets the token in its initialization
  options (`agentsOptions`), never in `.idea/workspace.xml`, and a token it answers or tells (`piwi/agentsChanged`)
  replaces the one kept (`agentsHeard`); no agent can share a browser (`piwi/stopBind` is the IDE's). Checked by
  `PiwiRunControlTest`. ([MCP server configuration](ARCHITECTURE.md#mcp-server-configuration))
- **A run is shared live on the team instance only from the person's action, after `Glue.shareLiveWarning` the first
  time in the project since it opened**, as the VS Code extension does (`PiwiRunSessions.shareLive`); only a run known
  not to be shareable is asked without it, for the service to say why. Every Stop sharing asks first
  (`confirmStopSharing`). Checked by `PiwiRunControlTest`
  (`testARunIsSharedLiveOnlyOnceThePersonSaidYesTheFirstTime`, `testARunNotHeardOfYetIsWarnedOfBeforeItIsShared`,
  `testTheStatusBarsMenuOnAShareOpensCopiesAndStopsAfterAsking`) and `GlueTest`.
- **An `mcp-remote` entry runs one exact release over HTTP alone** (`Glue.MCP_REMOTE`, `--transport http-only`), for
  the instance's servers and the runs' alike. Checked by `GlueTest`.
- **An instance on this machine is never reached through the IDE's proxy.** Connect tries every loopback address
  (`Glue.loopbackAlternatives`) and saves the one that answered. ([Connect](ARCHITECTURE.md#connect))

### Features

- **The IDE's Playwright runner is reached only after `PlaywrightRunnerGate.available()`**, which names none of the
  runner's classes: they belong to the `JavaScript` plugin.
  ([Playwright runner](ARCHITECTURE.md#playwright-runner))
- **The default chords are the VS Code extension's** (`$default` keymap): `Ctrl+Alt+Shift+R` records and stops a
  recording, `Ctrl+Alt+Shift+F` re-runs the failing tests and `Ctrl+Alt+Shift+K` runs the test at the caret.
  `PiwiPluginTest` checks the R and F bindings; the platform's own keymaps leave them free except on macOS, and some
  plugins and keymaps use them ([`apps/vscode/ARCHITECTURE.md`](../vscode/ARCHITECTURE.md#keybindings)).
- **The run controls use the debugger actions' shortcuts (`use-shortcut-of`), and give way to the debugger where it
  takes the key.** From the keyboard, Resume, Step, Run to caret and Finish give way to a suspended debug session, Pause
  to a running one, Stop to any (`givesWayTo`); `PiwiRunActionPromoter` puts them first only while a run is live.
  Checked by `PiwiRunControlTest`. ([Run control](ARCHITECTURE.md#run-control))
- **A control names the stop it answers, and a line sent for a run is a line of the run's code.** Each control at a
  stop passes the stop's `since` (End the test while a Pause waits, `give-up`, answers none); Run to caret and the breakpoints map the editor's lines back through `Glue.EditLog`
  (`Glue.runPlaces` for the breakpoints). Checked by `GlueTest` and `PiwiRunControlTest`.
  ([Run control](ARCHITECTURE.md#run-control))
- **A new stop takes the focus only on the worker slot the person is on (the last to take the focus, or acted on: a
  control, a code action, a press, key or pick on the Paused page, never a pointer moving; never one only watched), or
  while no other held stop's file was opened or left closed and no Step or Run to caret from the IDE waits,
  `Glue.RESERVED_MILLIS` at most. While an editor is in use, any other stays closed (2024.1 opens no file without
  selecting it), counts as opened and is listed in the status bar item's menu. The Paused page tab keeps a held stop,
  then waits as long for the stepped slot, and is selected unless the Worker tab is in sight.** `Glue.StopsShown`
  decides (a refusal, `ok: false`, undoing what nothing changed since), with `Glue.selectsPausedPage`, and
  `PiwiRunSessions.draw` opens, drawing again as a wait ends (an `Alarm`), after a refusal and after acting that ends a
  wait, as in the VS Code extension; checked by `GlueTest`, fed the pushes the service sends.
  ([Run control](ARCHITECTURE.md#run-control))
- **An action at a stop from a key or a menu acts, for a control within `Glue.RESUMED_MILLIS` of an answer, until
  another stop of that slot opens or its run holds the slot no more, on a stop of the answered slot or on none, whatever
  the caret says; else on the stop at the caret's line; else on the only stop whose file or page the person was shown;
  else it asks** (`Glue.StopsShown.choose`, `PiwiRunSessions.atCaret`), as in the VS Code extension. Checked by
  `GlueTest`. ([Run control](ARCHITECTURE.md#run-control))
- **The code a stop makes is written in one `WriteCommandAction` in an editor, once the service knows the document,
  and only into the version the service placed it in.** A file no editor shows is opened first and written once its
  `LspServer.getDocumentVersion` is known (`whenOpened`, an `Alarm` on the event thread, three seconds at most), so the
  platform sends the service the change; checked by `PiwiRunControlTest` (`testTheCodeAStopMadeIsWrittenInOneCommand`).
  ([Code from a stop](ARCHITECTURE.md#code-from-a-stop))
- **The running line's inlay goes as its test ends or stops, as the run ends and as the watch does, whatever the
  service says after** (`Glue.runningLinesShown`, drawn on every draw). Checked by `GlueTest` and `PiwiRunControlTest`
  (`testTheRunningLineIsMarkedUntilTheTestEndsOrStops`, `testARunningLineOfASlotNoLongerWatchedIsNotTaken`).
  ([Run control](ARCHITECTURE.md#run-control))
- **The Worker tab's watch goes on while the Worker tab or the Page tab is in sight, and ends once neither is**
  (`laneSightChanged`). Checked by `PiwiRunControlTest` (`testThePageTabKeepsTheWatchWhileItShows`).
  ([Run control](ARCHITECTURE.md#run-control))
- **A rerun under the ref of a run that ended maps its lines from when it is first heard**, never from the ended run's
  start. Checked by `PiwiRunControlTest` (`testARerunUnderTheRefOfARunThatEndedMapsItsLinesFromItsOwnStart`).
  ([Run control](ARCHITECTURE.md#run-control))
- **A run started in a terminal has the controls but Stop, and starts with the IDE's breakpoints**
  (`piwi/setBreakpoints`, sent as they change). Checked by `PiwiRunControlTest`
  (`testARunStartedInATerminalTakesTheBreakpointsAndEndsThere`). ([Run control](ARCHITECTURE.md#run-control))
- **Every run of a Playwright run configuration Piwi made is followed** (`PiwiRunSessions.followRunner`), its Rerun,
  Rerun Failed Tests and Debug included, so Stop ends it and the service hears its end. Checked by
  `PiwiRunControlTest`. ([Playwright runner](ARCHITECTURE.md#playwright-runner))
- **The Run tool window's Rerun starts the command again only once the service heard its end** (`PiwiCommands.run`),
  so the rerun's workers start a session of their own.
  ([Commands and notifications](ARCHITECTURE.md#commands-and-notifications))
- **One undo step per recording.** A `StartMarkAction` in a command of its own just before the first write, and a
  `FinishMarkAction` at the end, so one Undo after Stop goes back to before the recording; `PiwiRecordingTest` checks
  it. ([Pause, Stop and undo](ARCHITECTURE.md#pause-stop-and-undo))
- **Every action but a toggle draws its concept's platform icon, one with a New UI glyph on 2024.1, or is listed as
  waiting for Piwi's glyph.** The concepts are Appendix A of `proposals/editor-ux-coherence.md`; the failed mark, Open in
  dashboard, the hand-offs and the stop's code actions drawn in code come from `PiwiIcons`. Checked by `PiwiPluginTest`
  (`testEveryActionHasAnIconButTogglesAndThoseWaitingForPiwisGlyph`); the New UI glyph, by hand.
- **Every label is in sentence case, as the VS Code extension's**: actions, buttons, dialog and popup titles, tabs and
  settings groups ("Open the run page"), a capital only first or in a proper noun (Piwi, Piwi Picker, Playwright, MCP,
  Claude Code, Cursor, Node.js, CI). The platform's own names keep theirs (Settings → Tools, Run to Cursor). Checked
  for actions by `PiwiPluginTest` (`testEveryActionsTextIsInSentenceCase`).
- **`Glue.kt` is the pure half, tested without an IDE** (`GlueTest`). Put logic that needs no platform API there.

## Workflow

```bash
npm run editor:build -w packages/editor   # from the repository root: the files the plugin ships
./gradlew test                     # from apps/jetbrains/: unit tests, and platform tests on WebStorm 2024.1
./gradlew buildPlugin              # build/distributions/piwi-jetbrains-<version>.zip
./gradlew verifyPlugin             # the Plugin Verifier on `verifyIdes` (gradle.properties; -PverifyIdes=WS:2024.1 for one)
./gradlew runIde                   # a sandboxed WebStorm 2024.1 with the plugin
```

- **`buildPlugin`, `runIde` and `verifyPlugin` fail without the editor service's files in `packages/editor/dist/`**
  (`prepareSandbox`); the tests need only `piwi-language-server.cjs`. ([Build](ARCHITECTURE.md#build))
- **Change notes**: the Marketplace's What's new is filled at publish time from the `ide` entries of the root
  `CHANGELOG.md` (`CHANGE_NOTES`), so a commit with the `ide` scope is what puts a line in it.
  ([Change notes](ARCHITECTURE.md#change-notes))
- **Screenshots**: `scripts/take-screenshots.mjs` recaptures `apps/docs/public/screenshots/jetbrains-*.png` in the
  latest WebStorm release, on the VS Code extension's fixture project.
  ([Screenshots](ARCHITECTURE.md#screenshots))
- **The JDK**: the Gradle daemon runs on the JDK 21 that `gradle/gradle-daemon-jvm.properties` names, and the build
  compiles with `jvmToolchain(21)`; moving to another JDK changes both. ([The JDK](ARCHITECTURE.md#the-jdk))

## Source map

All under `src/main/kotlin/dev/piwitests/jetbrains/` unless noted.

- `PiwiLspServerSupportProvider.kt`: registers the service, starts it (`PiwiLspServerDescriptor`), holds `Lsp4jAccess`
  and receives the service's notifications (`PiwiLsp4jClient`).
- `PiwiProjectService.kt`: one project's state: the pushed answers, the configs found, the credentials, the settings.
- `Protocol.kt`: the protocol for lsp4j. `Glue.kt`: the pure half.
- `PiwiTestAnnotator.kt`, `PiwiCodeVisionProvider.kt`, `PiwiCoverageMarks.kt`: what the editor shows on a file.
- `PiwiFailuresToolWindow.kt`, `PiwiStatusBar.kt`: the **Piwi** tool window and the status bar item.
- `PiwiCommands.kt`, `PiwiActions.kt`, `PiwiPlaywrightRunner.kt`: the commands, the actions under **Tools → Piwi**, the
  IDE's Playwright runner.
- `PiwiRunControl.kt`: the run controls (`PiwiRunSessions`: the stops, the execution point, the inlay, the paused
  page, the Worker tab, the actions and `PiwiRunActionPromoter`), and the code from a stop (`StopCodeAction`,
  `CaretCountInlay`). `PiwiCiRuns.kt`: the CI runs of the branch, read-only (the CI run tab, the CI positions).
- `PiwiRecordingActions.kt`, `PiwiRecording.kt`, `PiwiRecordingViews.kt`, `RecordHereIntention.kt`: recording.
- `PiwiSendHandler.kt`, `PiwiOpenHandler.kt`, `OpenOrigins.kt`: the built-in server's endpoints.
- `PiwiConnect.kt`, `PiwiConfigurable.kt`, `PiwiColorSettingsPage.kt`: Connect and the settings pages.
- `PiwiLog.kt`: the editor service's log and the tool window's **Log** tab.
- `src/main/java/…/PiwiCredentials.java`: credential attributes built from Java. `src/main/resources/`: `plugin.xml`,
  color schemes, icons.
- `src/test/kotlin/…`: the unit tests (`GlueTest`, `OpenOriginsTest`, `Lsp4jAccessTest`) and the platform tests
  (`PiwiPluginTest`, `PiwiRecordingTest`, `PiwiOpenHandlerTest`, `PiwiRunControlTest`, `PausedPagePanelTest`).
- `scripts/`: the screenshots script and `xinput.py`.

## ARCHITECTURE.md sections

- [Build](ARCHITECTURE.md#build) and [Starting the service](ARCHITECTURE.md#starting-the-service): the bundled service,
  Node.js, the proxy, restarts, untrusted projects.
- [LSP integration](ARCHITECTURE.md#lsp-integration),
  [Native views and pushes](ARCHITECTURE.md#native-views-and-pushes): how the plugin talks to the service.
- [Test results in the editor](ARCHITECTURE.md#test-results-in-the-editor),
  [Coverage marks](ARCHITECTURE.md#coverage-marks), [Tool window](ARCHITECTURE.md#tool-window),
  [Status bar](ARCHITECTURE.md#status-bar): before changing what one of them shows.
- [Runs](ARCHITECTURE.md#runs): the Playwright runner, the Run tool window, the test at the caret, breakpoints, the
  run control (stops, their actions and shortcuts, the paused page) and the code from a stop.
- [Finding Playwright configs](ARCHITECTURE.md#finding-playwright-configs): the search and the first-run notification.
- [Recording](ARCHITECTURE.md#recording): starting a recording, writing the block, warnings, undo.
- [Send to editor](ARCHITECTURE.md#send-to-editor), [Open in IDE](ARCHITECTURE.md#open-in-ide),
  [Connect](ARCHITECTURE.md#connect), [Settings and secrets](ARCHITECTURE.md#settings-and-secrets),
  [MCP server configuration](ARCHITECTURE.md#mcp-server-configuration).
- [The log](ARCHITECTURE.md#the-log): what the Log tab holds and where each line comes from.
- [Platform compatibility](ARCHITECTURE.md#platform-compatibility), [Threading](ARCHITECTURE.md#threading),
  [Dynamic plugin loading](ARCHITECTURE.md#dynamic-plugin-loading): the detail behind the platform rules.
- [Change notes](ARCHITECTURE.md#change-notes), [Screenshots](ARCHITECTURE.md#screenshots),
  [The JDK](ARCHITECTURE.md#the-jdk), [Tests](ARCHITECTURE.md#tests): publishing, the build and the test suites.
