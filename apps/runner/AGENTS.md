# Piwi Runner: agent guide

Rules for working inside `apps/runner/` (`@piwitests/runner`). Piwi Runner is the small app that runs the tests a team
instance asks for on this machine (**Run on my machine**), without the dashboard: a window for the connection and the
confirmation, and a Node host that serves it. Read [`../../AGENTS.md`](../../AGENTS.md) first for the repository-wide
conventions, and [`../desktop/AGENTS.md`](../desktop/AGENTS.md) for the Tauri shell, which is the desktop app's crate
built with the `runner` feature.

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

## Rules

- **The window shares, it does not copy.** The connection card, the confirmation and the stream of the host's events
  come from `packages/run-ui` by auto-import. A change both windows need goes there. The window's own files are the
  run list and its frame; it has no router, no store of its own beyond the run list, and no network call but the
  shared layer's: the `/api/desktop/run-target/*` routes and the `/api/desktop/events` stream.
- **The shell runs the tests, the window shows them.** A confirmed request calls the shell's
  `desktop_run_requested_tests` with the request id alone; the shell reads the command and the request token from the
  host. Output arrives as `piwi:local-run` events and Stop calls `desktop_stop_local_tests`.
- **The run logic is not here.** The held requests, the reconnect key, the temp folders and the routes live in
  `@piwitests/editor` (`request-host.ts`, `run-target.ts`, `run-target-http.ts`); this host only wires them to
  `node:http`. The dashboard's desktop build serves the same routes through Nitro, and the two answer the same
  (`packages/editor/tests/run-target-routes.test.ts`). Do not copy a route, a guard or a limit of the shared routes
  into this app; the guard of `serveRunTarget` is the editor's. The `Host` check in `server/host.ts`
  (`isLoopbackHost`) is the one this host adds in front of it, for the window's files and the readiness probe.
- **The host has no database, no account and no other API.** Any path under `/api/` or `/__piwi/` that the shared
  routes do not serve is a 404. Do not add a route here that the dashboard's desktop build does not also serve.
- **It listens on `127.0.0.1` alone and checks `Host`.** A request whose `Host` is not a loopback address is refused
  with 421. The access token (`PIWI_DESKTOP_TOKEN`) opens every route except the readiness probe, the session
  bootstrap (which takes the token on its query string) and the window's files.
- **The launch nonce** (`PIWI_DESKTOP_LAUNCH_NONCE`) is echoed by `/api/health`, so the shell loads its session only from
  the host it started.
- **Nothing is stored.** The key lives in the OS keychain (the shell keeps it, under Runner's own service name), the
  folders in the shell's settings; the host keeps requests in memory only.
- **The shell writes no `~/.piwi/desktop.json`.** That file names a dashboard to the reporter, the editor clients and the
  MCP bridge; Runner is not one.

## Commands

```bash
npm run runner:test          # unit tests (vitest)
npm run runner:typecheck     # host and tests (tsc), then the window (nuxt typecheck; after runner:prepare)
npm run runner:lint
npm run runner:format:check
npm run runner:build         # dist/server.cjs (the host)
npm run runner:window        # .output/public (the window, `nuxt generate`)
npm run runner:stage         # copies dist/server.cjs and .output/public into the shell's resources/runner-host
```

The app itself is built from the desktop crate: after `runner:build`, `runner:window` and `runner:stage`, run
`npx tauri build --features runner --config runner.conf.json` from `apps/desktop`.
Signing, installers and publishing are not wired yet.
