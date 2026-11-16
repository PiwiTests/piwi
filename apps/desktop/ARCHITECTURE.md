# Piwi Desktop architecture

Reference for the desktop shell (`apps/desktop/`). The rules are in [`AGENTS.md`](AGENTS.md). Open this file when you
need the detail behind one of them.

## MCP client configs

`src-tauri/src/mcp_clients.rs` writes the `piwi-desktop` entry of each assistant's config. The startup heal
(`heal_configured_clients`) and Connect follow these rules:

- **Which entries.** The heal touches only the `piwi-desktop` entry and removes no other. It rewrites an entry with
  exactly the keys the app writes whose only difference is the command (`differs_only_in_command`), and only when the
  old command names this app's executable (`names_this_app`: `piwi-desktop`, or `piwi-runner` in Piwi Runner) and no
  longer exists on disk (`command_is_gone`). It also rewrites an entry that is exactly the older shape: a loopback
  `/mcp` URL with this app's token as the only header (`is_old_url_entry`). Any other entry, an edited one or one with
  an added field included, such as a wrapper of the user's own that passes `mcp-stdio`, reads as stale and is replaced
  only when the user connects the client again. An AppImage entry holds the AppImage file (`APPIMAGE`), not the
  executable in its mount, and `names_this_app` accepts the file of the running AppImage or an `.AppImage` named for
  the product, so a moved or renamed AppImage heals and Connect retires a legacy `piwi` bridge entry that points at one.
- **Where from.** Nothing is written from a place that does not last: a macOS `AppTranslocation` path, a mounted
  volume (`/Volumes/…`), the temporary folder, a running dev build (`tauri::is_dev()`). That covers the startup heal,
  Connect and Disconnect alike. The client reads as manual, with the reason the card shows (`location_problem`). The
  temporary folder is compared with the app's path after both are resolved by the file system (`within`), so a Windows
  8.3 short name does not hide it. An entry that is the bridge command of another copy of the app that still exists,
  the installed app while this one runs from a disk image, reads as connected, with the reason shown, not as stale
  (`runs_another_copy`). Only a path that holds a file is a copy: a bare command name (`piwi-desktop`) is not looked
  up on the `PATH`, so such an entry reads as stale and is left alone by the startup repair.
- **Connect.** It removes an entry only when the entry holds this app's token or is the bridge
  (`is_local_piwi_entry`), so a self-hosted Piwi on `localhost` with another key stays.
- **The file.** The first backup is kept as it is (`<name>.piwi-backup.json`, created new, owner-only); a backup of an
  older entry holds no token, and a backup an older build left is rewritten without the token and owner-only at
  startup, beside every client's config whether or not it is rewritten (`scrub_backup` in `heal_clients`). The backup
  name replaces the file's extension: `mcp.json` is kept as `mcp.piwi-backup.json`. The order of the keys survives (`serde_json` `preserve_order`; remove with
  `shift_remove`), as do the mode and the symlink of the file. A file that does not parse, or starts with a byte-order
  mark, is not rewritten and reads as manual. The file is compared with what was read right before the rename
  (`write_keeping_mode_checked`), so a change in between is not overwritten. Connect and Disconnect pass the text they
  read for the same check and report a file that changed meanwhile.
- **The bridge.** `piwi-desktop mcp-stdio` sends the token only through `connect_proving_token`, and only to
  `127.0.0.1`.

## Server session

`session.rs` holds the generation of the sidecar and whether the session is live. The live flag is set only after the
sidecar proved the token for the current generation (`load_session`), and cleared when the sidecar exits or the
supervisor gives up. Both the exit and the give-up bump the generation, and the check of the proof and the store of the
flag run under the same lock as the bump and the clear (`Session::go_live_if`), so a clear never falls between a check
and the store it guards. The give-up is marked before the session ends. While it is clear, the navigation plugin refuses the sidecar origin for the main window, and the
open commands refuse it for the auxiliary and output windows, and check again after building one, closing it if the
session stopped being live (`keep_window_if_live`). A give-up shows the stopped splash.

