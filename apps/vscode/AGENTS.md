# VS Code extension — agent guide

Rules for working inside `apps/vscode/` (the Piwi extension for VS Code, published as `piwitests.piwi` to the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=PiwiTests.piwi) and Open VSX).
Read [`../../AGENTS.md`](../../AGENTS.md) and [`../../packages/editor/AGENTS.md`](../../packages/editor/AGENTS.md)
first.

## What it is

A thin client of the editor service. `npm run vscode:build` builds the service's bundle and copies it to
`dist/piwi-language-server.cjs`, with the recorder's files the service finds next to itself
(`piwi-recorder-launcher.cjs`, `piwi-use-reporter.cjs`, `record-ide.js`, `record-ide-messages.json`: `build.mjs` fails
when one is missing), beside the extension's own bundle (`dist/extension.cjs`, esbuild, `vscode` external).

- `src/extension.ts` starts the service with `vscode-languageclient`, draws `piwi/fileSummary` as CodeLens (a test's
  line as a gutter icon from `media/`, its details in a hover, the `piwi.failingTestBackground` color over a
  failing test and `piwi.failingLineBackground` on the line it failed at, still drawn once that line changed since
  the run, which the hover says, with **Run** (`piwi.runTests` with `SummaryLine.testCaseId`) and **Open in
  dashboard**: `testDecorations`, `testHoverMarkdown` and `TEST_HOVER_COMMANDS` in `src/glue.ts`; `piwi/failuresChanged` and
  `piwi/coverageChanged` draw them again, once for the notifications of a 50 ms burst (`filesChanged`, `coalesced`
  in `src/glue.ts`); the gutter is drawn with CodeLens turned off too, from the same `piwi/fileSummary`, asked once
  per text version and drawing of the files: `summaryOf`, `decorateVisible`) and
  `piwi/runStatus` in the status bar (the tests still failing and those fixed locally since the latest run, from
  `failingTests` and `resolved`, and the run in progress, `live`; a notification that moves only the run in progress
  leaves the CodeLens and the gutter as they are: `runsInFiles`), implements the commands the service names
  (`piwi.openInDashboard`, `piwi.runTests`, `piwi.openTrace`, `piwi.openScreenshot`, `piwi.desktopJob`, from a quick
  fix or a flaky test's lens, which shows `piwi/desktopJobChanged` as notifications with the share button), keeps the
  API key in `SecretStorage`, hands the connection to the service with `piwi/setCredentials` and as the initialization
  options of each of its starts (`handed`: the client starts the service again after it stops unexpectedly): a change
  of `piwi.serverUrl`, `piwi.project`, `piwi.failureSeverity` (`error`, `warning`, `information`, `off`: the severity
  of a failure's diagnostic, sent as `failureSeverity`), `piwi.mcpAuthorization` (`key`, `sign-in`: how the agent signs
  in to Piwi's MCP server, an application setting a workspace cannot override, sent as `mcpAuthorization`) or a key is
  handed 250 ms after the last of a burst, and only when the connection differs from the one handed
  (`handChangedCredentials`), since each one reads everything again, then the MCP servers are asked again
  (`mcpServersChanged`); and provides Piwi's MCP server through
  `vscode.lm.registerMcpServerDefinitionProvider` where the editor has it (read at runtime: `engines.vscode` stays at
  the oldest version `vscode-languageclient` supports, for Cursor and VSCodium).
- The service's environment follows the editor's proxy settings (`serviceEnvironment` in `src/glue.ts`: `http.proxy`,
  with a `Basic` `http.proxyAuthorization` as its credentials, `http.noProxy` and `http.proxyStrictSSL`, as
  `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `NODE_TLS_REJECT_UNAUTHORIZED` over the extension
  host's environment, which passes `NODE_EXTRA_CA_CERTS` through); a change of one starts the service again, 250 ms
  after the last of a burst (`proxyChanged`). **Piwi: Open the log** (`piwi.openLog`) shows the client's output
  channel, where `piwi.trace.server` writes the traffic with the service.
- **Get started with Piwi** is the walkthrough (`contributes.walkthroughs`, each step's media a Markdown file of
  `walkthrough/`, which `.vscodeignore` ships): connect, the failures, a run, a recording, the MCP server, the settings,
  each step with a button that runs the extension's command (`piwi.connect`, `piwi.failures.focus`,
  `piwi.rerunFailing`, `piwi.recordFile`, `piwi.copyMcpConfiguration`, `piwi.openSettings`) and checked off by its
  events (`onContext:piwi.active`, `onView:piwi.failures`, `onCommand:…`). It opens once per machine
  (`piwi.walkthroughOpened` in global state), on the first activation in a workspace holding a Playwright config
  (`PLAYWRIGHT_CONFIGS` in `src/glue.ts`, the activation event's glob), unless
  `workbench.welcomePage.walkthroughs.openOnInstall` is off, and never in the integration suite's window
  (`ExtensionMode.Test`); **Piwi: Get started** (`piwi.getStarted`) opens it again (`WALKTHROUGH`).
  `tests/walkthrough.test.ts` holds each step to a contributed command or view, a context key the extension sets, and a
  shipped Markdown file: a renamed command, view or context key fails it.
- Coverage marks: each visible file the service reads (C# among them) is asked `piwi/coverage` once, again after a
  `piwi/statusChanged`, and drawn as whole-line left borders (`coverageDecorations` in `src/glue.ts`): the lines tests
  ran in `piwi.coverageRunBorder`, the executable lines none runs in `piwi.coverageNotRunBorder`, both defaulting to
  the dashboard's colors (`COVERAGE_MARK_COLORS` in `@piwitests/core/coverage`, checked by
  `apps/application/tests/unit/coverage-mark-colors.test.ts`), and the lines changed since the coverage run dashed in
  `piwi.coverageChangedBorder`; in a file no test reaches, its uncovered changes (`CoverageResult.uncovered`) in
  `piwi.uncoveredChangeBorder`; all but the lines run also in the overview ruler. `piwi/coverageChanged` replaces a file's
  answer and draws it again with its lenses; an edit asks nothing, the service pushes the marks it placed. The
  service's hover names the tests behind a line and ends on what the marks mean (VS Code has no hover on a
  decoration's border). **Piwi: Toggle the coverage marks** (`piwi.toggleCoverage`, kept in `workspaceState` as
  `piwi.coverageShown`, shown by default) is in the palette only once a file showed marks (`piwi.hasCoverage`): a
  workspace without coverage shows nothing of it.
- `src/failures-view.ts` is the **Failures** view of the **Piwi** panel (`viewsContainers.panel`): a `TreeView` over
  the failures `piwi/failuresChanged` pushes (`show`), read from `piwi/failures` with the grouping 200 ms after the
  extension starts or a `piwi/statusChanged`, and when the grouping changes, and drawn again when a
  `piwi/runStatusChanged` moves the editor's own run in progress (`ownLiveRun`); a push is never answered with a read.
  Its nodes are the tree the service grouped (`FailuresResult.tree`), drawn by `failureNodes` in `src/glue.ts` with a
  run's age, or the editor's own run in progress on the run of its Playwright config (`liveRoot`): the run, **Your
  runs since**, then the failures by file, cluster, owner or flat (`piwi.groupFailuresBy`, kept in `workspaceState` as
  `piwi.failuresGrouping`), under a node per config (`root-folder`) when several have something to show. A failure's `contextValue` (`piwi.failure.<state>` and `trace`, `screenshot`, `agent`,
  `desktop`) decides its inline actions and context menu in `package.json`, and a config's (`piwi.context` with
  `failing` and `run`) runs **Re-run the failing tests**, **Open in dashboard** and **Compare with…** for that config,
  as a run's node does **Compare with…** (`FailureNode.root`); **Copy context for agent** asks
  `piwi/agentContext`. The badge counts the failing tests; **Follow the active editor** (`piwi.toggleFollowEditor`,
  `piwi.stopFollowingEditor`, kept as `piwi.followEditor`) reveals the active file's first failure; the welcome
  content follows the `piwi.failuresView` context key. The badge is `FailuresResult.failing`. **Re-run the failing
  tests** (`piwi.rerunFailing`) runs `FailuresResult.rerun`, one run per Playwright config, or a config's alone from
  its node (`failingRuns`), and **Run this test** `failureRunArgs`: both name the failure's
  config (`root`). The view's `getChildren` is in the API `activate` returns (`failureChildren`).
- `piwi/runEnded` is a notification (`runVerdict` in `src/glue.ts`): a warning with **Re-run failing** when something
  fails, an information otherwise, with **Open the failures** (`piwi.failures.focus`) and **Open in dashboard**, as
  the `piwi.runNotifications` setting allows (`always`, `failures`, `never`); a run's `repeat` (**Verify ×3**) is
  said whatever the setting, `Piwi: run #124 · Failed 1 of 3`, a warning when one of the runs failed. A test the run
  in progress runs has the
  `running` gutter icon (`media/test-running.svg`), then that run's result; `runsInFiles` keeps the run's `liveTests`,
  so the files are drawn again as its tests begin and end, at most once a second (`filesRedraw`, `drawFiles` in
  `src/extension.ts`), and at once when the latest run changes.
- The status bar item (`statusBarView` in `src/glue.ts`) speaks for the Playwright config of the active editor's file
  (`statusContext`: the deepest config folder holding it, else the first connected config), and is drawn again from
  the answers it holds on `window.onDidChangeActiveTextEditor`: a click runs `piwi.refreshRun` (`piwi/refreshRun`, the
  item's icon spinning meanwhile: `refreshingText`), **Piwi: Refresh** while the instance does not answer
  (`problemKind: 'unreachable'`, the `retry` action), and **Piwi: Connect** while not connected. Its tooltip is a
  trusted `MarkdownString`, whose commands are `STATUS_TOOLTIP_COMMANDS`: the counts and the branch, the config it
  speaks for when there are several (`StatusResult.contexts[].label`), the local runs,
  the run in progress, `Updated 12 s ago · live` or `· read every minute` (`relativeTime`, written again every 30 s),
  the reporter version the project installs (`reporter 0.47.0`), then links to `piwi.openRun`,
  `piwi.openInDashboard`, `piwi.compareWith`, `piwi.connect` and `piwi.refresh`; **Piwi: Open the latest run**
  (`piwi.openRun`) is in the palette too.
- **Piwi: Compare with…** (`piwi.compareWith`, also in the failures view's title bar and the tooltip) picks the
  baseline of the config's or the run's node it runs from, else of the active file's context (`baselinePicks` in
  `src/glue.ts`: the ladder, each of `RunStatus.branches`, a run by its id through an input box, which `piwi/runId`
  reads, and the local runs only), keeps it in `workspaceState`
  (`piwi.baseline`, by root, the ladder as no entry: `withBaseline`), sends it with `piwi/setBaseline`, and sends the
  whole map in the credentials (`baselines`). The tooltip and the view's run node name it (`baselineLine`); with the
  local runs alone, the run node is `Your local runs`.
- A test run, which carries its own ref (`RunCommand.ref`, also in its environment), is a task (`runAsTask`): a
  `vscode.Task` of the `piwi` type (`taskDefinitions` in `package.json`, `{ type: 'piwi', ref }`), its command a
  `ShellExecution` in the Playwright config's folder, named `playwright test` and its arguments (`runTaskName` in
  `src/glue.ts`), in a dedicated terminal that is shown and cleared. Its start sends `piwi/commandStarted`, and
  `tasks.onDidEndTaskProcess` sends `piwi/commandEnded` with the exit code, on every VS Code version and in every
  shell. **Tasks: Rerun Last Task** runs the same command with the same ref: `tasks.onDidStartTaskProcess` sends
  `piwi/commandStarted` for it, which the service follows as a rerun of a ref it knows. A command without a ref
  (`piwi.runCommand`: the Flake Lab, a trace viewer) runs in a terminal (`runInTerminal`), reused per folder and
  environment. A `piwi/notice` is shown once, as a warning or an information message.
- **Open in IDE** from the dashboard: a URI handler (`vscode.window.registerUriHandler`, the `onUri` activation event)
  takes `vscode://piwitests.piwi/open?file=<path as the run reported it>&line=&column=&root=` (the dashboard's
  `buildVscodeExtensionUrl`), finds the file as the service finds a run's path (`resolveOpenFile` in `src/glue.ts`:
  under `root` when it lies in a workspace folder, the Playwright configs' folders, then the workspace folders; never a
  file outside them) and opens it at the 1-based line and column; when this window holds no such file, a warning says
  so (VS Code hands the link to the window focused last).
- **Piwi: Run the test at the cursor** (`piwi.runTestAtCursor`), **Piwi: Verify the test at the cursor ×3**
  (`piwi.verifyTestAtCursor`) and **Piwi: Run this spec** (`piwi.runSpec`, while `piwi.active`), in the palette and
  the editor's context menu of a spec, ask `piwi/testAt` for the cursor, save the spec when it has unsaved changes,
  then run through `runTests` (`runTestAt`, `runSpec`) the test by its id when Piwi knows it, else by its location
  (`testAtRun` in `src/glue.ts`), and to verify it by its location three times (`VERIFY_REPEAT`); or say that there is
  none. The first two take a `{ uri, line }` argument (`testLineArg`) for the test at another line: the notification
  after a recording names the line its block ends on.
- Every test run (`runTests`: the lenses, the gutter hover's **Run**, **Run this test**, **Run the test at the
  cursor**, **Run this spec**, **Run the tests that reach this file**, **Re-run the failing tests**; and **Run
  selection…**) passes the editor's breakpoints to the service (`breakpoints`), as the
  `piwi.breakpoints` setting allows (default on): the enabled `vscode.SourceBreakpoint`s in script files under a
  Playwright config's folder (`runBreakpoints` in `src/breakpoints.ts`). When the answer carries `PIWI_PAUSE_AT`,
  `startRun` starts the send listener if it is not running, minting its token as **Pair with Piwi Picker** does,
  without copying anything, and adds the pairing address as `PIWI_EDITOR_SEND`; `RunCommand.notice` (a reporter too
  old for breakpoints) is a warning, once per notice. The API `activate` returns gives the latest run's command
  (`lastRun`).
- `src/run-view.ts` shows and steers the runs started here (`registerRunControl`), with Piwi's own commands, no debug
  session: the initialization options say so (`runControl: true`), and the latest `piwi/runSessionChanged` of each ref
  is kept until one says `ended` (or the service stops: `onDidChangeState`). **Pause** (`piwi.pauseRun`, every run's
  running workers) and **Stop** (`piwi.stopRun`, which terminates the ref's task) while a run is live, **Resume**,
  **Step**, **Run to the cursor** (`run-to` the caret's line) and **Finish** (`piwi.resumeRun`, `piwi.stepRun`,
  `piwi.runToCursor`, `piwi.finishRun`) while a worker is stopped, each `piwi/runControl`, an answer with `ok: false`
  shown as an information message: in the status bar beside the run's progress (`controlItems`), in the palette
  and on keys while they apply (the `piwi.runActive`, `piwi.runPausable` and `piwi.runStopped` context keys). A stop
  opens its file at its line once (`stopKey`), drawn as the execution point (`media/execution-point.svg` in the
  gutter, `piwi.executionPointBackground`, the debugger's stack frame color by default) with a hover holding the
  controls, and a CodeLens above it (`pausedText`: `⏸ Paused · <title> · attempt N`, then Resume, Step, Run to cursor,
  Finish, each naming its worker); a key or a palette command acts on the stop at the caret's line, else the only one,
  else asks (`stopsFor`). A stop with no pause bar (`bar: false`) asks `piwi/pausedPage` and shows the JPEG in the
  **Piwi: paused page** webview beside the editor (no script, `img-src data:`, its style by nonce: `pausedPageHtml`),
  again at each such stop and on **Piwi: Show the paused page** (`piwi.showPausedPage`). The breakpoints
  `breakpointsForRun` gives go to each live run as they change (`vscode.debug.onDidChangeBreakpoints`, the
  `piwi.breakpoints` setting) with `piwi/setRunBreakpoints`, only to a run whose breakpoints differ from those its
  command started with or was last sent (`breakpointUpdates`), and once to a run as its first worker connects.
  `src/run-control.ts` is its pure half, tested without an editor; the API `activate` returns gives the sessions
  (`runSessions`), the lines drawn as the execution point (`executionPoints`) and what the paused page shows
  (`pausedPage`).
- `src/send-listener.ts` is the Send to editor endpoint: `POST /piwi/send` on `127.0.0.1`, on the port kept in
  global state, with the token from `SecretStorage` (`piwi.sendToken`); **Piwi: Pair with Piwi Picker** starts it and
  copies the pairing address as the browser's machine reaches it (`pickerPairing`: `vscode.env.asExternalUri`, which
  a remote window forwards), while a run's `PIWI_EDITOR_SEND` keeps the loopback address (`runPairing`), the reporter
  running where the extension does. A recorded flow is rendered by the service (`piwi/renderSteps`, indented for the
  caret's line) before it is inserted, with the service's import edit in the same edit.
  A locator with `at`, picked while a run was paused at a breakpoint, asks `piwi/applyPick` and applies its edit as a
  workspace edit on that line; when the line holds no locator, it is inserted at the cursor, and the notification
  says why (`pickNotice` in `src/glue.ts`).
- `src/recording.ts` records a test from the editor. **Piwi: Record here** asks `piwi/pageCandidates` for the caret
  (inside a test's body it records `steps`, elsewhere a new `test`); **Piwi: Record a new test file** creates a spec
  first, next to the active test file or in the config's `testDir` (`file`). The start page and the page expression
  (asked when there are several candidates) are kept in `workspaceState`, with the Playwright project, asked only when
  `piwi/record` lists them. Nothing is written before the first `piwi/recordingChanged`; each one then replaces the
  recorded block (first at `RecordResult.placement`), with the service's import edit (`importEdit`) in the same edit,
  tinted
  with `piwi.recordingBlockBackground`, a CodeLens above it (the state, the step count, Stop, Pause or Resume), the
  recording in the status bar and its warnings as diagnostics, each staying after Stop until its line is edited in
  place (`editedLine`; an edit that adds or removes a line of the block removes them all). Once the recording stopped,
  a warning on a step with other verified locators (`RecordingStep.locators`) offers each as a quick fix (a
  `CodeActionProvider` on the diagnostic, `locatorChoices` in `src/glue.ts`): **Use getByTestId('pay')** puts it in
  place of the written one, found on the line exactly once, as one workspace edit; none while it records, since the
  next update writes the block again. The
  block is followed through the edits around it; typing inside it pauses the recording (Resume writes it again, Keep my
  edits stops). A test paused in a run started here that asks to record from there (`piwi/recordRequested`) has its
  file shown at the paused line and its recording started at once (`recordFromTest`: `piwi/record` with the
  `handoff`, nothing asked), as one at the caret, and the answer's sentence shown; one it cannot start (the file is
  being recorded into, cannot be opened, or the service failed) is declined at once with why (`piwi/declineRecord`). Closing the file or the window stops its recording. The notification after Stop says what was
  written (`recordingSummary`: `Piwi: recorded 6 steps into checkout.spec.ts.`) and, when `piwi/testAt` finds a test
  holding the block's last line, offers **Run** and **Verify ×3** (`RECORDED_ACTIONS`), which run
  `piwi.runTestAtCursor` and `piwi.verifyTestAtCursor` at that line as the block stands when clicked. No CodeLens
  offers them: the recording's lens goes with Stop.
- `src/test-explorer.ts` lists Piwi's tests in VS Code's Testing view while `piwi.testExplorer` is on (the default; a
  change creates or disposes it, `showTestExplorer`): a `TestController` whose items are `piwi/testItems` (the
  catalog's specs and the open ones, read again in full when the connection or the runs change, a spec alone 300 ms
  after its last edit or when it opens: `withSpec`), drawn by `testTree` in `src/glue.ts` (a node per Playwright
  config when there are several, the spec's folders, the spec, its describe blocks, its tests; ids joined by `\x1f`,
  which VS Code takes where it refuses `\0`), each item kept while its id stays so its result does. The latest
  results are published as one test run (`resultsRunName`, `testOutcome`: a failure's message and line from
  `TestFailure`) when `resultsKey` changes; a run in progress (`RunStatus.live`) is a test run of its own
  (`liveRunName`) showing `liveTests` as they come, ended once the run was read, after which nothing is published
  again for it. **Run with Piwi** and **Verify ×3 with Piwi** (run profiles) run the picked tests through `runTests`
  (`testRunsOf`: one run per config, by id when every test has one, else by location), queued in their test run, which
  is followed from its first command on (a command that ends while the next starts is kept in `endedEarly`), takes
  each command's run in progress by its ref (`LiveRun.ref`; by its config when the service no longer keeps the
  command), and ends once each command's task ended (`taskEnded`, from `tasks.onDidEndTaskProcess`, or at once for a
  task VS Code could not start) and its run was read; a run that ended before it was followed is read from
  `piwi/runEnded` by its ref, and 15 s after a task's end with neither, a test no run gave a result for passes when
  every command exited with 0, else is an error (`unfollowedOutcome`). Cancel terminates the commands' tasks and ends
  the test run, the tests it showed no result for skipped. The spec URIs the service answers are spelled as VS Code
  spells a document's (`asEditorUris`), and a read that made items anew publishes the results again. While it lists the tests, the gutter's own icons give way to the Testing view's and
  a test's line keeps the hover (`testHover`). The API `activate` returns gives what it shows (`testExplorer`).
- `src/glue.ts` is the pure half (the status bar item, the failures view's nodes, the MCP configuration to paste, the
  file an open link names, the recorded block's text and writes with the service's import edit, and following them through a change: `writeBlock`,
  `followBlock`, `followEdit`, and the quick fixes of a recorded line's warning: `locatorChoices`; what runs the test at
  a line: `testAtRun`; the Testing view's tree and results: `testTree`, `testOutcome`, `testRunsOf`), tested without
  an editor.

## Rules

- **No logic that the JetBrains plugin would need too.** Diagnostics, quick fixes, hover and every answer come from
  the service; this extension renders them. A new feature is a service request first.
- The API key lives in `SecretStorage`, never in settings or a workspace file, **per instance**
  (`piwi.apiKey <url>`, `apiKeySecret` in `src/connect.ts`): workspace settings, which a repository may commit, never
  select another instance's key.
- **Piwi: Connect** (`src/connect.ts`, no VS Code API) asks the instance whether it needs a key, then signs in with the
  browser (the device authorization Piwi Picker uses) or takes a pasted key, then the project. When the desktop app
  runs, it first lists the app beside the instance the workspace names (`connectChoices` in `src/glue.ts`).
- The choice of the desktop app and its project live in `workspaceState` (`piwi.desktop`, `piwi.desktopProject`), on
  this machine only: choosing the app never touches `piwi.serverUrl`, `piwi.project` or the key, so switching back is
  one pick.
- Command ids are part of the protocol: renaming one is a breaking change for the service.
- The default keybindings (`contributes.keybindings`: `ctrl+shift+alt+r`, `cmd` on macOS, records at the caret and
  stops the recording; `ctrl+shift+alt+f` re-runs the failing tests; `ctrl+shift+alt+k`, in a focused editor, runs the
  test at the cursor: the JetBrains plugin's chords for the same actions) stay free in VS Code's default keymap on
  Windows, Linux and macOS, and in the JetBrains IDEs' bundled keymaps. A run's controls take the debugger's keys
  instead, only while they apply and no debug session runs (`!inDebugMode`): `f6` pauses, `shift+f5` stops, `f5`
  resumes, `f10` steps, `shift+f11` finishes and `ctrl+f10` (`cmd+f10`) runs to the cursor. VS Code binds `ctrl+shift+alt` (`cmd` on
  macOS) with `a`, `c`, `g`, `i`, `l`, `n` and `o`, the JetBrains keymaps with `c`, `d`, `e`, `h`, `i`, `j`, `l`, `m`,
  `n`, `p`, `s`, `t`, `u`, `v`, `w`, `x` and `y`; `ctrl+alt+<key>` and the `ctrl+k` chords are taken too. The extension declares no support for untrusted and virtual workspaces
  (`capabilities` in `package.json`): the service reads the files from disk and runs Playwright.
- **One undo step per recording.** The block's writes go through the editor that shows the file: the first one opens
  an undo stop and the later ones join it (`undoStopBefore: false`; the one Stop brings closes it), so one Undo after
  Stop removes the block and its imports. A save during the recording (auto save included) or an edit of the file
  between two writes starts another undo step, and a write while no editor shows the file is a workspace edit, an undo
  step of its own.

## Workflow

```bash
npm run vscode:build              # the service bundle, then the extension bundle
npm run vscode:typecheck
npm run vscode:lint               # :fix to fix
npm run vscode:format             # :check to verify only
npm run vscode:test               # unit tests of src/glue.ts
xvfb-run -a npm run vscode:test:integration   # VS Code (downloaded to .vscode-test/) on a fixture repository
xvfb-run -a -s "-screen 0 1920x1200x24" npm run vscode:test:e2e   # what the workbench draws, after vscode:build
npm run vscode:package            # dist/piwi.vsix
```

**Changelog.** The Marketplace's Changelog tab shows the package's `CHANGELOG.md`, which `reusable-publish-vscode.yml`
writes before `vsce package` from the `ide` entries of the root `CHANGELOG.md`, under their version and section
(`node scripts/ide-changelog.mjs --format md --all > apps/vscode/CHANGELOG.md` from the repository root): a commit
with the `ide` scope is what puts a line in it. The file is gitignored, and `.vscodeignore` lets it into the VSIX.

**Screenshots.** `scripts/take-screenshots.mjs` writes the extension's illustrations (`apps/docs/public/screenshots/vscode-*.png`,
shown by the docs, the README and the Marketplace README): it opens the fixture project of
`scripts/lib/editor-fixture.mjs`, a small shop's suite with one brittle locator, two CI failures and a local run since,
against the stub instance the same module serves, in the VS Code `scripts/lib/vscode-window.mjs` downloads (the
release `VSCODE_VERSION` pins, moved on purpose: the workbench's DOM changes between releases), and drives the window
with Playwright's Electron support. On Linux, run it under Xvfb at twice the window size for 2× images:
`xvfb-run -a -s "-screen 0 2880x1800x24" node scripts/take-screenshots.mjs`. A scene is a function of `SCENES`; one
that fails leaves `vscode-<scene>-failed.png` with the window as it stood. The JetBrains plugin's script reuses the
fixture, so a change to it recaptures both sets. What was found about driving VS Code this way is recorded in
[`proposals/real-editor-checks.md`](../../proposals/real-editor-checks.md).

**The nightly suite** (`tests/e2e/`, `npm run vscode:test:e2e`) opens the same fixture in the same window and asserts
on the workbench's DOM what the in-process suites check as answers: the status bar's counts, the Problems panel's rows,
the quick fixes, the hover, CodeLens, the failures view and the Testing view. `.github/workflows/nightly-vscode.yml`
runs it every night and on demand, not on pull requests; a failure leaves the HTML report with a screenshot of the
window. Find elements by ARIA role and name where the workbench gives one (`getByRole('tree', { name: 'Test Explorer' })`),
a class name only where it does not; a step that opens a menu or a hover clears the notification toasts first
(`clearNotifications`).

The integration suite (`tests/integration/`) starts a stub instance, writes a fixture repository, and drives VS Code
through its public commands (`vscode.executeCodeActionProvider`, `vscode.executeCodeLensProvider`, …), and through the
API `activate` returns (`pageCandidates`, the service's answer for a position, `failureChildren`, the failures view's
nodes, `lastRun`, the command a breakpoint's run was given, `gutter`, the tests last drawn in a file's gutter,
`coverage`, a file's coverage answer and whether its marks are shown, `testExplorer`, the Testing view's tests
with the result last shown for each, and `runSessions`, `executionPoints` and `pausedPage`, a run's stops as a fake
worker on the run channel plays them).
