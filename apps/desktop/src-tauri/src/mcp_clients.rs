// One-click MCP client configuration.
//
// The dashboard's /mcp page shows copy-paste snippets for connecting MCP
// clients; on this machine the shell can do better and write the client's own
// config file. Every client is configured the same way: a `piwi-desktop` entry
// inside the client's server map that runs this app in bridge mode as a local
// command (see `mcp_stdio` and `stdio_entry_for`). The bridge reads the address
// and the token from the reporter discovery file when it runs and sends the token
// only to a server that proves it holds it, so no port and no token is written
// into another app's config. A client that takes only a URL could not be given
// this entry; none of the clients below is one.
//
// The entry is keyed `piwi-desktop`, not `piwi`, so it never collides with a
// hosted Piwi a user has added by hand under `piwi` — the two coexist in one
// client. Connecting also removes a `piwi` entry with a loopback URL (a remote
// one is kept).
//
// Editing another app's config is done conservatively:
//   - only strict JSON is ever rewritten — a file that does not parse (JSONC
//     with comments, trailing commas) is reported as `manual` and left alone;
//   - the previous content is copied to `<name>.piwi-backup.json` (the file's
//     extension replaced) before a write;
//   - the file is replaced through a temporary copy, keeping its permissions
//     (owner-only for a new file);
//   - only the `piwi-desktop` key (and a stale loopback `piwi`) is touched —
//     everything else in the file is preserved as parsed.
//
// `heal_configured_clients` runs at startup and touches only the `piwi-desktop`
// entry, and only an entry that is ours to rewrite: a bridge entry with exactly the
// keys this app writes whose only difference is the command (the app moved), or
// exactly the shape older builds wrote, a loopback `/mcp` URL with this app's own
// token as a bearer header. It removes no other entry, and it writes a file only if
// that file is unchanged since it was read. A bridge entry with any other field, or
// any other edit, is left as it is and reads as stale until the person connects
// again. Both rewrites keep the backup.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager as _};
use tauri_plugin_opener::OpenerExt as _;

use crate::mcp_stdio;

/// The live connection details every written entry must match.
pub struct ServerInfo {
    pub port: u16,
    pub token: String,
}

/// The key this app writes its MCP entry under. Distinct from `piwi` so a hosted
/// Piwi added by hand (conventionally `piwi`) and this local app live together.
const PIWI_ENTRY_KEY: &str = "piwi-desktop";

/// The key older builds wrote under. Removed on connect/disconnect when it holds
/// an entry only this app would have written (see `is_local_piwi_entry`).
const LEGACY_ENTRY_KEY: &str = "piwi";

const CLIENT_IDS: [&str; 7] = [
    "claude-code",
    "claude-desktop",
    "cursor",
    "opencode",
    "vscode",
    "windsurf",
    "gemini-cli",
];

/// The key under which clients keep their MCP server map.
fn container_key(id: &str) -> &'static str {
    match id {
        "opencode" => "mcp",
        "vscode" => "servers",
        _ => "mcpServers",
    }
}

fn label_of(id: &str) -> &'static str {
    match id {
        "claude-code" => "Claude Code",
        "claude-desktop" => "Claude Desktop",
        "cursor" => "Cursor",
        "opencode" => "Opencode",
        "vscode" => "VS Code",
        "windsurf" => "Windsurf",
        "gemini-cli" => "Gemini CLI",
        _ => "Unknown",
    }
}

/// The `piwi` entry in each client's native shape: this app in bridge mode as a local command.
fn entry_for(id: &str) -> Value {
    stdio_entry_for(id, &bridge_command())
}

/// `command` as a local server in the shape `id` reads. Claude Desktop reads **only stdio servers** from
/// `claude_desktop_config.json` — an entry carrying a `url` is refused at startup ("the following entries in
/// claude_desktop_config.json are not valid MCP server configurations and were ignored").
///
/// That command is this very app in bridge mode (see `mcp_stdio`): nothing to
/// install, no Node or `npx` on PATH, and because the bridge resolves the
/// address from the reporter discovery file when it runs, the entry never
/// drifts with the port and no token is copied into another app's config.
fn stdio_entry_for(id: &str, command: &str) -> Value {
    match id {
        "claude-code" | "vscode" => json!({ "type": "stdio", "command": command, "args": [mcp_stdio::STDIO_ARG] }),
        "opencode" => json!({ "type": "local", "command": [command, mcp_stdio::STDIO_ARG] }),
        _ => json!({ "command": command, "args": [mcp_stdio::STDIO_ARG] }),
    }
}

/// This executable, as the path another app can spawn it by. `current_exe`
/// fails only in pathological cases (the binary unlinked mid-run); the bare
/// name is a last resort that at least resolves if the app is on PATH.
fn bridge_command() -> String {
    let exe = std::env::current_exe().ok();
    let appimage = if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE")
    } else {
        None
    };
    bridge_path(exe.as_deref(), appimage.as_deref(), &std::env::temp_dir())
}

/// `exe` as a command another app can spawn. An AppImage runs from a mount
/// (`<temp>/.mount_*`, the check Tauri makes) that gets a new name at each
/// launch, so an `exe` inside one is replaced by the AppImage file it was
/// started from (`APPIMAGE`), the path that lasts.
fn bridge_path(exe: Option<&Path>, appimage: Option<&OsStr>, temp: &Path) -> String {
    let in_mount = exe
        .and_then(|exe| exe.strip_prefix(temp).ok())
        .and_then(|rest| rest.components().next())
        .is_some_and(|first| first.as_os_str().to_string_lossy().starts_with(".mount_"));
    match (exe, appimage) {
        (Some(_), Some(image)) if in_mount => crate::node_path(Path::new(image)),
        // Windows hands paths back with the `\\?\` verbatim prefix, which
        // launchers mishandle — strip it (see `node_path`).
        (Some(exe), _) => crate::node_path(exe),
        (None, _) => "piwi-desktop".to_string(),
    }
}

const CLAUDE_DESKTOP_CONFIG: &str = "claude_desktop_config.json";

/// Claude Desktop config directories, in the order `pick_config_dir` reads them.
///
/// On Windows, the folder depends on the build:
///   - `%LOCALAPPDATA%\Packages\Claude_<publisher id>\LocalCache\Roaming\Claude\`
///     for an MSIX install (Microsoft Store, WinGet, the MSIX installer): it
///     runs in a package container, and Windows redirects the writes it aims
///     at `%APPDATA%` there;
///   - `%APPDATA%\Claude\` for the classic installer;
///   - `%LOCALAPPDATA%\Claude-Data\claude_<publisher id>\` for recent builds,
///     which leave a `.user-data-left.claude_<publisher id>` file in the
///     folders above when they move their data there.
///
/// On macOS and Linux only the plain config-dir candidate exists.
fn claude_desktop_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let local = app.path().local_data_dir().ok();
    if let Some(local) = &local {
        dirs.extend(packaged_claude_dirs(&local.join("Packages")));
    }
    if let Ok(config) = app.path().config_dir() {
        dirs.push(config.join("Claude"));
    }
    if let Some(local) = &local {
        dirs.extend(claude_named_dirs(&local.join("Claude-Data")));
    }
    dirs
}

