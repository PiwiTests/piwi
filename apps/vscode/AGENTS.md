# VS Code extension: agent guide

Rules for working inside `apps/vscode/`: the Piwi extension for VS Code, published as `piwitests.piwi` on the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=PiwiTests.piwi) and Open VSX. It is a
thin client of the editor service: it starts the service and draws its answers. Read
[`../../AGENTS.md`](../../AGENTS.md) and [`../../packages/editor/AGENTS.md`](../../packages/editor/AGENTS.md) first. How
each feature works is in [`ARCHITECTURE.md`](ARCHITECTURE.md); the protocol is in
[`packages/editor/ARCHITECTURE.md`](../../packages/editor/ARCHITECTURE.md#protocol).

## Rules

### Service and protocol

- **No logic that the JetBrains plugin would need too.** Diagnostics, quick fixes, hover and every other answer come
  from the service; this extension draws them, and a new feature starts as a service request.
- **The command ids the service names are part of the protocol.** They are the ids of `PiwiCommand.command` in
  `packages/editor/src/protocol.ts`, and `piwi.copyAgentContext` in a quick fix: renaming one changes the service and
  both clients in the same change ([Clients and versions](../../packages/editor/ARCHITECTURE.md#clients-and-versions)),
  and is a breaking change for users, whose keybindings and settings name the ids (`proposals/1.0-stabilization.md`
  freezes them, with the extension's own command ids, settings and MCP provider ids, `piwi.mcp` and `piwi.runs`).
  `tests/walkthrough.test.ts` also fails when a walkthrough step names a command, view or context key that no longer
  exists.
- **Credentials are handed to the service only when they differ from the ones last handed** (`handChangedCredentials`,
  250 ms after the last change of a burst). Each handing makes the service read everything again.
  ([Service, lenses and credentials](ARCHITECTURE.md#service-lenses-and-credentials))
- **The failures view and the coverage marks keep what the service pushes.** The failures view keeps the answer
  `piwi/failuresChanged` carries, and an edit asks for no coverage: the service pushes `piwi/coverageChanged`.
  (`piwi/statusChanged` still makes the extension read the status, the failures, the coverage and the MCP servers
  again.)
  ([Failures view](ARCHITECTURE.md#failures-view))
- **`src/glue.ts`, `src/connect.ts`, `src/breakpoints.ts`, `src/send-listener.ts`, `src/run-control.ts` and
  `src/debug-link.ts` use no VS Code API.** Put logic that needs no editor there, so the unit tests (`npm run vscode:test`) cover it.
  ([The pure half](ARCHITECTURE.md#the-pure-half))
- **A run control names the stop it answers, and a line sent for a run is a line of the run's code.** Resume, Step, Run
  to the cursor, Finish and End the test pass the stop's `since`; Run to the cursor and `piwi/setRunBreakpoints` map the
  editor's lines back through `EditLog` (`runPlaces` for the breakpoints). Checked by `tests/run-control.test.ts`.
  ([Run control](ARCHITECTURE.md#run-control); the service's side: [Controls, breakpoints and the paused
  page](../../packages/editor/ARCHITECTURE.md#controls-breakpoints-and-the-paused-page))
- **The code a stop makes is one workspace edit, made only in the version of its document the service placed it in**
  (else the file as saved; otherwise a warning offers **Copy the code**), so it never lands on a line the service did
  not choose. Checked by `tests/run-control.test.ts` ("the code a stop makes") and the integration suite.
  ([Code from a stop](ARCHITECTURE.md#code-from-a-stop))
- **A rerun under the ref of a run that ended maps its lines from when it is first heard (`heardSession`)**, never
  from the ended run's start. Checked by `tests/run-control.test.ts` ("map a rerun’s lines …").
  ([Run control](ARCHITECTURE.md#run-control))

### Editors and workspaces

- **`engines.vscode` stays at the oldest version `vscode-languageclient` supports** (`^1.91.0` for version 10), so
  Cursor and VSCodium load the extension. A newer API, such as `vscode.lm.registerMcpServerDefinitionProvider`, is
  looked up at run time.
- **The extension declares no support for untrusted and virtual workspaces** (`capabilities` in `package.json`): the
  service reads the files from disk and runs Playwright.
- **A test run is a VS Code task** (`runAsTask`, the `piwi` type of `taskDefinitions` in `package.json`).
  `tasks.onDidEndTaskProcess` gives the exit code the service needs (`piwi/commandEnded`) on every VS Code version and
  in every shell. ([Test runs as tasks](ARCHITECTURE.md#test-runs-as-tasks))
- **A default keybinding uses a chord that VS Code's default keymap leaves free, and the JetBrains plugin binds the
  same chord.** Today: `ctrl+shift+alt` (`cmd` on macOS) with `r`, `f` and `k`. The letters each editor's keymaps
  already take, and the JetBrains conflicts, are in [Keybindings](ARCHITECTURE.md#keybindings).
- **A run's controls are the exception: they take the debugger's keys, only while they apply and no debug session
  runs** (`!inDebugMode` in `contributes.keybindings`). **Pause** has no default key: a key bound for as long as a
  test runs takes one from the workbench. ([Keybindings](ARCHITECTURE.md#keybindings))
- **One undo step per recording.** The first write of the block opens an undo stop and the later ones join it
  (`undoStopBefore: false`), so one Undo after Stop removes the block and its imports.
  ([Undo during a recording](ARCHITECTURE.md#undo-during-a-recording))
- **The coverage marks default to the dashboard's colors** (`COVERAGE_MARK_COLORS` in `@piwitests/core/coverage`).
  Checked by `apps/application/tests/unit/coverage-mark-colors.test.ts`.

### Secrets and security

- **The API key lives in `SecretStorage`, per instance, never in a setting or a workspace file** (`piwi.apiKey <url>`,
  `apiKeySecret` in `src/connect.ts`). Workspace settings, which a repository may commit, never select another
  instance's key.
- **The choice of the desktop app and of its project stays on this machine** (`workspaceState`: `piwi.desktop`,
  `piwi.desktopProject`). Choosing the app never changes `piwi.serverUrl`, `piwi.project` or the key, so switching back
  is one pick.
- **Open in IDE never opens a file outside the workspace folders** (`resolveOpenFile` in `src/glue.ts`).
  ([Open in IDE](ARCHITECTURE.md#open-in-ide))
- **A debug link (`debug=1`) runs nothing until the person says yes in a notification, and names files, a line and a
  title, never a command.** `debugLink` checks each field and refuses one named twice, `debugFiles` follows every
  symbolic link before a file counts as the workspace's, and the service builds the run (`RunTestsArgs.debug`).
  Checked by `tests/debug-link.test.ts` and the integration suite ("Debug in my editor …").
  ([Debug in my editor](ARCHITECTURE.md#debug-in-my-editor))
- **The Send to editor endpoint listens on `127.0.0.1` only, with its token in `SecretStorage`** (`piwi.sendToken`,
  `src/send-listener.ts`). It answers only a `Host` of `127.0.0.1` or `localhost` at its port or the one a remote window
  forwards to it (`forwarded`), and every answer to a request carrying `x-piwi-editor-challenge`, whatever its route and
  status, carries `x-piwi-editor-proof` for the port the `Host` named. Checked by `tests/send-listener.test.ts`.
  ([Send to editor](ARCHITECTURE.md#send-to-editor))
- **`GET /piwi/live` lists hubs only, never a run channel's token; a remote window lists its own service's hub alone,
  at the loopback port `asExternalUri` forwards, on `127.0.0.1` as the pairing address is (`onLoopback`), once
  `piwi/hub` made the hub take it** (`liveHubsHere`). Checked by `tests/send-listener.test.ts` ("… none of the run
  channels", "lists a remote window’s own hub …").
  ([Send to editor](ARCHITECTURE.md#send-to-editor))
- **Only the pairing Piwi Picker is given saves the listener's port** (`sendPairing`): a run's pairing takes any free
  port while another window holds the saved one, and leaves it saved. Checked by `tests/send-listener.test.ts` ("keeps
  the port Piwi Picker was given …"). ([Breakpoints](ARCHITECTURE.md#breakpoints))
- **The runs' MCP server's token lives in `SecretStorage`, one per workspace (`agentsTokenKey`), and reaches an agent
  only through the provider `piwi.runs` or the configuration the person copies, which says it holds it**
  (`keptAgentsToken`, `runsMcpConfiguration`). A token the service answers or tells (`piwi/agentsChanged`) replaces the
  one kept, and **Piwi: Reset the runs' MCP server token** asks the service for a new one (`newToken`).
  `piwi.serveRunsToAgents` off turns the server off at once (`piwi/agents`). Checked by the integration suite ("the
  runs are served to agents …").
  ([Service, lenses and credentials](ARCHITECTURE.md#service-lenses-and-credentials))
- **A stop's browser is shared with Playwright's tools only after a modal warning, each time it is asked**
  (`share` in `src/run-view.ts`, `SHARE_WARNING`), never on an agent's word.
  ([Run control](ARCHITECTURE.md#run-control))
- **A run is shared live on the team instance only from the person's command, after a modal warning the first time in
  the window** (`shareLive` in `src/run-view.ts`, `shareLiveWarning`), as the JetBrains plugin does; only a run known
  not to be shareable is asked without it, for the service to say why. Checked by `tests/run-control.test.ts` ("Share live").
- **The paused page webview runs scripts only by the style's nonce, for picking or a capable stop's live preview.**
  Its document takes images from `data:` only. Live input requires Watch live and the separate Interact opt-in, and
  messages name the shown stop: checked by `tests/run-control.test.ts` and `tests/e2e/paused-page.spec.mjs`. Only a
  change of the panel's visibility, its closing or a new stop ends or restarts its watch (`openPage` in
  `src/run-view.ts`), which no test drives yet.
  ([Run control](ARCHITECTURE.md#run-control))

## Workflow

From `apps/vscode/`:

```bash
npm run vscode:build              # the editor service, then the extension bundle beside it
npm run vscode:typecheck
npm run vscode:lint               # :fix to fix
npm run vscode:format             # :check to verify only
npm run vscode:test               # unit tests of the modules without the VS Code API, and of the walkthrough
xvfb-run -a npm run vscode:test:integration   # builds, then drives VS Code (downloaded to .vscode-test/) on a fixture
xvfb-run -a -s "-screen 0 1920x1200x24" npm run vscode:test:e2e   # the nightly suite, after vscode:build
npm run vscode:package            # dist/piwi.vsix
```

- **`node build.mjs` alone fails when a file of the editor service is missing from `packages/editor/dist/`**: run
  `npm run editor:build -w @piwitests/editor`, or `npm run vscode:build`, which builds the service first.
- **Changelog**: the Marketplace's Changelog tab is written at publish time from the `ide` entries of the root
  `CHANGELOG.md`, so a commit with the `ide` scope is what puts a line in it.
  ([Changelog](ARCHITECTURE.md#changelog))
- **Screenshots**: `scripts/take-screenshots.mjs` recaptures `apps/docs/public/screenshots/vscode-*.png`; run it under
  Xvfb at twice the window size. Its fixture is shared with the JetBrains plugin's script, so a change to the fixture
  means recapturing both sets. ([Screenshots](ARCHITECTURE.md#screenshots))
- **Nightly suite** (`tests/e2e/`): find elements by ARIA role and name, and clear the notification toasts before a step
  opens a menu or a hover (`clearNotifications`). ([Nightly suite](ARCHITECTURE.md#nightly-suite))
- **Integration suite** (`tests/integration/`): drive VS Code through its public commands and the API `activate`
  returns. ([Integration suite](ARCHITECTURE.md#integration-suite))

## Source map

- `src/extension.ts`: activation. Starts the service, draws its answers, implements its commands, hands the credentials,
  runs Connect.
- `src/glue.ts`: the pure half (status bar, failures view nodes, MCP configuration, open links, recorded blocks,
  Testing view tree), tested without an editor.
- `src/connect.ts`: the instance's side of **Piwi: Connect**, and the API key's secret name.
- `src/failures-view.ts`: the **Failures** view of the **Piwi** panel.
- `src/test-explorer.ts`: Piwi's tests in VS Code's Testing view.
- `src/recording.ts`: recording a test from the editor.
- `src/send-listener.ts`: the Send to editor endpoint.
- `src/debug-link.ts`: a debug link read and checked; `src/debug-from-link.ts`: the prompt, then the run.
- `src/breakpoints.ts`: the breakpoints a test run passes to the service.
- `src/run-view.ts`: the run controls (the stops, their commands, the paused page); `src/run-control.ts`: their pure
  half.
- `walkthrough/`, `media/`: the walkthrough's steps, and the gutter icons and the execution point's arrow.
- `scripts/`: the screenshots script, and the fixture project it shares with the JetBrains plugin.
- `tests/`: the unit tests, `tests/integration/` and `tests/e2e/`.

## ARCHITECTURE.md sections

- [Service, lenses and credentials](ARCHITECTURE.md#service-lenses-and-credentials) and
  [Settings and stored state](ARCHITECTURE.md#settings-and-stored-state): `src/extension.ts`, the gutter, CodeLens, the
  credentials, the proxy, every setting and stored key.
- [Walkthrough](ARCHITECTURE.md#walkthrough), [Coverage marks](ARCHITECTURE.md#coverage-marks),
  [Failures view](ARCHITECTURE.md#failures-view), [Status bar](ARCHITECTURE.md#status-bar),
  [Testing view](ARCHITECTURE.md#testing-view): before changing what one of them shows.
- [Runs](ARCHITECTURE.md#runs): run notifications, tasks, the test at the cursor, breakpoints, the run control
  (stops, Pause, Resume, the paused page) and the code from a stop.
- [Open in IDE](ARCHITECTURE.md#open-in-ide), [Send to editor](ARCHITECTURE.md#send-to-editor) and
  [Connect](ARCHITECTURE.md#connect): the entry points from the dashboard, Piwi Picker and an instance.
- [Recording](ARCHITECTURE.md#recording): recording a test, its quick fixes, a paused test's recording, undo.
- [Keybindings](ARCHITECTURE.md#keybindings): the chords each default keymap already takes.
- [Changelog](ARCHITECTURE.md#changelog), [Screenshots](ARCHITECTURE.md#screenshots),
  [Nightly suite](ARCHITECTURE.md#nightly-suite), [Integration suite](ARCHITECTURE.md#integration-suite): publishing and
  the suites that drive a real VS Code.
