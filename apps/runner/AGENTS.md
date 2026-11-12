# Piwi Runner: agent guide

Rules for working inside `apps/runner/` (`@piwitests/runner`). Piwi Runner is the small app that runs the tests a team
instance asks for on this machine (**Run on my machine**), without the dashboard: a window for the connection and the
confirmation, and a Node host that serves it. Read [`../../AGENTS.md`](../../AGENTS.md) first for the repository-wide
conventions, and [`../desktop/AGENTS.md`](../desktop/AGENTS.md) for the Tauri shell, which is the desktop app's crate
built with the `runner` feature.
[`ARCHITECTURE.md`](ARCHITECTURE.md) lists what the app holds and how the shell builds it.

## Rules

- **The window shares, it does not copy.** The connection card, the confirmation and the host's event stream come from
  `packages/run-ui` by auto-import, and a change both windows need goes there. The window has no router, no store
  beyond the run list and no network call but the layer's.
- **The shell runs the tests, the window shows them.** A confirmed request calls `desktop_run_requested_tests` with the
  request id alone, and the shell reads the command and the request token from the host. Output arrives as
  `piwi:local-run` events, and Stop calls `desktop_stop_local_tests`.
- **The run logic is not here.** The held requests, the reconnect key, the temp folders and the routes live in
  `@piwitests/editor` (`request-host.ts`, `run-target.ts`, `run-target-http.ts`, and the runs' hub in
  `shell-runs.ts`, `shell-runs-http.ts`), and this host only wires them to `node:http`. Do not copy a route, a guard
  or a limit into this app: `packages/editor/tests/run-target-routes.test.ts` holds it and the dashboard's desktop
  build to one answer.
- **The host is the hub of the runs the shell starts, and of no other.** `server/main.ts` opens the editor's
  `ShellRuns` on the folders the shell links (`linkedFolders`), in Runner's words (`server/runs.ts`), and the host
  serves its routes (`serveShellRuns`: the run channel, the window's stream and commands, the picks). It names its hub
  to no other tool and observes no editor; the contract is `packages/editor/tests/shell-runs-routes.test.ts`.
- **The host has no database, no account and no other API.** Any path under `/api/` or `/__piwi/` that the shared
  routes do not serve is a 404, and a route added here must also be served by the dashboard's desktop build.
- **It listens on `127.0.0.1` alone and checks `Host`.** A request whose `Host` is not a loopback address is refused
  with 421 (`isLoopbackHost` in `server/host.ts`). The access token (`PIWI_DESKTOP_TOKEN`) opens every route except the
  readiness probe, the session bootstrap and the window's files; the picks token opens the picks route alone.
- **`/api/health` answers the shell's challenge with the proof of the token** (`challengeAnswer` in `host-guard`). The
  shell loads its session only from a host that proved it holds the token.
- **Nothing is stored.** The key lives in the OS keychain under Runner's own service name, and the folders in the
  shell's settings; the host keeps requests in memory only.
- **The shell writes no `~/.piwi/desktop.json`.** That file names a dashboard to the reporter, the editor clients and
  the MCP bridge, and Runner is not one.

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

The app itself is built from the desktop crate: after `runner:build`, `runner:window` and `runner:stage`, run from
`apps/desktop`:

```bash
npm run fetch-node -- --name piwi-runner-node                     # Runner's own Node sidecar
npx tauri icon ../runner/app-icon.svg --output src-tauri/icons-runner   # Runner's own icons
npx tauri build --features runner --config src-tauri/runner.conf.json
```

The Release workflow builds the installers for the same platforms as the desktop app (`reusable-publish-runner.yml`)
and attaches them to the tag's GitHub release as `Piwi-Runner_<version>_<arch>…`, beside the desktop app's, with
update signatures and `latest-runner.json` when the signing key is set. They are signed ad hoc on macOS and unsigned on
Windows. The tray's **Check for updates…** and the startup check are `updates.rs` (`check_from_tray`), with no window
command and no settings page.