/// The directories under `root` whose name starts with `claude_` in any case,
/// sorted so the choice never depends on the order the filesystem happens to
/// list entries in.
///
/// The name is matched by prefix: its suffix is a hash of the publisher
/// identity, so it is the same on every machine but changes with a re-signed
/// or side-by-side package.
fn claude_named_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.to_ascii_lowercase().starts_with("claude_"))
        })
        .collect();
    dirs.sort();
    dirs
}

/// The `LocalCache\Roaming\Claude` directory of every `Claude_*` package under
/// the MSIX package root.
fn packaged_claude_dirs(packages_root: &Path) -> Vec<PathBuf> {
    claude_named_dirs(packages_root)
        .into_iter()
        .map(|path| path.join("LocalCache").join("Roaming").join("Claude"))
        .collect()
}

/// The folder the client reads its config from, in this order:
///   1. the candidate a `.user-data-left.<name>` file names: the data moved
///      there;
///   2. the first candidate that exists and holds no such file. Existence beats
///      content: a folder that is present but still empty belongs to the build
///      that is actually installed, while a config left behind elsewhere
///      belongs to one that is not;
///   3. the last candidate, where a fresh install of the client creates it.
fn pick_config_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    let moved_to = candidates
        .iter()
        .filter_map(|dir| data_moved_to(dir))
        .find_map(|name| {
            candidates.iter().find(|dir| {
                dir.is_dir()
                    && dir.file_name().is_some_and(|dir_name| {
                        dir_name.to_string_lossy().eq_ignore_ascii_case(&name)
                    })
            })
        });
    moved_to
        .or_else(|| {
            candidates
                .iter()
                .find(|dir| dir.is_dir() && data_moved_to(dir).is_none())
        })
        .or_else(|| candidates.last())
        .cloned()
}

/// The folder Claude Desktop moved its data to from `dir`, named by the empty
/// `.user-data-left.<name>` file it leaves there; it no longer reads the config
/// beside that file.
fn data_moved_to(dir: &Path) -> Option<String> {
    std::fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        entry
            .file_name()
            .to_str()?
            .strip_prefix(".user-data-left.")
            .map(str::to_string)
    })
}

/// Where the client keeps the config to edit, and the directory whose presence
/// means "this client is installed on this machine".
fn paths_of(app: &AppHandle, id: &str) -> Option<(PathBuf, PathBuf)> {
    let home = app.path().home_dir().ok()?;
    // ~/Library/Application Support (macOS), %APPDATA% (Windows), ~/.config (Linux).
    let config = app.path().config_dir().ok()?;
    match id {
        "claude-code" => Some((home.join(".claude.json"), home.join(".claude"))),
        "claude-desktop" => {
            let dir = pick_config_dir(&claude_desktop_dirs(app))?;
            Some((dir.join(CLAUDE_DESKTOP_CONFIG), dir))
        }
        "cursor" => Some((home.join(".cursor").join("mcp.json"), home.join(".cursor"))),
        "opencode" => Some((
            home.join(".config").join("opencode").join("opencode.json"),
            home.join(".config").join("opencode"),
        )),
        "vscode" => Some((
            config.join("Code").join("User").join("mcp.json"),
            config.join("Code").join("User"),
        )),
        "windsurf" => Some((
            home.join(".codeium")
                .join("windsurf")
                .join("mcp_config.json"),
            home.join(".codeium").join("windsurf"),
        )),
        "gemini-cli" => Some((
            home.join(".gemini").join("settings.json"),
            home.join(".gemini"),
        )),
        _ => None,
    }
}

#[derive(Clone, serde::Serialize)]
pub struct McpClientStatus {
    id: String,
    label: String,
    /// The config file the shell would edit; shown so the user can verify.
    config_path: String,
    /// `not_installed` | `not_connected` | `connected` | `stale` | `manual`
    status: &'static str,
    /// For `manual`: why the file cannot be edited safely.
    detail: Option<String>,
}

/// Pure classification of a client's parsed config against the live entry.
fn classify(existing: Option<&Value>, container: &str, expected: &Value) -> &'static str {
    match existing
        .and_then(|v| v.get(container))
        .and_then(|c| c.get(PIWI_ENTRY_KEY))
    {
        None => "not_connected",
        Some(current) if current == expected => "connected",
        Some(_) => "stale",
    }
}

/// Whether an entry is one only this app would have written under `piwi`: a
/// loopback `/mcp` URL (the URL-client shape) or a command spawning this exe in
/// bridge mode (the Claude Desktop shape). A hosted Piwi added by hand points at
/// a real host, so it never matches — its `piwi` entry is left untouched.
fn is_local_piwi_entry(value: &Value) -> bool {
    for key in ["url", "serverUrl", "httpUrl"] {
        if let Some(url) = value.get(key).and_then(|v| v.as_str()) {
            if (url.contains("127.0.0.1") || url.contains("localhost")) && url.ends_with("/mcp") {
                return true;
            }
        }
    }
    is_bridge_entry(value)
}

/// Whether an entry runs this app in bridge mode: a command with the bridge argument, in `args` or, for
/// Opencode, in the command list itself.
fn is_bridge_entry(value: &Value) -> bool {
    let named = |list: Option<&Value>| {
        list.and_then(|v| v.as_array())
            .is_some_and(|items| items.iter().any(|a| a.as_str() == Some(mcp_stdio::STDIO_ARG)))
    };
    match value.get("command") {
        Some(Value::String(_)) => named(value.get("args")),
        Some(list @ Value::Array(_)) => named(Some(list)),
        _ => false,
    }
}

