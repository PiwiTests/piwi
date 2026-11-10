# Desktop app: agent guide

Rules for working inside `apps/desktop/` (the Tauri shell that bundles and runs the dashboard locally). Read
[`../../AGENTS.md`](../../AGENTS.md) first for repo-wide conventions, and [`README.md`](README.md) for how the shell
works, the build prerequisites, the end-to-end tests, signing and the update channels.

The shell is a [Tauri](https://tauri.app) window around **the same built Nuxt/Nitro server** shipped as the Docker
image and `@piwitests/server`. The Rust code (`src-tauri/src/`) spawns that server as a **Node sidecar** on a loopback
port, waits for `GET /api/health`, then points the window at it through a single-use session code (`/__piwi/session?code=…`).
The installers (Windows `.msi` and `.exe`, macOS `.dmg`, Linux `.deb` / `.rpm` / `.AppImage`) are built from the same
shell and are feature-equivalent.

## Rules

- **Never fork the server.** The desktop app must keep running the unmodified built server. Anything the shell needs
  from the backend goes in `apps/application/` behind a desktop-aware guard, not into a desktop-only copy.
- **The window trusts only the sidecar it spawned.**
  - The readiness probe sends a fresh challenge, and the shell loads the session bootstrap only after `/api/health`
    answers it with the proof of the desktop token (`x-piwi-desktop-proof`, checked in constant time).
  - The shell sends the token to the sidecar only on the connection that proved it (`connect_proving_token`): the
    proof and the token request travel on one keep-alive connection, and a server that ends the connection after the
    proof gets no token on a new one.
  - When the sidecar exits, every window on its origin leaves it (`session.rs`): the main window goes to the bundled
    splash and the others close. The session bootstrap loads again only after the restarted process proves the token;
    a proof that never comes leaves the window on the splash with its status set. A load whose sidecar exited
    again, or whose supervisor gave up, after the proof passed is dropped on the thread that navigates
    (`proof_holds`), and a restart's splash text never shows a hidden window.
  - The main window may only navigate to its bundled pages and the sidecar's exact origin
    (`main_window_may_navigate` in `src-tauri/src/lib.rs`).
  - A run's output window (`desktop_open_output_window`, labeled `output-<name>_<n>`) shows the dashboard's
    `/desktop/run-output` page, stays on the sidecar's origin and holds no IPC grant: the dashboard window feeds it
    over a `BroadcastChannel` (`app/utils/run-output-channel.ts`). Never give it the opener link of `window.open()`:
    on macOS the new web view then shares the main window's script handlers, and closing it drops the main window's
    IPC.
  - The IPC capability (`src-tauri/runtime-capabilities/remote.json`) is added at startup for that origin only, never
    for a port wildcard, and no capability under `src-tauri/capabilities/` grants remote content.
  - A command that turns webview input into a path or a process takes only known values: digits-only project ids,
    hexadecimal request ids, skill slugs of lowercase letters, digits and dashes, the known IDE launcher names
    (`is_known_launcher`).
- **A `piwi://` link only shows a page.** Anyone can send one, so the shell reads only `piwi://open/<page>`
  (`link_page`), the page passes `desktopPagePath` again in the window and at the session bootstrap, and a launch whose
  first argument is a link acts on no other argument (`args_to_act_on`, unit-tested in `lib.rs`). A link that comes
  after the sidecar exits waits for the next dashboard page (`SessionWindows::hold_links`), never the dying one.
- **Piwi Runner answers `piwi-runner://connect` and no other link.** It only brings the window forward (`is_connect_link`
  in `runner_app.rs`), so no host, instance or key can arrive on a link; the desktop app keeps `piwi`.
- **A new Tauri command is wired in three places**: `tauri::generate_handler!` in `src-tauri/src/lib.rs`, the
  `.commands(&[…])` list in `src-tauri/build.rs`, and an `allow-*` grant in `runtime-capabilities/remote.json`.
  Without all three, the window's `invoke` is refused at runtime; `apps/application/tests/unit/desktop-acl-consistency.test.ts`
  fails until they match.
- **Piwi Runner's commands are wired apart**: its own `generate_handler!` in `runner_app.rs` and its own grant,
  `runtime-capabilities/runner.json`. `desktop-acl-consistency.test.ts` requires the grant to equal that handler's
  commands and to hold none of the dashboard-only ones; a command both apps use is wired in both.
- **Everything binds `127.0.0.1`, behind the desktop token.** Every `/api` and `/mcp` request must present the
  per-install access token (`PIWI_DESKTOP_TOKEN`), enforced by `apps/application/server/middleware/desktop-guard.ts`
  with `@piwitests/editor/host-guard`,
  so only the app and the tools given the token (the reporter, the `piwi` commands), not other local processes or
  browser pages, can reach the bundled API. Any new desktop-only route must stay behind that guard.
- **Three routes are open without the token, and each one needs the same care** (`isOpenDesktopRoute` in
  `server/utils/desktop-access.ts`; `tests/unit/desktop-pairing.test.ts` pins the list):
  - the readiness probe, which also answers Piwi Picker's challenge with the proof that this server holds the token
    (`@piwitests/core/desktop-proof`, bound to the port it answers on) before the extension sends it;
  - Piwi Picker's pairing start, which answers only an extension's JSON request and keeps at most three waiting;
  - the pairing poll, which answers only with the secret the start gave. The token goes out once, after **Allow** in
    the window (`DesktopPickerPairingModal`), behind the guard.
- **The bundled server is the hub of every Playwright run the shell starts.** Each spawn of a test (`runner.rs`,
  `repro.rs`, and in `worktree.rs` the reproduce, bisect and `piwi flake` runs) adds `bundled_hub_env`: the server's
  `PIWI_RUN_CHANNEL` and the address its picks go to (`PIWI_EDITOR_SEND`, the server's own route), read from
  `GET /api/desktop/run-channel` only after `health_ok` proved the host holds the token, and `PIWI_RUN_REF` (`hub_env.rs`,
  `desktop-<run id>`, which the window knows the run by). A run nobody attends (Flake Lab, a bisect, a lab job, one
  with `--ui`, or with `--repeat-each` above 1 unless it stops at its first failure) ends its ref in `-unattended`
  (`attended_args`, mirrored by `desktopArgsAttended`), and the server never holds its failures. The hub's WebSocket
  takes the desktop token in `hello`; its code is `apps/application/server/utils/desktop-runs.ts`. Agents steer those
  runs only through `/mcp`, behind the same token (`server/utils/mcp/run-tools.ts`), and never a run nobody attends.
- **Two routes pass on another token, each for that route alone, from a loopback host, origin and peer.**
  - An assistant answer's MCP endpoint (`POST /api/assistant/conversations/:id/mcp`) is called by the Claude Code CLI
    the server starts, with the token minted for that one answer (`presentsAssistantTurnToken` in
    `server/utils/assistant/turn-token.ts`), only while the answer runs. Anything else the CLI or a turn needs goes
    through that endpoint, never a new open route.
  - The runs the shell starts post their picks (`POST /api/desktop/runs/picks`) with the token minted for that route
    as the server starts (`desktopPicksToken`, `presentsDesktopPicksToken` in `server/utils/desktop-access.ts`), the
    one `GET /api/desktop/run-channel` names in `PIWI_EDITOR_SEND`.

  Neither the CLI nor a run's environment is ever given the desktop token (`tests/unit/assistant-claude-code.test.ts`,
  `tests/unit/desktop-runs.test.ts`), but a reproduction, a bisect step and `piwi flake`, whose reporter may predate
  `PIWI_DESKTOP_APP=prefer`: they carry the app's address and token, and `prefer` with the discovery file's path, so a
  reporter that knows it takes both from the file before a server its config names (`flake_lab_env` in `worktree.rs`).
  They also carry `PIWI_DESKTOP_KEY=1`, which marks `PIWI_API_KEY` as the app's token: a reporter or `piwi` that knows
  the marker sends it only after the server proves it holds it (`proveDesktopServer`), the same proof the discovery
  file's token gets.

- **A run a team instance asked for starts from the bundled server's launch, never from the window's words**
  (`src-tauri/src/run_target.rs`). The window names the request id alone; the shell takes the command **Run** approved,
  its folder and the request token once from `POST /api/desktop/run-target/requests/:id/launch` (shell-only,
  `isBrowserRequest`), refuses no arguments or a folder linked since, writes the token to a private file for the
  reporter (`PIWI_REQUEST_TOKEN_FILE`) and deletes it when the run ends. The instance's key lives in the OS keychain,
  read only while `runTargetInstance` is set, handed to the server after each start (`hand_kept_key`), never to the
  window; a stop from the dashboard reaches the shell on its notification stream.
- **The discovery file is a cross-package contract.** The shell publishes `{ url, token, pid, projects }` to
  `~/.piwi/desktop.json` while it runs, rewrites it when a folder link changes (`projects` is `[{ id, path }]`, the
  linked folders), and deletes it on quit. Its readers:
  - `@piwitests/reporter`, from `src/internal/config/desktop.ts`;
  - `src-tauri/src/mcp_stdio.rs`, which resolves the app's address from it on every message;
  - the editor service (`packages/editor/src/context.ts`), which picks the project linked to the workspace;
  - the bundled server (`apps/application/server/utils/desktop-links.ts`), which reads a project's linked folder to
    read its git history locally, trusting the file only when its token is the server's own `PIWI_DESKTOP_TOKEN`.

  They ship separately, so changing the path or the shape means changing all of them; a new field is fine, since
  every reader ignores the ones it does not know.

- **`piwi-desktop mcp-stdio` is a published entry point.** The one-click setup of every MCP client (`mcp_clients.rs`)
  writes that command into the client's config on the user's machine, with no URL and no token, so the argument can
  only be added to and the bridge keeps speaking newline-delimited JSON-RPC on stdin/stdout
  ([the rest](ARCHITECTURE.md#mcp-client-configs)).
- **The token is never in a URL.** The shell asks the server for a session code on the proven connection
  (`POST /api/desktop/run-target/session-code`, shell-only), and `/__piwi/session?code=…` takes it once, within 30
  seconds, to set the cookie. A used, expired or unknown code, and the token itself, open nothing; a server that gives
  no code gets no session.
- **Each Windows installer updates from its own manifest.** The `.msi` installs per machine (admin) and reads
  `latest.json`; the NSIS `.exe` installs per user (`installMode: currentUser`, no admin) and reads `latest-nsis.json`.
  The two `tauri.updater*.conf.json` overlays and `reusable-publish-desktop.yml` keep them apart, so a per-user install
  never updates into the per-machine one.
- **The `.exe` installer and the shell share the port setting.** Its welcome page records the confirmed port in
  `installer.json` in the app data folder (the `identifier` of `tauri.conf.json`), which `adopt_installer_choices` in
  `lib.rs` moves into `settings.json` (`serverPort`); the Rust test `the_windows_installer_writes_where_the_shell_reads`
  keeps the names, the default, the range and the refused ports of `windows/installer-hooks.nsh` and `lib.rs` together.
- **The installer art is rendered, never edited by hand**: `npm run installer-art` (`scripts/installer-art.mjs`) draws
  `src-tauri/windows/*.bmp` from the logos in `apps/application/public/`, as BMPs at the sizes the NSIS and WiX pages
  show them.
- **The `runner` cargo feature builds Piwi Runner from this crate.** It swaps the entry (`runner_app::run`), the
  product, the sidecar's script and the keychain service, and shares the rest of `run_target.rs`, the window guards and
  the supervisor ([layout](../runner/ARCHITECTURE.md#the-shell-build)).
- **Piwi Runner has no tray, updater or hub of its own and never writes `~/.piwi/desktop.json`.** Nothing in
  `runner_app.rs` adds any of them, and `runner_app` compiles with and without the feature so `cargo test` covers both.
- **Front-end code that behaves differently inside the shell** uses `useIsDesktop` and the helpers of
  `packages/run-ui/app/composables/useTauri.ts` (`tauriCore`, `tauriEvent`), and the `app/components/desktop/` cards: do not sniff
  user agents.
- **The sidecar layout** (`src-tauri/binaries/node-<triple>`, `src-tauri/resources/app-server/.output/`) is what the
  packaging scripts and CI (`reusable-publish-desktop.yml`, `reusable-e2e-desktop.yml`) expect; changing it means
  updating both.
- **Commit scope**: `app` for a desktop feature whose code lands in the shared `apps/application/` server or UI (where
  backend work goes, behind a desktop guard: the common case), `desktop` for a change confined to this directory (the
  shell and its scripts), and `ci` for CI-only. All three are valid commitlint scopes.

## Commands

From `apps/desktop/`:

```bash
npm run fetch-node   # download the Node sidecar binary for this platform
npm run stage        # stage the built server (npm run app:build in apps/application first) into src-tauri/resources
npm run dev          # tauri dev — run the shell against a staged server
npm run build        # produce the platform installer
npm run installer-art # render the Windows installers' artwork (needs the root's npm ci)
npm run e2e          # Playwright smoke test of the shell integration
cargo test --manifest-path src-tauri/Cargo.toml   # the shell's Rust unit tests
```

`build.rs` runs `tauri-build`, which copies the Node sidecar, the staged server and the app icons into the bundle and
fails when any of them is missing. So `cargo test` needs `fetch-node`, `stage` and
`npx tauri icon ../application/public/logo.svg` to have run first; `reusable-e2e-desktop.yml` does all three before it
runs the tests.
