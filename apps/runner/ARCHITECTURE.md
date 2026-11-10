# Piwi Runner architecture

How `apps/runner/` is put together and how the desktop crate builds it. The rules are in [`AGENTS.md`](AGENTS.md).
This file is reference material: open it when you need to understand the code.

## What it holds

| Path                                                           | What                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `server/host.ts`                                               | The `node:http` host: the readiness probe, `serveRunTarget`, the window's files                             |
| `server/main.ts`                                               | The sidecar's entry: reads the shell's environment and listens on `127.0.0.1`                               |
| `scripts/build.mjs`                                            | Bundles the host into `dist/server.cjs`, stamped with this package's version                                |
| `nuxt.config.ts`                                               | The window: a single-page app (`ssr: false`) extending `packages/run-ui`; `npm run runner:window` builds it |
| `app/app.vue`                                                  | The window: the connection card, the runs, and the confirmation of a run request                            |
| `app/utils/runner-runs.ts`, `app/composables/useRunnerRuns.ts` | The runs list: start, output, stop, and the shell's `piwi:local-run` events                                 |
| `app/components/RunnerRunList.vue`                             | One card per run: its status, its output, and Stop while it runs                                            |
| `tests/`                                                       | The host on a real socket                                                                                   |

## The shell build

Piwi Runner is the desktop crate (`apps/desktop/src-tauri`) built with the `runner` cargo feature and
`runner.conf.json`. The feature swaps these, and the rest of `run_target.rs`, the window guards and the supervisor are
shared with the desktop app:

- **The entry**: `runner_app::run`, which refuses to start unless the identifier is `io.piwitests.runner`.
- **The product**: the name "Piwi Runner", the identifier, the binary `piwi-runner`, one window, no file associations
  and no installer hooks. `bundle.windows.nsis.installerHooks` is `null` in `runner.conf.json`, which is merged over
  `tauri.conf.json` as a JSON merge patch (`apps/runner/tests/bundle-config.test.ts` checks the merge).
- **The link**: `piwi-runner://connect` only, which brings the window forward.
- **The sidecar's script**: `resources/runner-host`, staged by `npm run runner:stage`.
- **The keychain service**: `Piwi Runner run requests`, so an entry written by one app is never read by the other.

The Release workflow builds it with the same steps: the host, the window and the staging, then tauri-action with
`--features runner --config src-tauri/runner.conf.json`, which names the files from that merged config
("Piwi Runner_<version>_<arch>"), so they never match the dashboard's. It keeps them as the run's artifacts and attaches
nothing to the release.

`runner_app` is compiled with and without the feature, so `cargo test` covers both.

## Quitting

Closing the window and the app menu's Quit (Cmd+Q on macOS) ask for confirmation while a run is going
(`hold_close_for_local_runs`, `quit_after_confirming`); Runner has no tray and no updater. The ways out that cannot be
held, Quit from the Dock on macOS and logging out or shutting down on macOS and Windows, reach only `RunEvent::Exit`,
with no hook before it: they stop Runner's runs without asking (`shut_down` still runs). On Linux the
session's end stops the app without `shut_down`. The desktop app has the same exits
([`apps/desktop/README.md`](../desktop/README.md)).
