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
  only when the user connects the client again. An AppImage entry is not healed.
- **Where from.** Nothing is written from a place that does not last: a macOS `AppTranslocation` path, a mounted
  volume (`/Volumes/…`), a running dev build (`tauri::is_dev()`). The client reads as manual, with the reason the card
  shows (`location_problem`).
- **Connect.** It removes an entry only when the entry holds this app's token or is the bridge
  (`is_local_piwi_entry`), so a self-hosted Piwi on `localhost` with another key stays.
- **The file.** The first backup is kept as it is (`<name>.piwi-backup.json`, created new, owner-only); a backup of an
  older entry holds no token. The order of the keys survives (`serde_json` `preserve_order`; remove with
  `shift_remove`), as do the mode and the symlink of the file. A file that does not parse, or starts with a byte-order
  mark, is not rewritten and reads as manual. The file is compared with what was read right before the rename
  (`write_keeping_mode_checked`), so a change in between is not overwritten.

## Server session

`session.rs` holds the generation of the sidecar and whether the session is live. The live flag is set only after the
sidecar proved the token for the current generation (`load_session`), and cleared when the sidecar exits or the
supervisor gives up. While it is clear, the navigation plugin refuses the sidecar origin for the main window, and the
open commands refuse it for the auxiliary and output windows. A give-up shows the stopped splash.
