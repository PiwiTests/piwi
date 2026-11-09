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
  (`runs_another_copy`).
- **Connect.** It removes an entry only when the entry holds this app's token or is the bridge
  (`is_local_piwi_entry`), so a self-hosted Piwi on `localhost` with another key stays.
- **The file.** The first backup is kept as it is (`<name>.piwi-backup.json`, created new, owner-only); a backup of an
  older entry holds no token, and a backup an older build left is rewritten without the token and owner-only when its
  entry is rewritten (`scrub_backup`). The backup name replaces the file's extension: `mcp.json` is kept as
  `mcp.piwi-backup.json`. The order of the keys survives (`serde_json` `preserve_order`; remove with
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
