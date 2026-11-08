# Piwi Runner: agent guide

Rules for working inside `apps/runner/` (`@piwitests/runner`). Piwi Runner is the small app that runs the tests a team
instance asks for on this machine (**Run on my machine**), without the dashboard: a window for the connection and the
confirmation, and a Node host that serves it. Read [`../../AGENTS.md`](../../AGENTS.md) first for the repository-wide
conventions, and [`../desktop/AGENTS.md`](../desktop/AGENTS.md) for the Tauri shell, which is the desktop app's crate
built with the `runner` feature.

## What it holds

| Path                 | What                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `server/host.ts`     | The `node:http` host: the readiness probe, `serveRunTarget`, the window's files                         |
| `server/main.ts`     | The sidecar's entry: reads the shell's environment and listens on `127.0.0.1`                           |
| `scripts/build.mjs`  | Bundles the host into `dist/server.cjs`, stamped with this package's version                            |
| `tests/`             | The host on a real socket                                                                               |

## Rules

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
npm run runner:typecheck
npm run runner:lint
npm run runner:format:check
npm run runner:build         # dist/server.cjs
```
