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
- **The plugin's own requests go through `Lsp4jAccess`, never `getLsp4jServer()`** (deprecated, then removed by
  2026.2). `Lsp4jAccess` takes the lsp4j proxy from a `sendRequestSync` that sends nothing; `Lsp4jAccessTest` checks
  it. ([LSP integration](ARCHITECTURE.md#lsp-integration))
- **A push from the service is never answered with a read of the same answer.** `PiwiProjectService` keeps each pushed
  answer, and reads the three answers whole only at start, on Refresh, on the status bar's click and after new
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
- **The built-in server's I/O thread touches neither the password safe nor the disk.** `PiwiSendHandler` serves each
  request on a pooled thread, and `PiwiOpenHandler` reads the addresses each project last read
  (`PiwiProjectService.knownAddresses`, filled by `readKnownAddresses`); only the writes run on the event thread.
- **Every action and view stays available while the IDE indexes** (`DumbAware`).

### Settings and security

- **The API key lives in the IDE's `PasswordSafe`, per instance** (`Glue.apiKeyEntry`). A project's settings
  (`.idea/piwi.xml`), which a repository may commit, never select another instance's key.
  ([Settings and secrets](ARCHITECTURE.md#settings-and-secrets))
- **Choices made on this machine live in `.idea/workspace.xml`** (`PiwiLocalSettings`). Choosing the desktop app never
  changes the instance, its project or its key.
- **Open in IDE answers only a page of a known origin**: the Piwi instance an open project is connected to, or the
  desktop app. Every other request gets a 403 from `PiwiOpenHandler` itself (`OpenOrigins.kt`, `OpenOriginsTest`,
  `PiwiOpenHandlerTest`); a change to its query or answer changes the dashboard's `useOpenInIde` and `ide-links.ts` in
  `apps/application` too. ([Open in IDE](ARCHITECTURE.md#open-in-ide))
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
- **One undo step per recording.** A `StartMarkAction` in a command of its own just before the first write, and a
  `FinishMarkAction` at the end, so one Undo after Stop goes back to before the recording; `PiwiRecordingTest` checks
  it. ([Pause, Stop and undo](ARCHITECTURE.md#pause-stop-and-undo))
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
- `PiwiRecordingActions.kt`, `PiwiRecording.kt`, `PiwiRecordingViews.kt`, `RecordHereIntention.kt`: recording.
- `PiwiSendHandler.kt`, `PiwiOpenHandler.kt`, `OpenOrigins.kt`: the built-in server's endpoints.
- `PiwiConnect.kt`, `PiwiConfigurable.kt`, `PiwiColorSettingsPage.kt`: Connect and the settings pages.
- `src/main/java/…/PiwiCredentials.java`: credential attributes built from Java. `src/main/resources/`: `plugin.xml`,
  color schemes, icons.
- `src/test/kotlin/…`: the unit tests (`GlueTest`, `OpenOriginsTest`, `Lsp4jAccessTest`) and the platform tests
  (`PiwiPluginTest`, `PiwiRecordingTest`, `PiwiOpenHandlerTest`).
- `scripts/`: the screenshots script and `xinput.py`.

## ARCHITECTURE.md sections

- [Build](ARCHITECTURE.md#build) and [Starting the service](ARCHITECTURE.md#starting-the-service): the bundled service,
  Node.js, the proxy, restarts, untrusted projects.
- [LSP integration](ARCHITECTURE.md#lsp-integration),
  [Native views and pushes](ARCHITECTURE.md#native-views-and-pushes): how the plugin talks to the service.
- [Test results in the editor](ARCHITECTURE.md#test-results-in-the-editor),
  [Coverage marks](ARCHITECTURE.md#coverage-marks), [Tool window](ARCHITECTURE.md#tool-window),
  [Status bar](ARCHITECTURE.md#status-bar): before changing what one of them shows.
- [Runs](ARCHITECTURE.md#runs): the Playwright runner, the Run tool window, the test at the caret, breakpoints.
- [Finding Playwright configs](ARCHITECTURE.md#finding-playwright-configs): the search and the first-run notification.
- [Recording](ARCHITECTURE.md#recording): starting a recording, writing the block, warnings, undo.
- [Send to editor](ARCHITECTURE.md#send-to-editor), [Open in IDE](ARCHITECTURE.md#open-in-ide),
  [Connect](ARCHITECTURE.md#connect), [Settings and secrets](ARCHITECTURE.md#settings-and-secrets),
  [MCP server configuration](ARCHITECTURE.md#mcp-server-configuration).
- [Platform compatibility](ARCHITECTURE.md#platform-compatibility), [Threading](ARCHITECTURE.md#threading),
  [Dynamic plugin loading](ARCHITECTURE.md#dynamic-plugin-loading): the detail behind the platform rules.
- [Change notes](ARCHITECTURE.md#change-notes), [Screenshots](ARCHITECTURE.md#screenshots),
  [The JDK](ARCHITECTURE.md#the-jdk), [Tests](ARCHITECTURE.md#tests): publishing, the build and the test suites.