/// Set or remove this app's entry (keyed `PIWI_ENTRY_KEY`) in `root`'s `container`, preserving everything else.
/// `entry: None` removes ours. Returns the new document.
fn set_own_entry(existing: Value, container: &str, entry: Option<Value>) -> Value {
    let mut root = match existing {
        Value::Object(map) => map,
        // A non-object root would be a broken config; start over rather than
        // producing invalid nesting. (Reached only for empty/new files.)
        _ => Map::new(),
    };
    let servers = root
        .entry(container.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !servers.is_object() {
        *servers = Value::Object(Map::new());
    }
    let map = servers.as_object_mut().expect("container is an object");
    match entry {
        Some(value) => {
            map.insert(PIWI_ENTRY_KEY.to_string(), value);
        }
        None => {
            map.remove(PIWI_ENTRY_KEY);
        }
    }
    Value::Object(root)
}

/// `set_own_entry` for an explicit Connect or Disconnect, which also drops a loopback `piwi` an older build left
/// behind, but only when it is unmistakably ours — never a hosted Piwi a user keeps under `piwi`.
fn merge_piwi_entry(existing: Value, container: &str, entry: Option<Value>) -> Value {
    let mut doc = existing;
    if let Some(map) = doc.get_mut(container).and_then(Value::as_object_mut) {
        if map.get(LEGACY_ENTRY_KEY).is_some_and(is_local_piwi_entry) {
            map.remove(LEGACY_ENTRY_KEY);
        }
    }
    set_own_entry(doc, container, entry)
}

fn read_config(path: &PathBuf) -> Result<Option<Value>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<Value>(&raw).map(Some).map_err(|_| {
        "the file is not plain JSON (comments or trailing commas?) — add the entry manually"
            .to_string()
    })
}

fn status_of(app: &AppHandle, id: &str) -> McpClientStatus {
    let (config_path, detect_dir) = match paths_of(app, id) {
        Some(paths) => paths,
        None => {
            return McpClientStatus {
                id: id.to_string(),
                label: label_of(id).to_string(),
                config_path: String::new(),
                status: "not_installed",
                detail: None,
            };
        }
    };
    let installed = detect_dir.exists() || config_path.is_file();
    let status = if !installed {
        "not_installed"
    } else {
        match read_config(&config_path) {
            Err(_) => "manual",
            Ok(existing) => classify(existing.as_ref(), container_key(id), &entry_for(id)),
        }
    };
    McpClientStatus {
        id: id.to_string(),
        label: label_of(id).to_string(),
        config_path: config_path.to_string_lossy().to_string(),
        status,
        detail: if status == "manual" {
            read_config(&config_path).err()
        } else {
            None
        },
    }
}

fn write_config(path: &PathBuf, doc: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Keep the previous content recoverable — this is another app's file.
    if path.is_file() {
        let _ = std::fs::copy(path, path.with_extension("piwi-backup.json"));
    }
    let body = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())? + "\n";
    crate::private_fs::write_keeping_mode(path, body.as_bytes()).map_err(|e| e.to_string())
}

fn set_entry(app: &AppHandle, id: &str, connect: bool) -> Result<McpClientStatus, String> {
    let (config_path, detect_dir) = paths_of(app, id).ok_or("unknown client")?;
    if !detect_dir.exists() && !config_path.is_file() {
        return Err(format!("{} does not appear to be installed", label_of(id)));
    }
    let existing = read_config(&config_path)?.unwrap_or_else(|| json!({}));
    let entry = if connect {
        Some(entry_for(id))
    } else {
        None
    };
    let doc = merge_piwi_entry(existing, container_key(id), entry);
    write_config(&config_path, &doc)?;
    Ok(status_of(app, id))
}

/// The entry older builds wrote for client `id` at `url`: the loopback URL and this app's token as a bearer header.
fn old_url_entry_for(id: &str, url: &str, token: &str) -> Value {
    let headers = json!({ "Authorization": format!("Bearer {token}") });
    match id {
        "cursor" => json!({ "url": url, "headers": headers }),
        "opencode" => json!({ "type": "remote", "url": url, "headers": headers }),
        "windsurf" => json!({ "serverUrl": url, "headers": headers }),
        "gemini-cli" => json!({ "httpUrl": url, "headers": headers }),
        // Claude Code and VS Code share the `type: http` shape.
        _ => json!({ "type": "http", "url": url, "headers": headers }),
    }
}

/// Whether `value` is exactly the entry older builds wrote for client `id` with this app's `token`: a loopback
/// `/mcp` URL, whatever port the app had then, the token as the only header, and no other field. An entry the user
/// edited, or one with another token, does not match.
fn is_old_url_entry(id: &str, value: &Value, token: &str) -> bool {
    let key = match id {
        "windsurf" => "serverUrl",
        "gemini-cli" => "httpUrl",
        _ => "url",
    };
    let Some(url) = value.get(key).and_then(|v| v.as_str()) else {
        return false;
    };
    let port = url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.strip_suffix("/mcp"));
    port.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && !token.is_empty()
        && *value == old_url_entry_for(id, url, token)
}

/// Whether `ours` is `expected` with a different command and nothing else different: the same keys, and every
/// value but the command equal. For Opencode the command is the first item of its list.
fn differs_only_in_command(ours: &Value, expected: &Value) -> bool {
    let (Some(ours_map), Some(expected_map)) = (ours.as_object(), expected.as_object()) else {
        return false;
    };
    if ours_map.len() != expected_map.len() || ours == expected {
        return false;
    }
    expected_map.iter().all(|(key, want)| {
        let Some(have) = ours_map.get(key) else {
            return false;
        };
        if key != "command" {
            return have == want;
        }
        match (have, want) {
            (Value::String(_), Value::String(_)) => true,
            (Value::Array(have), Value::Array(want)) => {
                have.len() == want.len() && have.len() > 1 && have[1..] == want[1..] && have[0].is_string()
            }
            _ => false,
        }
    })
}

/// Rewrite the `piwi-desktop` entry of client `id` in the config at `path` when it is ours to heal: a bridge entry
/// that is what this app writes except for its command (see `differs_only_in_command`), or exactly the entry older
/// builds wrote (see `is_old_url_entry`). Nothing else in the file changes, and it is written only if it still holds
/// what was read. Writes through `write_config`, which keeps the backup. Returns whether it rewrote; false for
/// anything unreadable, manual, absent, edited or changed meanwhile.
fn heal_client_file(id: &str, path: &PathBuf, token: &str) -> bool {
    heal_client_file_checked(id, path, token, || {})
}

/// `heal_client_file`, running `before_write` between the read and the check that the file is unchanged.
fn heal_client_file_checked(id: &str, path: &PathBuf, token: &str, before_write: impl FnOnce()) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(Some(doc)) = read_config(path) else {
        return false;
    };
    let Some(ours) = doc.get(container_key(id)).and_then(|servers| servers.get(PIWI_ENTRY_KEY)) else {
        return false;
    };
    let expected = entry_for(id);
    if !differs_only_in_command(ours, &expected) && !is_old_url_entry(id, ours, token) {
        return false;
    }
    let merged = set_own_entry(doc, container_key(id), Some(expected));
    before_write();
    // Another app may write this file while this one runs; its update wins.
    if std::fs::read_to_string(path).ok().as_deref() != Some(raw.as_str()) {
        return false;
    }
    write_config(path, &merged).is_ok()
}

