# Piwi Dashboard — Desktop app

A [Tauri](https://tauri.app) shell that bundles the **same** Nuxt/Nitro server
shipped as the Docker image and `@piwitests/server`, and runs it locally. No
Docker, no `npx`, no server to set up — double-click and go. Everything binds
`127.0.0.1`; your data lives under the OS app-data directory.

Targets: **Windows (`.msi` and `.exe`)**, **macOS (`.dmg`, Apple silicon, macOS 13.5 or
later, the floor of the bundled Node 24 runtime)**, and **Linux (`.deb` /
`.rpm` / `.AppImage`)**. The Windows **`.exe`** is an NSIS **per-user** installer
(`%LOCALAPPDATA%`, no admin to install or update); the **`.msi`** installs **per
machine** (`Program Files`) and needs elevation. Each keeps its own auto-update
channel, so a per-user install pulls a per-user update.

## How it works

1. On launch the Rust shell picks a free loopback port, resolves a per-user data
   dir (`app_data_dir()/.data`), and spawns the bundled server as a **Node
   sidecar** (`src-tauri/binaries/node-<triple>` running
   `src-tauri/resources/app-server/.output/server/index.mjs`).
2. It polls `GET /api/health` (200 = database migrated) until the answer
   carries the random nonce the shell gave this launch's sidecar
   (`PIWI_DESKTOP_LAUNCH_NONCE`, echoed in `X-Piwi-Desktop-Nonce`), so another
   process that took the port never receives the token, then points the window
   at the server via a one-time token bootstrap (`/__piwi/session`). The
   window may only navigate to its bundled pages and that server's exact origin,
   and the app's IPC commands are granted to that origin alone
   (`src-tauri/runtime-capabilities/remote.json`, added at startup for the port).
   The splash says when the server takes longer than a minute and keeps waiting;
   it says the server stopped once the supervisor, which restarts a crashed server
   with a backoff, gives up. The dashboard shows the restarts as a toast
   (`server-status` events).
3. The tray offers **Run in background** (keep serving after the window closes),
   **Start on login**, and **Open data folder**.
4. The dashboard can link a Piwi project to a folder on this machine and run
   `playwright test` there (`src-tauri/src/runner.rs`): the shell resolves the
   folder's own Playwright package, executes it with the bundled Node sidecar,
   and streams output back to the webview as `piwi:local-run` events. Those
   processes die with the shell, so every way out — closing the window, the
   tray's Quit, or an update restart — asks for confirmation first while any
   of them is still running.
5. Files the OS hands to the app (drag & drop, "Open with", second-launch
   file arguments, macOS open events) are queued shell-side and drained by the
   dashboard over IPC (`desktop_take_pending_open_files` + a `piwi:open-files`
   poke), which imports them by path through the desktop-only routes:
   Playwright archives (`.zip`) through `/api/desktop/import-local`, and Piwi
   Picker's bug reports (`.piwibug`, the app's own file type, associated in
   `tauri.conf.json` with a macOS exported type) through
   `/api/desktop/import-bug-report`.
6. The dashboard's /mcp page can write the `piwi-desktop` MCP entry into detected
   clients' config files (`src-tauri/src/mcp_clients.rs`): strict-JSON merge
   of one key with a backup next to the file, and a startup pass that rewrites
   entries whose URL/token drifted after a port change.
7. Native notifications shown while the window is hidden bump an unread badge
   on the dock icon and the tray tooltip (`desktop_set_activity`), cleared
   when the window regains focus.
8. A dashboard link opened in the system browser (the reporter's `View run:`
   URL clicked in a terminal) shows in the app window instead: the server
   answers the tab with a notice and forwards the page as an `open-page`
   message on `/api/desktop/events`
   (`apps/application/server/middleware/desktop-handoff.ts`); the window
   navigates to it and calls `desktop_bring_to_front`, which restores, shows
   and focuses it. Only navigations the browser marks `Sec-Fetch-Site: none`
   qualify, so a web page cannot drive the window.

Local access is gated by a per-launch token (see
`apps/application/server/middleware/desktop-guard.ts`), so only the app — not other
local processes or browser pages — can reach the bundled API.

## Build locally

