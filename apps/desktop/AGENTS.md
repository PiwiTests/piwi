# Desktop app: agent guide

Rules for working inside `apps/desktop/` (the Tauri shell that bundles and runs the dashboard locally). Read
[`../../AGENTS.md`](../../AGENTS.md) first for repo-wide conventions, and [`README.md`](README.md) for how the shell
works, the build prerequisites, the end-to-end tests, signing and the update channels.

The shell is a [Tauri](https://tauri.app) window around **the same built Nuxt/Nitro server** shipped as the Docker
image and `@piwitests/server`. The Rust code (`src-tauri/src/`) spawns that server as a **Node sidecar** on a loopback
port, waits for `GET /api/health`, then points the window at it through a one-time token bootstrap (`/__piwi/session`).
The installers (Windows `.msi` and `.exe`, macOS `.dmg`, Linux `.deb` / `.rpm` / `.AppImage`) are built from the same
shell and are feature-equivalent.

## Rules

- **Never fork the server.** The desktop app must keep running the unmodified built server. Anything the shell needs
  from the backend goes in `apps/application/` behind a desktop-aware guard, not into a desktop-only copy.
- **The window trusts only the sidecar it spawned.**
  - The readiness probe requires the per-launch nonce the shell passes the sidecar (`PIWI_DESKTOP_LAUNCH_NONCE`,
    echoed by `/api/health`) before it loads the session bootstrap.
  - The main window may only navigate to its bundled pages and the sidecar's exact origin
    (`main_window_may_navigate` in `src-tauri/src/lib.rs`).
  - Its `window.open()` opens only a named blank page, `about:blank#<name>` (`output_window_name`, `output_window`):
    a window that never navigates elsewhere and holds no IPC grant, which the dashboard renders a run's output into
    (`DesktopSeparateWindow`) and closes with `desktop_close_output_window`, since a page's `window.close()` closes
    its native window on Windows only. The main window is built in `setup` for that handler (`"create": false`).
  - The IPC capability (`src-tauri/runtime-capabilities/remote.json`) is added at startup for that origin only, never
    for a port wildcard, and no capability under `src-tauri/capabilities/` grants remote content.
  - A command that turns webview input into a path or a process takes only known values: digits-only project ids,
    hexadecimal request ids, skill slugs of lowercase letters, digits and dashes, the known IDE launcher names
    (`is_known_launcher`).
- **A new Tauri command is wired in three places**: `tauri::generate_handler!` in `src-tauri/src/lib.rs`, the
  `.commands(&[…])` list in `src-tauri/build.rs`, and an `allow-*` grant in `runtime-capabilities/remote.json`.
  Without all three, the window's `invoke` is refused at runtime; `apps/application/tests/unit/desktop-acl-consistency.test.ts`
  fails until they match.
- **Everything binds `127.0.0.1`, behind the desktop token.** Every `/api` and `/mcp` request must present the
  per-install access token (`PIWI_DESKTOP_TOKEN`), enforced by `apps/application/server/middleware/desktop-guard.ts`,
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
  `GET /api/desktop/run-channel` only after `health_ok` proved the launch nonce, and `PIWI_RUN_REF` (`hub_env.rs`,
  `desktop-<run id>`, which the window knows the run by). A run nobody attends (Flake Lab, a bisect, a lab job, one
  with `--repeat-each` above 1 or `--ui`) ends its ref in `-unattended` (`attended_args`), and the server never holds
  its failures. The hub's WebSocket takes the desktop token in `hello`; its code is
  `apps/application/server/utils/desktop-runs.ts`. Agents steer those runs only through `/mcp`, behind the same token
  (`server/utils/mcp/run-tools.ts`), and never a run nobody attends.
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
- **`piwi-desktop mcp-stdio` is a published entry point.** Claude Desktop takes only stdio MCP servers, so its
  one-click setup writes that command into `claude_desktop_config.json` on the user's machine. Renaming the argument
  breaks every config already written: it can only be added to, and the bridge must keep speaking newline-delimited
  JSON-RPC on stdin/stdout.
- **Each Windows installer updates from its own manifest.** The `.msi` installs per machine (admin) and reads
  `latest.json`; the NSIS `.exe` installs per user (`installMode: currentUser`, no admin) and reads `latest-nsis.json`.
  The two `tauri.updater*.conf.json` overlays and `reusable-publish-desktop.yml` keep them apart, so a per-user install
  never updates into the per-machine one.
- **Front-end code that behaves differently inside the shell** uses `useIsDesktop` and the helpers of
  `app/composables/useTauri.ts` (`tauriCore`, `tauriEvent`), and the `app/components/desktop/` cards: do not sniff
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
npm run e2e          # Playwright smoke test of the shell integration
cargo test --manifest-path src-tauri/Cargo.toml   # the shell's Rust unit tests
```

`build.rs` runs `tauri-build`, which copies the Node sidecar, the staged server and the app icons into the bundle and
fails when any of them is missing. So `cargo test` needs `fetch-node`, `stage` and
`npx tauri icon ../application/public/logo.svg` to have run first; `reusable-e2e-desktop.yml` does all three before it
runs the tests.
