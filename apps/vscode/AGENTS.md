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
  both clients in the same change ([Clients and versions](../../packages/editor/ARCHITECTURE.md#clients-and-versions)).
  `tests/walkthrough.test.ts` also fails when a walkthrough step names a command, view or context key that no longer
  exists.
- **Credentials are handed to the service only when they differ from the ones last handed** (`handChangedCredentials`,
  250 ms after the last change of a burst). Each handing makes the service read everything again.
  ([Service, lenses and credentials](ARCHITECTURE.md#service-lenses-and-credentials))
- **A push from the service is never answered with a read.** The failures view keeps what `piwi/failuresChanged`
  pushes, and an edit asks for no coverage: the service pushes `piwi/coverageChanged`.
  ([Failures view](ARCHITECTURE.md#failures-view))
- **`src/glue.ts`, `src/connect.ts`, `src/breakpoints.ts` and `src/send-listener.ts` use no VS Code API.** Put logic
  that needs no editor there, so the unit tests (`npm run vscode:test`) cover it.
  ([The pure half](ARCHITECTURE.md#the-pure-half))

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
- **The Send to editor endpoint listens on `127.0.0.1` only, with its token in `SecretStorage`** (`piwi.sendToken`,
  `src/send-listener.ts`). Checked by `tests/send-listener.test.ts`.
  ([Send to editor](ARCHITECTURE.md#send-to-editor))

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
  `npm run editor:build`, or `npm run vscode:build`, which builds the service first.
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
- `src/breakpoints.ts`: the breakpoints a test run passes to the service.
- `walkthrough/`, `media/`: the walkthrough's steps and the gutter icons.
- `scripts/`: the screenshots script, and the fixture project it shares with the JetBrains plugin.
- `tests/`: the unit tests, `tests/integration/` and `tests/e2e/`.

## ARCHITECTURE.md sections

- [Service, lenses and credentials](ARCHITECTURE.md#service-lenses-and-credentials) and
  [Settings and stored state](ARCHITECTURE.md#settings-and-stored-state): `src/extension.ts`, the gutter, CodeLens, the
  credentials, the proxy, every setting and stored key.
- [Walkthrough](ARCHITECTURE.md#walkthrough), [Coverage marks](ARCHITECTURE.md#coverage-marks),
  [Failures view](ARCHITECTURE.md#failures-view), [Status bar](ARCHITECTURE.md#status-bar),
  [Testing view](ARCHITECTURE.md#testing-view): before changing what one of them shows.
- [Runs](ARCHITECTURE.md#runs): run notifications, tasks, the test at the cursor, breakpoints.
- [Open in IDE](ARCHITECTURE.md#open-in-ide), [Send to editor](ARCHITECTURE.md#send-to-editor) and
  [Connect](ARCHITECTURE.md#connect): the entry points from the dashboard, Piwi Picker and an instance.
- [Recording](ARCHITECTURE.md#recording): recording a test, its quick fixes, a paused test's recording, undo.
- [Keybindings](ARCHITECTURE.md#keybindings): the chords each default keymap already takes.
- [Changelog](ARCHITECTURE.md#changelog), [Screenshots](ARCHITECTURE.md#screenshots),
  [Nightly suite](ARCHITECTURE.md#nightly-suite), [Integration suite](ARCHITECTURE.md#integration-suite): publishing and
  the suites that drive a real VS Code.