Prerequisites: Node 24+, the [Rust toolchain](https://rustup.rs), and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```bash
# 1. Build the server bundle (from the repo root)
npm run app:build --workspace=apps/application

# 2. Fetch the Node sidecar for this machine + stage the server (from apps/desktop/)
cd desktop
npm run fetch-node          # downloads the official Node binary for this OS
npm run stage               # copies .output + installs native modules
npx tauri icon ../application/public/logo.svg   # generate icons (once)

# 3. Run in dev, or build an installer
npm run dev                 # launches the app against the staged server
npm run build               # produces the installer for this OS under src-tauri/target
                            # (.msi + .exe on Windows, .dmg on macOS, .deb/.rpm/.AppImage on Linux)
```

> The Node sidecar (`src-tauri/binaries/`), the staged server
> (`src-tauri/resources/app-server/`), generated icons, and `src-tauri/target/` are all
> git-ignored build artifacts — CI regenerates them (see
> `.github/workflows/reusable-publish-desktop.yml`).

## End-to-end tests

`apps/desktop/e2e/` drives the **real** shell webview with Playwright, via
[`tauri-plugin-playwright`](https://crates.io/crates/tauri-plugin-playwright).
This is the only layer that catches runtime issues the compiler can't — most
importantly that the dashboard (served at a loopback origin) may actually call
the shell's native commands, which Tauri gates per-origin via the capabilities.

The plugin is compiled in **only** under the `e2e-testing` cargo feature (never
in shipped installers), and the capability it needs is added at runtime, also
behind that feature. Run it after building + staging the server:

```bash
# from the repo root: build the server the shell will bundle
npm run app:build --workspace=apps/application

# from apps/desktop/: stage the sidecar + server, then run the tests
cd desktop
npm install
npm run fetch-node
npm run stage
npx tauri icon ../application/public/logo.svg   # once
npm run e2e                                      # launches `tauri dev --features e2e-testing`
```

CI runs this on macOS (real webview, no display server needed) on pull
requests that change the desktop app — see `.github/workflows/reusable-e2e-desktop.yml`,
which `ci.yml` calls.

This `e2e/` suite is a **shell smoke test** (the real webview calling native
commands). To exercise the *dashboard's* full E2E suite against a running
desktop app instead — the same server, driven through its loopback origin —
launch the app and run `npm run app:test:desktop` from `apps/application/`
(`PIWI_DESKTOP_E2E=1`); it adopts the app's URL + token from `~/.piwi/desktop.json`.
See [`apps/application/tests/README.md`](../application/tests/README.md#against-the-running-desktop-app).

## Signing

Installers carry no publisher signature unless code-signing secrets are
configured, in which case CI signs (and notarizes on macOS) automatically. They
still run: on macOS, open the app once, then **Open Anyway** in System Settings →
Privacy & Security; on Windows, "More info → Run anyway" in SmartScreen.

On macOS the app is always signed, **ad hoc** when no Developer ID is configured
(`bundle.macOS.signingIdentity: "-"` in `tauri.conf.json`). Apple silicon opens a
downloaded app only when a signature seals the whole bundle; without one,
Gatekeeper reports the app as damaged and offers no way to open it. A Developer ID
set through `APPLE_SIGNING_IDENTITY` takes the place of the ad-hoc identity.

The bundler signs the Node sidecar too, under the hardened runtime, with the
entitlements in `src-tauri/macos/entitlements.plist`: the ones Node.js signs its
own binary with, minus the debugger one. V8 needs JIT and writable executable
memory, and Node loads native modules no team signed (sharp, libSQL, and those of
a linked project when it runs Playwright). Without them the sidecar crashes on
start and the window reports that the server stopped and could not be restarted.
`reusable-publish-desktop.yml` checks both on every macOS build: the bundle's
signature (`codesign --verify --strict`), then the server started from the bundle
with its own Node, until `/api/health` answers.

## In-app updates

Off until the updater keypair exists; releases build exactly as before without
it. To enable:

1. `npx tauri signer generate` (keep the private key + password secret).
2. Put the **public** key into both `src-tauri/tauri.updater.conf.json` (the
   `.msi` channel) and `src-tauri/tauri.updater.nsis.conf.json` (the `.exe`
   channel). Same key, one endpoint each.
3. Add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as
   repository secrets.

With the secret present, `reusable-publish-desktop.yml` applies each leg's overlay:
bundles gain signed update artifacts, and the app (whose compiled config now
contains the updater entry) exposes Check for updates in Settings → About.
Windows ships **two update channels** so each installer updates itself in its own
mode: the `.msi` reads `latest.json` (per machine, prompts for admin), the `.exe`
reads `latest-nsis.json` (per user, no admin). tauri-action uploads `latest.json`
for the `.msi`, macOS and Linux legs; the `.exe` leg sets `uploadUpdaterJson`
false and a later workflow step publishes `latest-nsis.json` pointing at the NSIS
`-setup.exe`. The macOS leg builds the `app` bundle next to the `.dmg`: the
bundler makes the macOS update artifact (`.app.tar.gz`) from it only. Builds
without the overlay report updates as unsupported, the plugin
is not even registered there (see `src-tauri/src/updates.rs`).

The `.exe` channel installs **quietly**: its overlay sets the updater's
`windows.installMode` to `quiet`, so the plugin starts the NSIS installer with
`/S /R` — no window, and the installer relaunches the app when it is done. The
`.msi` channel keeps the default `passive` mode (a progress bar): its
per-machine install needs the UAC prompt, which a quiet `msiexec` cannot raise.

When startup settles (the server answered, or its wait timed out), the shell
checks for an update and shows a native notification when one is available (`notify_if_update_available` in
`updates.rs`). Settings → About → Updates shows the update it found and has a
checkbox, on by default, that turns the notification off (`notifyUpdateOnStartup`
in the app's `settings.json` store).

On Windows the install step never returns: the plugin launches the installer and
leaves through `std::process::exit`, which skips `RunEvent::ExitRequested`. The
updater's pre-exit hook (`updates.rs`) runs the quit cleanup instead
(`shut_down` in `lib.rs`) and waits for the Node sidecar to be gone — left
running, it holds the bundled native modules (sharp's libvips DLLs) and the
installer fails with "Error opening file for writing". Builds up to 0.37 lacked
that hook, so the NSIS installer also stops a `node.exe` still running from its
install folder (`src-tauri/windows/installer-hooks.nsh`) before copying files.