/// Heal every already-configured client whose `piwi-desktop` entry is ours to rewrite (see `heal_client_file`). An
/// entry of another shape is left for the user to connect again. Quietly skips anything unreadable or manual.
pub fn heal_configured_clients(app: &AppHandle) {
    let Some(info) = app.try_state::<ServerInfo>() else {
        return;
    };
    for id in CLIENT_IDS {
        if let Some((config_path, _)) = paths_of(app, id) {
            heal_client_file(id, &config_path, &info.token);
        }
    }
}

#[tauri::command]
pub fn desktop_mcp_clients(app: AppHandle) -> Result<Vec<McpClientStatus>, String> {
    Ok(CLIENT_IDS.iter().map(|id| status_of(&app, id)).collect())
}

#[tauri::command]
pub fn desktop_mcp_connect(app: AppHandle, client_id: String) -> Result<McpClientStatus, String> {
    set_entry(&app, &client_id, true)
}

#[tauri::command]
pub fn desktop_mcp_disconnect(
    app: AppHandle,
    client_id: String,
) -> Result<McpClientStatus, String> {
    set_entry(&app, &client_id, false)
}

/// Reveal a client's config file in the OS file manager. The path is resolved
/// from the client id — never taken from the caller — so the webview cannot
/// reveal arbitrary paths.
#[tauri::command]
pub fn desktop_mcp_reveal(app: AppHandle, client_id: String) -> Result<(), String> {
    let (config_path, _) = paths_of(&app, &client_id).ok_or("unknown client")?;
    if !config_path.is_file() {
        return Err("the config file does not exist yet".into());
    }
    app.opener()
        .reveal_item_in_dir(&config_path)
        .map_err(|e| e.to_string())
}

// ── Agent skills in a linked folder ──────────────────────────────────────────
//
// Next to the client configs, the app installs the Piwi workflow skills into a
// project's linked folder, under `.claude/skills/<slug>/SKILL.md` (the folder
// Claude Code reads; other agents read the same files). The dashboard serves the
// skill files, stamped with the version they ship in, and decides which to write
// (an edited skill is kept unless the person asks); the shell only reads and
// writes them, inside the linked folder of the project it is told.

/// Where the skills go, relative to the linked folder.
const SKILLS_DIR: [&str; 2] = [".claude", "skills"];

/// A skill's file in a folder, for a slug made of lowercase letters, digits and
/// dashes only, so a slug can never leave the skills directory.
fn skill_file(folder: &Path, slug: &str) -> Option<PathBuf> {
    let valid = !slug.is_empty()
        && slug.len() <= 64
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !slug.starts_with('-');
    if !valid {
        return None;
    }
    let mut path = folder.to_path_buf();
    for part in SKILLS_DIR {
        path.push(part);
    }
    Some(path.join(slug).join("SKILL.md"))
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    slug: String,
    /// The file's text; `None` when the skill is not installed.
    content: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedSkills {
    /// The skills directory inside the linked folder.
    dir: String,
    files: Vec<SkillFile>,
}

fn skills_dir(folder: &Path) -> PathBuf {
    let mut path = folder.to_path_buf();
    for part in SKILLS_DIR {
        path.push(part);
    }
    path
}

fn read_skills(folder: &Path, slugs: &[String]) -> Result<Vec<SkillFile>, String> {
    slugs
        .iter()
        .map(|slug| {
            let path =
                skill_file(folder, slug).ok_or_else(|| format!("invalid skill name: {slug}"))?;
            Ok(SkillFile {
                slug: slug.clone(),
                content: std::fs::read_to_string(&path).ok(),
            })
        })
        .collect()
}

fn write_skills(folder: &Path, files: &[SkillFile]) -> Result<Vec<String>, String> {
    let mut written = Vec::new();
    for file in files {
        let path = skill_file(folder, &file.slug)
            .ok_or_else(|| format!("invalid skill name: {}", file.slug))?;
        let Some(content) = &file.content else {
            continue;
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, content).map_err(|e| e.to_string())?;
        written.push(file.slug.clone());
    }
    Ok(written)
}

/// The linked folder of a project, or an error the window can show.
fn linked_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let link =
        crate::runner::linked_folder(app, project_id).ok_or("this project has no linked folder")?;
    let folder = PathBuf::from(link.path);
    if !folder.is_dir() {
        return Err("the linked folder no longer exists".into());
    }
    Ok(folder)
}

/// Read the installed copy of each named skill in a project's linked folder.
#[tauri::command]
pub fn desktop_skills_read(
    app: AppHandle,
    project_id: String,
    slugs: Vec<String>,
) -> Result<LinkedSkills, String> {
    let folder = linked_dir(&app, &project_id)?;
    Ok(LinkedSkills {
        dir: skills_dir(&folder).to_string_lossy().into_owned(),
        files: read_skills(&folder, &slugs)?,
    })
}

