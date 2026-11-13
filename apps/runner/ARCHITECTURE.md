# Piwi Runner architecture

How `apps/runner/` is put together and how the desktop crate builds it. The rules are in [`AGENTS.md`](AGENTS.md).
This file is reference material: open it when you need to understand the code.

## What it holds

| Path                                                           | What                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/host.ts`                                               | The `node:http` host: the readiness probe, `serveRunTarget`, `serveShellRuns`, the window's files                                                                                                    |
| `server/main.ts`                                               | The sidecar's entry: reads the shell's environment, opens the runs' hub and listens on `127.0.0.1`                                                                                                   |
| `server/runs.ts`                                               | What the runs' hub says of Runner, and its run channel's folder prefix (`piwi-runner-run-`)                                                                                                          |
| `scripts/build.mjs`                                            | Bundles the host into `dist/server.cjs`, stamped with this package's version                                                                                                                         |
| `nuxt.config.ts`                                               | The window: a single-page app (`ssr: false`) extending `packages/run-ui`; `npm run runner:window` builds it                                                                                          |
| `app/app.vue`                                                  | The window: the connection card, the runs, and the confirmation of a run request                                                                                                                     |
| `app/utils/runner-runs.ts`, `app/composables/useRunnerRuns.ts` | The runs list: start, output, stop, Hold failures, the shell's `piwi:local-run` events, and the hub's name of each run                                                                               |
| `app/components/RunnerRunList.vue`                             | One card per run: its status, Stop, its workers live from the hub (`DesktopRunSession`, the layer's), its output                                                                                     |
| `app/plugins/runner-run-hub.client.ts`                         | The window on the hub's stream: held from its start until the hub listed its runs, then while a run runs or the hub has one; present while visible, `show` for Hold failures, to the front at a stop |
| `tests/`                                                       | The host on a real socket                                                                                                                                                                            |

## The shell build

Piwi Runner is the desktop crate (`apps/desktop/src-tauri`) built with the `runner` cargo feature and
`runner.conf.json`. The feature swaps these, and the rest of `run_target.rs`, the window guards and the supervisor are
shared with the desktop app:

- **The entry**: `runner_app::run`, which refuses to start unless the identifier is `io.piwitests.runner`.
- **The product**: the name "Piwi Runner", the identifier, the binary `piwi-runner`, one window, no file associations
  and installer hooks of its own: `windows/runner-installer-hooks.nsh`, which stop its host before the `.exe`
  installer writes a file, with the macro the desktop app's hooks use (`windows/stop-sidecar.nsh`), and none of the
  desktop app's port page. `runner.conf.json` is merged over `tauri.conf.json` as a JSON merge patch
  (`apps/runner/tests/bundle-config.test.ts` checks the merge).
- **The link**: `piwi-runner://connect` only, which brings the window forward.
- **The sidecar**: Node bundled as `piwi-runner-node` (`NODE_SIDECAR`), as the desktop app's is `piwi-desktop-node`, so
  the Linux packages of the two apps and the distribution's `nodejs` never install the same file, and its script,
  `resources/runner-host`, staged by `npm run runner:stage`.
- **The icon**: `apps/runner/app-icon.svg`, the Piwi mark on a teal tile with a play sign, rendered into
  `src-tauri/icons-runner/` by `tauri icon`; the app, the tray and the Windows installers take it.
- **The keychain service**: `Piwi Runner run requests`, so an entry written by one app is never read by the other.

The Release workflow builds it with the same steps: the host, the window and the staging, then tauri-action with
`--features runner --config src-tauri/runner.conf.json`, which only builds. `scripts/release-files.mjs` copies the
installers and their signatures to the names `ASSET_NAME_PATTERN` gives them ("Piwi-Runner_<arch>", no version), and
`gh release upload --clobber` attaches them to the tag's release, beside the desktop app's "Piwi-Desktop_…", printing
GitHub's answer to an attempt that fails. Off a tag it keeps them as the run's artifacts.

The two apps install side by side: each has its own identifier, product name, binary, sidecar, install folder, Linux
package name, MSI upgrade code and keychain service, so neither installer replaces the other.

`runner_app` is compiled with and without the feature, so `cargo test` covers both.

## The runs' hub

Runner's host is the hub of the runs its shell starts, as the dashboard's desktop build is of its own: the same
`ShellRuns` of `@piwitests/editor`, in Runner's words. As a requested run starts, the shell reads
`GET /api/desktop/run-channel` from the host that proved its token and adds `PIWI_RUN_CHANNEL`, `PIWI_EDITOR_SEND` and
`PIWI_RUN_REF` to the run (`bundled_hub_env`), so each worker keeps a run connection to the host. The runs' folders are
the ones the shell links to the instance's projects (`linkedFolders` of `run-target`), and the code from a stop is made
for their files alone. The window reaches the hub through `GET /api/desktop/runs/events` and
`POST /api/desktop/runs/commands` (`useDesktopRunHub` of the layer, held by `plugins/runner-run-hub.client.ts`) and
shows each running run's workers live (`DesktopRunSession`); a run's picks come back on `POST /api/desktop/runs/picks` with a token for that
route alone. The hub's WebSocket listens behind the access token, but nothing names it to another tool: Runner writes no
discovery file, observes no editor's runs, serves no agent tools and reads no lane's trace for **Inspect**: its window
provides no `RUN_VIEW_HOST`, so a lane offers no Inspect there.

## Quitting

Closing the window and the app menu's Quit (Cmd+Q on macOS) ask for confirmation while a run is going
(`hold_close_for_local_runs`, `quit_after_confirming`), and so does the tray's Quit. While Run in background is on
(the default: Runner is how the team instance reaches this machine), closing the window hides it to the tray instead,
and a request that arrives brings it back (`desktop_bring_to_front`). Start on login launches it with `--hidden`, in the
tray. The window's `RunnerBackgroundSettings` holds the same two toggles, through `desktop_get_service_settings`,
`desktop_set_run_in_background` and `desktop_set_start_on_login`, for a desktop with no tray host; the shell keeps
the tray's checks in step (`BackgroundMenu`). The tray's **Check for updates…** asks in native dialogs before it installs, and restarts through the same
question about runs going (`updates::check_from_tray`). The ways out that cannot be
held, Quit from the Dock on macOS and logging out or shutting down on macOS and Windows, reach only `RunEvent::Exit`,
with no hook before it: they stop Runner's runs without asking (`shut_down` still runs). On Linux the
session's end stops the app without `shut_down`. The desktop app has the same exits
([`apps/desktop/README.md`](../desktop/README.md)).