The window signs in with a session code, never the token. After the proof, the shell asks the server for a code
(`session::session_url`, `POST /api/desktop/run-target/session-code`) over `connect_proving_token`; the route refuses a
browser. The window loads `/__piwi/session?code=…`, which takes the code once and sets the `piwi_token` cookie. A code
lives 30 seconds, at most eight wait at a time, and a used, expired or unknown code is refused, as is the token on the
URL (`packages/editor/src/run-target-session.ts`, shared by the app and Piwi Runner). A code that fails is asked for
again a few times (`session_url_retrying`, at startup through `open_first_session`, in Piwi Runner and after a
restart); the tries end once the proof no longer holds. A server that still gives no code gets no session, and the
window shows the stopped splash, revealed, only while the proof holds: a sidecar that exits meanwhile is the
supervisor's to restart, and its "restarting" text stays, with a window launched to the tray still hidden.

## Runs the shell starts

The bundled server is the hub of every Playwright run the shell starts.

- **Which spawns.** A run of the window (`spawn_tests` in `runner.rs`) and a reproduction (`repro.rs`) add
  `bundled_hub_env`: the server's `PIWI_RUN_CHANNEL` and the address its picks go to (`PIWI_EDITOR_SEND`, the server's
  own route), read from `GET /api/desktop/run-channel` on a connection that first proved the host holds the token
  (`connect_proving_token`), and `PIWI_RUN_REF` (`hub_env.rs`, `desktop-<run id>`, which the window knows the run by).
- **A job in a throwaway worktree** (`worktree.rs`: the reproduce, bisect and `piwi flake` runs) adds `job_hub_env`
  instead: the run channel of the live editor whose workspace holds its linked folder, when one does (from the
  route's `editor` for `?folder=`), as `desktop-<id>-at-<commit>`, its picks still to the server, else the bundled
  server's.
- **A run nobody attends** (Flake Lab, a bisect, a lab job, one with `--ui`, or with `--repeat-each` above 1 unless it
  stops at its first failure) ends its ref in `-unattended` (`attended_args`, mirrored by `desktopArgsAttended`), and
  the server never holds its failures.
- **The hub.** Its WebSocket takes the desktop token in `hello`; it is `ShellRuns`
  (`packages/editor/src/shell-runs.ts`), which `apps/application/server/utils/desktop-runs.ts` wires. Agents steer
  those runs only through `/mcp`, behind the same token (`server/utils/mcp/run-tools.ts`), and never a run nobody
  attends.
- **Piwi Runner.** Its requested runs take the same `bundled_hub_env` from Runner's host
  (`a_requested_run_names_the_hosts_hub_and_nothing_else` in `runner_app.rs`).

## Requested runs

A run a team instance asked for starts from the bundled server's launch (`src-tauri/src/run_target.rs`): the window
names the request id alone, and the shell takes the command **Run** approved, its folder and the request token once
from `POST /api/desktop/run-target/requests/:id/launch` (shell-only, `isBrowserRequest`).

- **What the shell refuses.** No arguments, a folder linked since, a folder another local or requested run is going in
  (`runs_in`, `hold_folder`; the server hears those folders whenever a local run starts or ends, `hand_local_runs`, so
  it checks a waiting request again), or arguments past 24,000 characters (`REQUEST_ARGS_MAX_CHARS`, the editor's cap).
- **The token.** The shell writes it to a private file for the reporter (`PIWI_REQUEST_TOKEN_FILE`) and deletes it
  when the run ends.
- **On quit.** `shut_down` stops the local runs, then posts the end of every requested run still held
  (`end_requested_runs_on_quit`, 2 s each, each on its own thread, waited for 3 s in all) and deletes its folder
  before it stops the server. A run that ends once the quit began ends stopped (`end_child`), and only that quit post
  tells the server of it (`quit_requested_runs`); from then on no requested run is held or takes its folder (`hold`,
  `hold_folder`), and a run spawned meanwhile is killed (`spawn_tests`).
- **At startup.** Each app removes its own leftover folders (`piwi-request-*`, Runner `piwi-runner-request-*`) older
  than a day that no run holds (`sweep_leftover_request_dirs`).
- **The key.** The instance's key lives in the OS keychain, read only while `runTargetInstance` is set, handed to the
  server after each start, never to the window (`hand_kept_key`), with the ids of the requested runs still held
  (`running`) so a restarted server ends only the requests the shell lost.
- **A run's end.** It stays held until the server answers its `/ended` with a 200 (`tell_ended`); one still held goes
  in `PUT /key`'s `ended` and is forgotten once the server names it back.
- **From the dashboard.** A stop reaches the shell on its notification stream, and so does `key-revoked`, which
  forgets the key only when it names the connected instance (`key_revoked`).
