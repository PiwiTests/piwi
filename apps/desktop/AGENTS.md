# Desktop app — agent guide

Rules for working inside `apps/desktop/` (the Tauri shell that bundles and runs the dashboard locally). Read
[`../AGENTS.md`](../AGENTS.md) first for repo-wide conventions, and [`README.md`](README.md) for how the shell works,
build prerequisites and the release flow.

## What it is

A [Tauri](https://tauri.app) window around **the same Nuxt/Nitro server** shipped as the Docker image and
`@piwitests/server`. On launch the Rust shell picks a free loopback port, resolves a per-user data dir, spawns the
bundled server as a **Node sidecar**, polls `GET /api/health` until the database is migrated, then points the window at
it through a one-time token bootstrap (`/__piwi/session`). Targets are Windows (`.msi` and `.exe`), macOS (`.dmg`) and
Linux (`.deb` / `.rpm` / `.AppImage`), all three feature-equivalent and built from the same shell. The two Windows
installers ship side by side: the `.msi` installs per machine (admin); the NSIS `.exe` installs per user
(`installMode: currentUser`, no admin) and updates from its own manifest (`latest-nsis.json`, not the `.msi`'s
`latest.json`), so a per-user install never updates into the per-machine one (see `reusable-publish-desktop.yml` and the two
`tauri.updater*.conf.json` overlays).

## Rules

- **Never fork the server.** The desktop app must keep running the unmodified built server. Anything the shell needs
  from the backend goes in `apps/application/` behind a desktop-aware guard, not into a desktop-only copy.
- **The window trusts only the sidecar it spawned.** The readiness probe requires the per-launch nonce the shell
  passes the sidecar (`PIWI_DESKTOP_LAUNCH_NONCE`, echoed by `/api/health`) before loading the session bootstrap;
  the main window may only navigate to its bundled pages and the sidecar's exact origin; and the IPC capability
  (`src-tauri/runtime-capabilities/remote.json`) is added at startup for that origin only, never for a port
  wildcard. A command that turns webview input into a path or a process takes only known values: digits-only
  project ids, the known IDE launcher names (`is_known_launcher`).
- **Everything binds `127.0.0.1`.** Local access is gated by a per-launch token enforced by
  `apps/application/server/middleware/desktop-guard.ts` — so only the app, not other local processes or browser pages, can
  reach the bundled API. Any new desktop-only route must stay behind that guard. The guard leaves three open
  (`isOpenDesktopRoute` in `server/utils/desktop-access.ts`): the readiness probe, and Piwi Picker's pairing start and
  poll, which it sends before it holds the token. The start answers only an extension's JSON request and keeps at most
  three waiting; the poll answers only with the secret the start gave; the token goes out once, after **Allow** in the
  window (`DesktopPickerPairingModal`), behind the guard. A route added to that list needs the same care.
- **The reporter discovery file is a cross-package contract.** The shell publishes `{ url, token, projects }` to
  `~/.piwi/desktop.json` while it runs, rewrites it when a folder link changes (`projects` is `[{ id, path }]`, the
  linked folders), and deletes it on quit; `@piwitests/reporter` reads it from `src/internal/config/desktop.ts`,
  `src-tauri/src/mcp_stdio.rs` resolves the app's address from it on every message, the editor service
  (`packages/editor/src/context.ts`) picks the project linked to the workspace from it, and the bundled server
  (`apps/application/server/utils/desktop-links.ts`) reads a project's linked folder from it to read its git history
  locally, trusting the file only when its token is the server's own `PIWI_DESKTOP_TOKEN`. They ship separately, so
  changing the path or the shape means changing all of them; a new field is fine, since every reader ignores the
  ones it does not know.
- **`piwi-desktop mcp-stdio` is a published entry point.** Claude Desktop takes only stdio MCP servers, so its
  one-click setup writes that command into `claude_desktop_config.json` on the user's machine. Renaming the argument
  breaks every config already written — it can only be added to, and the bridge must keep speaking newline-delimited
  JSON-RPC on stdin/stdout.
- Front-end code that behaves differently inside the shell uses the `useIsDesktop` / `useTauri` composables and the
  `app/components/desktop/` cards — do not sniff user agents.
- The sidecar layout (`src-tauri/binaries/node-<triple>`, `src-tauri/resources/app-server/.output/`) is what the
  packaging scripts and CI (`reusable-publish-desktop.yml`, `reusable-e2e-desktop.yml`) expect; changing it means updating
  both.
- Commit scope: `app` for a desktop feature whose code lands in the shared `apps/application/` server or UI (where
  backend work goes, behind a desktop guard — the common case), `desktop` for a change confined to this directory (the
  shell and its scripts), and `ci` for CI-only. All three are valid commitlint scopes.

## Commands

```bash
npm run fetch-node   # download the Node sidecar binary for this platform
npm run stage        # build the server and stage it into src-tauri/resources
npm run dev          # tauri dev — run the shell against a staged server
npm run build        # produce the platform installer
npm run e2e          # Playwright smoke test of the shell integration
cargo test --manifest-path src-tauri/Cargo.toml   # the shell's Rust unit tests
```

`build.rs` copies the Node sidecar, the staged server and the app icons into the bundle, and fails when any of them is missing — so `cargo test` needs `fetch-node`, `stage` and
`npx tauri icon ../application/public/logo.svg` to have run first. `reusable-e2e-desktop.yml` does all three before it runs the tests.
