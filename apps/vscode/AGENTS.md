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
  of a failure's diagnostic, sent as `failureSeverity`) or a key is handed 250 ms after the last of a burst, and only when the
  connection differs from the one handed (`handChangedCredentials`), since each one reads everything again; and
  provides Piwi's MCP server through
  `vscode.lm.registerMcpServerDefinitionProvider` where the editor has it (read at runtime: `engines.vscode` stays at
  the oldest version `vscode-languageclient` supports, for Cursor and VSCodium).
- The service's environment follows the editor's proxy settings (`serviceEnvironment` in `src/glue.ts`: `http.proxy`,
  with a `Basic` `http.proxyAuthorization` as its credentials, `http.noProxy` and `http.proxyStrictSSL`, as
  `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `NODE_TLS_REJECT_UNAUTHORIZED` over the extension
  host's environment, which passes `NODE_EXTRA_CA_CERTS` through); a change of one starts the service again, 250 ms
  after the last of a burst (`proxyChanged`). **Piwi: Open the log** (`piwi.openLog`) shows the client's output
  channel, where `piwi.trace.server` writes the traffic with the service.
- Coverage marks: each visible file the service reads (C# among them) is asked `piwi/coverage` once, again after a
  `piwi/statusChanged`, and drawn as whole-line left borders (`coverageDecorations` in `src/glue.ts`): the lines tests
  ran in `piwi.coverageRunBorder`, the executable lines none runs in `piwi.coverageNotRunBorder`, both defaulting to
  the dashboard's colors (`COVERAGE_MARK_COLORS` in `@piwitests/core/coverage`, checked by
  `apps/application/tests/unit/coverage-mark-colors.test.ts`), and the lines changed since the coverage run dashed in
  `piwi.coverageChangedBorder`; the last two also in the overview ruler. `piwi/coverageChanged` replaces a file's
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
  the `piwi.runNotifications` setting allows (`always`, `failures`, `never`). A test the run in progress runs has the
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
- **Piwi: Run the test at the cursor** (`piwi.runTestAtCursor`) and **Piwi: Run this spec** (`piwi.runSpec`), in the
  palette and the editor's context menu of a spec while `piwi.active`, ask `piwi/testAt` for the cursor, then run the
  test or the spec's tests through `runTests` (`runInSpec`), or say that none is known.
- Every test run (`runTests`: the lenses, the gutter hover's **Run**, **Run this test**, **Run the test at the
  cursor**, **Run this spec**, **Run the tests that reach this file**, **Re-run the failing tests**; and **Run
  selection…**) passes the editor's breakpoints to the service (`breakpoints`), as the
  `piwi.breakpoints` setting allows (default on): the enabled `vscode.SourceBreakpoint`s in script files under a
  Playwright config's folder (`runBreakpoints` in `src/breakpoints.ts`). When the answer carries `PIWI_PAUSE_AT`,
  `startRun` starts the send listener if it is not running, minting its token as **Pair with Piwi Picker** does,
  without copying anything, and adds the pairing address as `PIWI_EDITOR_SEND`; `RunCommand.notice` (a reporter too
  old for breakpoints) is a warning, once per notice. The API `activate` returns gives the latest run's command
  (`lastRun`).
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
  recording in the status bar and its warnings as diagnostics, which stay after Stop until the block is edited. The
  block is followed through the edits around it; typing inside it pauses the recording (Resume writes it again, Keep my
  edits stops). Closing the file or the window stops its recording.
- `src/glue.ts` is the pure half (the status bar item, the failures view's nodes, the MCP configuration to paste, the
  file an open link names, the recorded block's text and writes with the service's import edit, and following them through a change: `writeBlock`,
  `followBlock`, `followEdit`), tested without an editor.

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
  Windows, Linux and macOS, and in the JetBrains IDEs' bundled keymaps. VS Code binds `ctrl+shift+alt` (`cmd` on
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
npm run vscode:package            # dist/piwi.vsix
```

**Changelog.** The Marketplace's Changelog tab shows the package's `CHANGELOG.md`, which `reusable-publish-vscode.yml`
writes before `vsce package` from the `ide` entries of the root `CHANGELOG.md`, under their version and section
(`node scripts/ide-changelog.mjs --format md --all > apps/vscode/CHANGELOG.md` from the repository root): a commit
with the `ide` scope is what puts a line in it. The file is gitignored, and `.vscodeignore` lets it into the VSIX.

**Screenshots.** `scripts/take-screenshots.mjs` writes the extension's illustrations (`apps/docs/public/screenshots/vscode-*.png`,
shown by the docs, the README and the Marketplace README): it opens the fixture project of
`scripts/lib/editor-fixture.mjs`, a small shop's suite with one brittle locator, two CI failures and a local run since,
against the stub instance the same module serves, in the downloaded VS Code, and drives the window with Playwright's
Electron support. On Linux, run it under Xvfb at twice the window size for 2× images:
`xvfb-run -a -s "-screen 0 2880x1800x24" node scripts/take-screenshots.mjs`. A scene is a function of `SCENES`; one
that fails leaves `vscode-<scene>-failed.png` with the window as it stood. The JetBrains plugin's script reuses the
fixture, so a change to it recaptures both sets. What was found about driving VS Code this way, and what a test
suite over the same launcher would assert, is recorded in
[`proposals/real-editor-checks.md`](../../proposals/real-editor-checks.md).

The integration suite (`tests/integration/`) starts a stub instance, writes a fixture repository, and drives VS Code
through its public commands (`vscode.executeCodeActionProvider`, `vscode.executeCodeLensProvider`, …), and through the
API `activate` returns (`pageCandidates`, the service's answer for a position, `failureChildren`, the failures view's
nodes, `lastRun`, the command a breakpoint's run was given, `gutter`, the tests last drawn in a file's gutter, and
`coverage`, a file's coverage answer and whether its marks are shown).