/// Write skill files into a project's linked folder. Returns the slugs written.
#[tauri::command]
pub fn desktop_skills_write(
    app: AppHandle,
    project_id: String,
    files: Vec<SkillFile>,
) -> Result<Vec<String>, String> {
    let folder = linked_dir(&app, &project_id)?;
    write_skills(&folder, &files)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory under the OS temp dir, removed when the test ends.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir()
                .join(format!("piwi-mcp-{label}-{}-{unique}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn join(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }

        fn mkdir(&self, rel: &str) -> PathBuf {
            let path = self.join(rel);
            std::fs::create_dir_all(&path).expect("create dir");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const EXE: &str = "/Applications/Piwi.app/Contents/MacOS/piwi-desktop";

    /// Every client runs this app in bridge mode as a local command, in the shape it reads, with no URL, no header
    /// and no token in the entry.
    #[test]
    fn every_client_gets_the_bridge_command_in_its_own_shape() {
        assert_eq!(
            stdio_entry_for("cursor", EXE),
            json!({ "command": EXE, "args": ["mcp-stdio"] })
        );
        for id in ["windsurf", "gemini-cli", "claude-desktop"] {
            assert_eq!(
                stdio_entry_for(id, EXE),
                json!({ "command": EXE, "args": ["mcp-stdio"] })
            );
        }
        for id in ["claude-code", "vscode"] {
            assert_eq!(
                stdio_entry_for(id, EXE),
                json!({ "type": "stdio", "command": EXE, "args": ["mcp-stdio"] })
            );
        }
        assert_eq!(
            stdio_entry_for("opencode", EXE),
            json!({ "type": "local", "command": [EXE, "mcp-stdio"] })
        );
        for id in CLIENT_IDS {
            let text = entry_for(id).to_string();
            for forbidden in ["url", "Url", "headers", "Authorization", "Bearer", "pd_", "127.0.0.1"] {
                assert!(!text.contains(forbidden), "{id} entry carries {forbidden}: {text}");
            }
            assert!(is_bridge_entry(&entry_for(id)), "{id} entry is not a bridge entry");
        }
    }

    /// The entry carries no port and no token, so it stays correct whatever port the app lands on — while an entry
    /// of the older shape, a URL with the token in a header, reads as stale.
    #[test]
    fn a_url_entry_with_the_token_reads_as_stale() {
        for id in CLIENT_IDS {
            let expected = entry_for(id);
            let container = container_key(id);
            let configured = json!({ container: { "piwi-desktop": expected.clone() } });
            assert_eq!(classify(Some(&configured), container, &expected), "connected");

            let old_shape = json!({
                container: { "piwi-desktop": {
                    "type": "http",
                    "url": "http://127.0.0.1:3000/mcp",
                    "headers": { "Authorization": "Bearer pd_test" }
                } }
            });
            assert_eq!(classify(Some(&old_shape), container, &expected), "stale");
            assert!(!is_bridge_entry(&old_shape[container]["piwi-desktop"]));
        }
    }

    /// Connecting again replaces an entry of the older shape whole: no header of it stays.
    #[test]
    fn connecting_again_replaces_a_url_entry_with_the_bridge_command() {
        let existing = json!({
            "mcpServers": {
                "piwi-desktop": { "type": "http", "url": "http://127.0.0.1:3000/mcp", "headers": { "Authorization": "Bearer pd_old" } },
                "other": { "command": "npx" }
            }
        });
        let merged = merge_piwi_entry(existing, "mcpServers", Some(stdio_entry_for("claude-code", EXE)));
        assert_eq!(
            merged["mcpServers"]["piwi-desktop"],
            json!({ "type": "stdio", "command": EXE, "args": ["mcp-stdio"] })
        );
        assert!(!merged.to_string().contains("pd_old"));
        assert_eq!(merged["mcpServers"]["other"], json!({ "command": "npx" }));
    }

    const TOKEN: &str = "pd_0123456789abcdef0123456789abcdef";

    /// A config file holding `entry` under `piwi-desktop` next to another server, in the shape client `id` reads.
    fn config_with(dir: &TempDir, id: &str, entry: Value) -> (PathBuf, String) {
        let path = dir.join(&format!("{id}.json"));
        let doc = json!({ container_key(id): { "piwi-desktop": entry, "other": { "command": "npx" } } });
        let text = serde_json::to_string_pretty(&doc).unwrap() + "\n";
        std::fs::write(&path, &text).unwrap();
        (path, text)
    }

    fn backup_of(path: &Path) -> PathBuf {
        path.with_extension("piwi-backup.json")
    }

    /// The entry older builds wrote, whatever port the app had then, is replaced by the bridge command at startup,
    /// the previous file kept as a backup and everything else in it preserved.
    #[test]
    fn the_entry_older_builds_wrote_is_rewritten_with_a_backup() {
        let dir = TempDir::new("heal-old");
        for id in CLIENT_IDS {
            for port in [3000, 51234] {
                let url = format!("http://127.0.0.1:{port}/mcp");
                let (path, before) = config_with(&dir, id, old_url_entry_for(id, &url, TOKEN));
                assert!(heal_client_file(id, &path, TOKEN), "{id} on {port} was not healed");
                let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                assert_eq!(doc[container_key(id)]["piwi-desktop"], entry_for(id), "{id}");
                assert_eq!(doc[container_key(id)]["other"], json!({ "command": "npx" }), "{id}");
                assert!(!doc.to_string().contains(TOKEN), "{id} kept the token");
                assert_eq!(std::fs::read_to_string(backup_of(&path)).unwrap(), before, "{id} backup");
                let _ = std::fs::remove_file(backup_of(&path));
            }
        }
    }

    /// An entry that is not exactly the older shape with this app's token is not ours to rewrite: another token,
    /// a remote host, an edited header or an added field leaves the file as it was, with no backup written.
    #[test]
    fn an_entry_that_is_not_exactly_the_older_shape_is_left_alone() {
        let dir = TempDir::new("heal-foreign");
        for id in CLIENT_IDS {
            let mut edits: Vec<Value> = Vec::new();
            let local = "http://127.0.0.1:3000/mcp".to_string();
            edits.push(old_url_entry_for(id, &local, "pd_someone_elses_token"));
            edits.push(old_url_entry_for(id, "https://piwi.example.com/mcp", TOKEN));
            edits.push(old_url_entry_for(id, "http://localhost:3000/mcp", TOKEN));
            edits.push(old_url_entry_for(id, "http://127.0.0.1:3000/mcp/extra", TOKEN));
            edits.push(old_url_entry_for(id, "http://127.0.0.1:/mcp", TOKEN));
            let mut with_header = old_url_entry_for(id, &local, TOKEN);
            with_header["headers"]["X-Team"] = json!("blue");
            edits.push(with_header);
            let mut with_field = old_url_entry_for(id, &local, TOKEN);
            with_field["timeout"] = json!(30);
            edits.push(with_field);
            edits.push(json!({ "command": "npx", "args": ["-y", "some-server"] }));
            for (i, entry) in edits.into_iter().enumerate() {
                let (path, before) = config_with(&dir, id, entry);
                assert!(!heal_client_file(id, &path, TOKEN), "{id} edit {i} was rewritten");
                assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "{id} edit {i}");
                assert!(!backup_of(&path).exists(), "{id} edit {i} wrote a backup");
            }
        }
    }

    /// A bridge entry for an app that moved is rewritten; the current one, and a file with no entry, are not touched.
    #[test]
    fn a_bridge_entry_is_healed_only_when_it_drifted() {
        let dir = TempDir::new("heal-bridge");
        let (path, _) = config_with(&dir, "cursor", stdio_entry_for("cursor", "/old/place/piwi-desktop"));
        assert!(heal_client_file("cursor", &path, TOKEN));
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["mcpServers"]["piwi-desktop"], entry_for("cursor"));

        let (path, before) = config_with(&dir, "windsurf", entry_for("windsurf"));
        assert!(!heal_client_file("windsurf", &path, TOKEN));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        assert!(!backup_of(&path).exists());

        let none = dir.join("none.json");
        std::fs::write(&none, "{ \"mcpServers\": {} }").unwrap();
        assert!(!heal_client_file("cursor", &none, TOKEN));
        assert!(!heal_client_file("cursor", &dir.join("missing.json"), TOKEN));
    }

    /// A bridge entry with any field this app does not write is the person's edit (a disabled server, an
    /// environment, a timeout, a trust setting): startup leaves the file as it was, and the entry reads as stale.
    #[test]
    fn a_bridge_entry_with_an_extra_field_is_left_alone_and_reads_as_stale() {
        let dir = TempDir::new("heal-extra");
        for id in CLIENT_IDS {
            for (field, value) in [
                ("enabled", json!(false)),
                ("env", json!({ "DEBUG": "1" })),
                ("timeout", json!(30)),
                ("disabled", json!(true)),
                ("trust", json!(true)),
            ] {
                let mut entry = stdio_entry_for(id, "/old/place/piwi-desktop");
                entry[field] = value;
                let (path, before) = config_with(&dir, id, entry.clone());
                assert!(!heal_client_file(id, &path, TOKEN), "{id} with {field} was rewritten");
                assert_eq!(std::fs::read_to_string(&path).unwrap(), before, "{id} with {field}");
                assert!(!backup_of(&path).exists(), "{id} with {field} wrote a backup");
                assert_eq!(classify(Some(&json!({ container_key(id): { "piwi-desktop": entry } })), container_key(id), &entry_for(id)), "stale");
            }
        }
    }

    /// Only the command may differ: another argument or type is an edit too, while a moved app is still healed.
    #[test]
    fn only_a_changed_command_makes_a_bridge_entry_ours_to_heal() {
        for id in CLIENT_IDS {
            let moved = stdio_entry_for(id, "/old/place/piwi-desktop");
            assert!(differs_only_in_command(&moved, &entry_for(id)), "{id} moved");
            assert!(!differs_only_in_command(&entry_for(id), &entry_for(id)), "{id} current");
        }
        let mut more_args = stdio_entry_for("cursor", "/old/piwi-desktop");
        more_args["args"] = json!(["mcp-stdio", "--verbose"]);
        assert!(!differs_only_in_command(&more_args, &entry_for("cursor")));
        let mut other_type = stdio_entry_for("claude-code", "/old/piwi-desktop");
        other_type["type"] = json!("sse");
        assert!(!differs_only_in_command(&other_type, &entry_for("claude-code")));
        let longer = json!({ "type": "local", "command": ["/old/piwi-desktop", "mcp-stdio", "--x"] });
        assert!(!differs_only_in_command(&longer, &entry_for("opencode")));
    }

    /// The startup heal does not remove a loopback `piwi` entry the person keeps (a self-hosted server on
    /// localhost); the same entry is still retired by an explicit Connect.
    #[test]
    fn the_startup_heal_keeps_the_users_own_loopback_piwi_entry() {
        let dir = TempDir::new("heal-keeps-piwi");
        let own = json!({ "type": "http", "url": "http://localhost:3000/mcp" });
        let path = dir.join("cursor.json");
        let doc = json!({ "mcpServers": {
            "piwi": own,
            "piwi-desktop": stdio_entry_for("cursor", "/old/place/piwi-desktop"),
        } });
        std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
        assert!(heal_client_file("cursor", &path, TOKEN));
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["mcpServers"]["piwi"], own);
        assert_eq!(after["mcpServers"]["piwi-desktop"], entry_for("cursor"));

        let connected = merge_piwi_entry(doc, "mcpServers", Some(entry_for("cursor")));
        assert!(connected["mcpServers"].get("piwi").is_none());
    }

    /// A file is written only if it still holds what was read: a client that saved it in between keeps its update.
    #[test]
    fn a_file_changed_after_it_was_read_is_not_written() {
        let dir = TempDir::new("heal-changed");
        let (path, _) = config_with(&dir, "cursor", stdio_entry_for("cursor", "/old/place/piwi-desktop"));
        assert!(heal_client_file_checked("cursor", &path, TOKEN, || {}));
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["mcpServers"]["piwi-desktop"], entry_for("cursor"));

        let (path, _) = config_with(&dir, "cursor", stdio_entry_for("cursor", "/old/place/piwi-desktop"));
        let _ = std::fs::remove_file(backup_of(&path));
        let concurrent = json!({ "mcpServers": {
            "piwi-desktop": stdio_entry_for("cursor", "/old/place/piwi-desktop"),
            "added-by-the-client": { "command": "uvx" },
        } });
        let text = serde_json::to_string_pretty(&concurrent).unwrap();
        assert!(!heal_client_file_checked("cursor", &path, TOKEN, || std::fs::write(&path, &text).unwrap()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        assert!(!backup_of(&path).exists());
    }

    #[test]
    fn a_bridge_entry_is_told_from_other_commands() {
        assert!(is_bridge_entry(&json!({ "command": EXE, "args": ["mcp-stdio"] })));
        assert!(is_bridge_entry(&json!({ "type": "local", "command": [EXE, "mcp-stdio"] })));
        assert!(!is_bridge_entry(&json!({ "command": "npx", "args": ["-y", "some-server"] })));
        assert!(!is_bridge_entry(&json!({ "type": "local", "command": ["npx", "some-server"] })));
        assert!(!is_bridge_entry(&json!({ "url": "http://127.0.0.1:3000/mcp" })));
        assert!(!is_bridge_entry(&json!({ "args": ["mcp-stdio"] })));
    }

    #[test]
    fn classify_distinguishes_missing_current_and_stale() {
        let expected = entry_for("cursor");
        assert_eq!(classify(None, "mcpServers", &expected), "not_connected");
        let empty = json!({});
        assert_eq!(
            classify(Some(&empty), "mcpServers", &expected),
            "not_connected"
        );
        let connected = json!({ "mcpServers": { "piwi-desktop": expected } });
        assert_eq!(
            classify(Some(&connected), "mcpServers", &expected),
            "connected"
        );
        let stale =
            json!({ "mcpServers": { "piwi-desktop": { "url": "http://127.0.0.1:9999/mcp" } } });
        assert_eq!(classify(Some(&stale), "mcpServers", &expected), "stale");
    }

    /// A hosted Piwi a user keeps under `piwi` is invisible to classify — the
    /// app only ever looks at its own `piwi-desktop` key, so the two never fight.
    #[test]
    fn a_hosted_piwi_under_the_legacy_key_does_not_read_as_connected() {
        let expected = entry_for("cursor");
        let hosted = json!({ "mcpServers": { "piwi": { "url": "https://piwi.example.com/mcp" } } });
        assert_eq!(
            classify(Some(&hosted), "mcpServers", &expected),
            "not_connected"
        );
    }

    #[test]
    fn merge_preserves_unrelated_keys_and_servers() {
        let existing = json!({
            "theme": "dark",
            "mcpServers": { "other": { "command": "npx", "args": ["other-mcp"] } }
        });
        let merged = merge_piwi_entry(existing, "mcpServers", Some(json!({ "url": "u" })));
        assert_eq!(merged["theme"], "dark");
        assert_eq!(merged["mcpServers"]["other"]["command"], "npx");
        assert_eq!(merged["mcpServers"]["piwi-desktop"]["url"], "u");
    }

    #[test]
    fn merge_removes_only_our_own_entry() {
        let existing = json!({
            "mcpServers": { "piwi-desktop": { "url": "u" }, "other": { "command": "npx" } }
        });
        let merged = merge_piwi_entry(existing, "mcpServers", None);
        assert!(merged["mcpServers"].get("piwi-desktop").is_none());
        assert_eq!(merged["mcpServers"]["other"]["command"], "npx");
    }

    #[test]
    fn merge_creates_the_container_on_a_fresh_file() {
        let merged = merge_piwi_entry(json!({}), "servers", Some(json!({ "type": "http" })));
        assert_eq!(merged["servers"]["piwi-desktop"]["type"], "http");
    }

    /// Connecting rewrites an older build's loopback `piwi` to `piwi-desktop`,
    /// leaving no dead duplicate behind.
    #[test]
    fn merge_retires_a_legacy_loopback_entry_it_wrote() {
        let existing = json!({
            "mcpServers": {
                "piwi": { "type": "http", "url": "http://127.0.0.1:3000/mcp", "headers": { "Authorization": "Bearer pd_old" } }
            }
        });
        let merged = merge_piwi_entry(existing, "mcpServers", Some(json!({ "url": "new" })));
        assert!(
            merged["mcpServers"].get("piwi").is_none(),
            "stale loopback piwi should be dropped"
        );
        assert_eq!(merged["mcpServers"]["piwi-desktop"]["url"], "new");
    }

    /// The legacy Claude Desktop shape (this exe in bridge mode) is also ours to
    /// retire.
    #[test]
    fn merge_retires_a_legacy_stdio_bridge_entry() {
        let existing = json!({
            "mcpServers": { "piwi": { "command": "/Applications/Piwi.app/piwi-desktop", "args": ["mcp-stdio"] } }
        });
        let merged = merge_piwi_entry(existing, "mcpServers", Some(json!({ "command": "x", "args": ["mcp-stdio"] })));
        assert!(merged["mcpServers"].get("piwi").is_none());
        assert!(merged["mcpServers"].get("piwi-desktop").is_some());
    }

    /// A hosted Piwi under `piwi` is never removed — only this app's own leftovers.
    #[test]
    fn merge_keeps_a_hosted_piwi_under_the_legacy_key() {
        let existing = json!({
            "mcpServers": { "piwi": { "url": "https://piwi.example.com/mcp", "headers": { "Authorization": "Bearer pd_x" } } }
        });
        let merged = merge_piwi_entry(existing, "mcpServers", Some(json!({ "url": "new" })));
        assert_eq!(
            merged["mcpServers"]["piwi"]["url"],
            "https://piwi.example.com/mcp",
            "a remote piwi must be left alone"
        );
        assert_eq!(merged["mcpServers"]["piwi-desktop"]["url"], "new");
    }

    #[test]
    fn local_piwi_entries_are_recognized_but_remote_ones_are_not() {
        assert!(is_local_piwi_entry(&json!({ "url": "http://127.0.0.1:5000/mcp" })));
        assert!(is_local_piwi_entry(&json!({ "serverUrl": "http://localhost:5000/mcp" })));
        assert!(is_local_piwi_entry(&json!({ "command": "piwi-desktop", "args": ["mcp-stdio"] })));
        assert!(!is_local_piwi_entry(&json!({ "url": "https://piwi.example.com/mcp" })));
        assert!(!is_local_piwi_entry(&json!({ "command": "npx", "args": ["other-mcp"] })));
    }

    #[test]
    fn packaged_dirs_map_claude_packages_to_their_redirected_roaming_dir() {
        let temp = TempDir::new("packages");
        temp.mkdir("Claude_pzs8sxrjxfjjc");
        temp.mkdir("SomeOtherApp_abc123");

        let dirs = packaged_claude_dirs(&temp.0);

        assert_eq!(
            dirs,
            vec![temp
                .join("Claude_pzs8sxrjxfjjc")
                .join("LocalCache")
                .join("Roaming")
                .join("Claude")]
        );
    }

    #[test]
    fn packaged_dirs_are_sorted_so_the_choice_is_stable() {
        let temp = TempDir::new("multi");
        temp.mkdir("Claude_zzzzzzzzzzzzz");
        temp.mkdir("Claude_aaaaaaaaaaaaa");

        let dirs = packaged_claude_dirs(&temp.0);

        assert_eq!(dirs.len(), 2);
        assert!(dirs[0].starts_with(temp.join("Claude_aaaaaaaaaaaaa")));
    }

    #[test]
    fn packaged_dirs_are_empty_without_a_package_root() {
        assert!(packaged_claude_dirs(Path::new("/no/such/packages/root")).is_empty());
    }

    #[test]
    fn claude_data_dirs_are_the_lowercase_publisher_folders() {
        let temp = TempDir::new("claude-data");
        temp.mkdir("claude_pzs8sxrjxfjjc");
        std::fs::write(temp.join("README.txt"), "").expect("write readme");

        assert_eq!(
            claude_named_dirs(&temp.0),
            vec![temp.join("claude_pzs8sxrjxfjjc")]
        );
    }

    /// A Windows machine's folders, in the order `claude_desktop_dirs` builds
    /// them: the package container, `%APPDATA%\Claude`, then `Claude-Data`.
    struct WindowsDirs {
        temp: TempDir,
        container: PathBuf,
        appdata: PathBuf,
    }

    impl WindowsDirs {
        fn new(label: &str) -> Self {
            let temp = TempDir::new(label);
            let container =
                temp.join("Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude");
            let appdata = temp.join("Roaming/Claude");
            Self {
                temp,
                container,
                appdata,
            }
        }

        fn candidates(&self) -> Vec<PathBuf> {
            let mut dirs = packaged_claude_dirs(&self.temp.join("Local/Packages"));
            dirs.push(self.appdata.clone());
            dirs.extend(claude_named_dirs(&self.temp.join("Local/Claude-Data")));
            dirs
        }

        fn data(&self) -> PathBuf {
            self.temp.mkdir("Local/Claude-Data/claude_pzs8sxrjxfjjc")
        }
    }

    fn with_config(dir: &Path) {
        std::fs::create_dir_all(dir).expect("create dir");
        std::fs::write(dir.join(CLAUDE_DESKTOP_CONFIG), "{}").expect("write config");
    }

    fn mark_left(dir: &Path) {
        with_config(dir);
        std::fs::write(dir.join(".user-data-left.claude_pzs8sxrjxfjjc"), "").expect("write marker");
    }

    /// Claude Desktop moved its data from the package container to
    /// `Claude-Data`: both older folders keep a marker naming it.
    #[test]
    fn pick_follows_the_data_to_claude_data() {
        let dirs = WindowsDirs::new("moved");
        let data = dirs.data();
        mark_left(&dirs.container);
        mark_left(&dirs.appdata);

        assert_eq!(pick_config_dir(&dirs.candidates()), Some(data));
    }

    /// A config an older install left in `%APPDATA%\Claude`, without a marker,
    /// does not hide the folder the container's marker names.
    #[test]
    fn pick_follows_the_marker_past_an_unmarked_leftover() {
        let dirs = WindowsDirs::new("leftover");
        let data = dirs.data();
        mark_left(&dirs.container);
        with_config(&dirs.appdata);

        assert_eq!(pick_config_dir(&dirs.candidates()), Some(data));
    }

    /// A `Claude-Data` folder no older folder names (a move not made, or one
    /// left by an uninstalled build) loses to the folder that still holds the
    /// data.
    #[test]
    fn pick_keeps_an_older_folder_no_marker_says_was_left() {
        let dirs = WindowsDirs::new("not-moved");
        dirs.data();
        with_config(&dirs.container);

        assert_eq!(
            pick_config_dir(&dirs.candidates()),
            Some(dirs.container.clone())
        );
    }

    /// A recent build installed on a clean machine has only `Claude-Data`.
    #[test]
    fn pick_takes_claude_data_on_a_machine_without_older_folders() {
        let dirs = WindowsDirs::new("fresh");
        let data = dirs.data();

        assert_eq!(pick_config_dir(&dirs.candidates()), Some(data));
    }

    #[test]
    fn the_bridge_command_is_the_appimage_file_when_run_from_its_mount() {
        let temp = Path::new("/tmp");
        let mounted = Path::new("/tmp/.mount_PiwiDaAbC123/usr/bin/piwi-desktop");
        let image = OsStr::new("/home/ada/Apps/Piwi_Dashboard.AppImage");

        assert_eq!(
            bridge_path(Some(mounted), Some(image), temp),
            "/home/ada/Apps/Piwi_Dashboard.AppImage"
        );
        // APPIMAGE set while the executable is not in a mount: the executable.
        assert_eq!(
            bridge_path(Some(Path::new("/usr/bin/piwi-desktop")), Some(image), temp),
            "/usr/bin/piwi-desktop"
        );
        assert_eq!(
            bridge_path(Some(mounted), None, temp),
            mounted.to_string_lossy()
        );
        assert_eq!(bridge_path(None, Some(image), temp), "piwi-desktop");
    }

    #[test]
    fn pick_passes_over_a_folder_the_data_has_left() {
        let temp = TempDir::new("left");
        let container = temp.mkdir("Packages/Claude_x/LocalCache/Roaming/Claude");
        std::fs::write(container.join(".user-data-left.claude_x"), "").expect("write marker");
        let appdata = temp.mkdir("Roaming/Claude");

        let picked = pick_config_dir(&[container, appdata.clone()]);

        assert_eq!(picked, Some(appdata));
    }

    #[test]
    fn pick_prefers_the_container_over_a_config_left_behind_elsewhere() {
        let temp = TempDir::new("pick");
        let container = temp.mkdir("Packages/Claude_x/LocalCache/Roaming/Claude");
        let appdata = temp.mkdir("Roaming/Claude");
        std::fs::write(appdata.join(CLAUDE_DESKTOP_CONFIG), "{}").expect("write config");

        let picked = pick_config_dir(&[container.clone(), appdata]);

        assert_eq!(picked, Some(container));
    }

    #[test]
    fn pick_falls_back_to_the_plain_config_dir_when_no_container_exists() {
        let temp = TempDir::new("fallback");
        let container = temp.join("Packages/Claude_x/LocalCache/Roaming/Claude");
        let appdata = temp.mkdir("Roaming/Claude");

        let picked = pick_config_dir(&[container, appdata.clone()]);

        assert_eq!(picked, Some(appdata));
    }

    #[test]
    fn pick_returns_the_creation_target_when_the_client_is_absent() {
        let temp = TempDir::new("absent");
        let container = temp.join("Packages/Claude_x/LocalCache/Roaming/Claude");
        let appdata = temp.join("Roaming/Claude");

        let picked = pick_config_dir(&[container, appdata.clone()]);

        assert_eq!(picked, Some(appdata));
    }

    #[test]
    fn pick_returns_nothing_without_candidates() {
        assert_eq!(pick_config_dir(&[]), None);
    }

    #[test]
    fn skill_files_stay_inside_the_skills_directory() {
        let folder = Path::new("/work/shop");
        assert_eq!(
            skill_file(folder, "investigate-failure"),
            Some(PathBuf::from(
                "/work/shop/.claude/skills/investigate-failure/SKILL.md"
            ))
        );
        for bad in ["", "../etc", "a/b", "Upper", "-x", "a b", "x\\y"] {
            assert_eq!(skill_file(folder, bad), None, "{bad}");
        }
    }

    #[test]
    fn skills_are_written_then_read_back() {
        let tmp = TempDir::new("skills");
        let folder = tmp.mkdir("project");
        let before = read_skills(&folder, &["investigate-failure".to_string()]).unwrap();
        assert!(before[0].content.is_none());

        let written = write_skills(
            &folder,
            &[
                SkillFile {
                    slug: "investigate-failure".into(),
                    content: Some("---\nname: x\n---\n".into()),
                },
                SkillFile {
                    slug: "apply-locator-healing".into(),
                    content: None,
                },
            ],
        )
        .unwrap();
        assert_eq!(written, vec!["investigate-failure".to_string()]);
        let after = read_skills(
            &folder,
            &[
                "investigate-failure".to_string(),
                "apply-locator-healing".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(after[0].content.as_deref(), Some("---\nname: x\n---\n"));
        assert!(after[1].content.is_none());
    }

    #[test]
    fn a_bad_skill_name_is_refused() {
        let tmp = TempDir::new("skills-bad");
        let folder = tmp.mkdir("project");
        assert!(write_skills(
            &folder,
            &[SkillFile {
                slug: "../x".into(),
                content: Some(String::new())
            }]
        )
        .is_err());
        assert!(read_skills(&folder, &["../x".to_string()]).is_err());
    }
}
