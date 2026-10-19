// One-click MCP client configuration.
//
// The dashboard's /mcp page shows copy-paste snippets for connecting MCP
// clients; on this machine the shell can do better and write the client's own
// config file. Almost every client is configured the same way: a `piwi-desktop`
// entry inside the client's server map, pointing at this app's /mcp endpoint with
// the local access token as the Bearer header. Claude Desktop is the exception —
// it accepts only stdio servers there, so it gets a command instead (see
// `stdio_bridge_entry`).
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
//     (owner-only for a new file, since the entry carries the access token);
//   - only the `piwi-desktop` key (and a stale loopback `piwi`) is touched —
//     everything else in the file is preserved as parsed.
//
// A written URL embeds the port picked at launch, which is not guaranteed
// across launches — so `heal_configured_clients` runs at startup and rewrites
// any entry that no longer matches what this app would write today.

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

impl ServerInfo {
    fn mcp_url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }
    fn bearer(&self) -> String {
        format!("Bearer {}", self.token)
    }
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

/// The `piwi` entry in each client's native shape.
fn entry_for(id: &str, info: &ServerInfo) -> Value {
    let url = info.mcp_url();
    let bearer = info.bearer();
    match id {
        "claude-desktop" => stdio_bridge_entry(&bridge_command()),
        "cursor" => json!({ "url": url, "headers": { "Authorization": bearer } }),
        "opencode" => json!({ "type": "remote", "url": url, "headers": { "Authorization": bearer } }),
        "windsurf" => json!({ "serverUrl": url, "headers": { "Authorization": bearer } }),
        "gemini-cli" => json!({ "httpUrl": url, "headers": { "Authorization": bearer } }),
        // Claude Code and VS Code share the `type: http` shape.
        _ => json!({ "type": "http", "url": url, "headers": { "Authorization": bearer } }),
    }
}

/// Claude Desktop reads **only stdio servers** from `claude_desktop_config.json`
/// — an entry carrying a `url` is refused at startup ("the following entries in
/// claude_desktop_config.json are not valid MCP server configurations and were
/// ignored"), so a remote endpoint has to arrive behind a local command.
///
/// That command is this very app in bridge mode (see `mcp_stdio`): nothing to
/// install, no Node or `npx` on PATH, and because the bridge resolves the
/// address from the reporter discovery file when it runs, the entry never
/// drifts with the port and no token is copied into another app's config.
fn stdio_bridge_entry(command: &str) -> Value {
    json!({ "command": command, "args": [mcp_stdio::STDIO_ARG] })
}

/// This executable, as the path another app can spawn it by. `current_exe`
/// fails only in pathological cases (the binary unlinked mid-run); the bare
/// name is a last resort that at least resolves if the app is on PATH.
fn bridge_command() -> String {
    std::env::current_exe()
        // Windows hands paths back with the `\\?\` verbatim prefix, which
        // launchers mishandle — strip it (see `node_path`).
        .map(|exe| crate::node_path(&exe))
        .unwrap_or_else(|_| "piwi-desktop".to_string())
}

const CLAUDE_DESKTOP_CONFIG: &str = "claude_desktop_config.json";

/// Claude Desktop config directories, in the order they are preferred.
///
/// A Windows Store (MSIX) install runs in a package container, and Windows
/// redirects the writes it aims at `%APPDATA%` into
/// `%LOCALAPPDATA%\Packages\<package family name>\LocalCache\Roaming\` — so
/// that container, not `%APPDATA%\Claude`, holds the file that build reads.
/// Both are offered, container first; on macOS and Linux only the plain
/// config-dir candidate ever exists.
fn claude_desktop_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(local) = app.path().local_data_dir() {
        dirs.extend(packaged_claude_dirs(&local.join("Packages")));
    }
    if let Ok(config) = app.path().config_dir() {
        dirs.push(config.join("Claude"));
    }
    dirs
}

/// The `LocalCache\Roaming\Claude` directory of every `Claude_*` package under
/// the MSIX package root, sorted so the choice never depends on the order the
/// filesystem happens to list entries in.
///
/// The package family name is matched by prefix: its suffix is a hash of the
/// publisher identity, so it is the same on every machine but changes with a
/// re-signed or side-by-side package.
fn packaged_claude_dirs(packages_root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(packages_root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("Claude_"))
        })
        .map(|path| path.join("LocalCache").join("Roaming").join("Claude"))
        .collect();
    dirs.sort();
    dirs
}

/// The first candidate that exists, else the last — where a fresh install of
/// the client would create it. Existence beats content: a container that is
/// present but still empty belongs to the build that is actually installed,
/// while a config left behind elsewhere belongs to one that is not.
fn pick_config_dir(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|dir| dir.is_dir())
        .or_else(|| candidates.last())
        .cloned()
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
    let has_bridge_arg = value
        .get("args")
        .and_then(|v| v.as_array())
        .is_some_and(|args| args.iter().any(|a| a.as_str() == Some(mcp_stdio::STDIO_ARG)));
    has_bridge_arg && value.get("command").is_some()
}

/// Set or remove this app's entry (keyed `PIWI_ENTRY_KEY`), preserving everything
/// else, and drop a stale loopback `piwi` an older build left behind. `entry:
/// None` removes ours. Returns the new document.
fn merge_piwi_entry(existing: Value, container: &str, entry: Option<Value>) -> Value {
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
    // Retire the pre-`piwi-desktop` entry, but only when it is unmistakably ours
    // — never a hosted Piwi a user keeps under `piwi`.
    if map.get(LEGACY_ENTRY_KEY).is_some_and(is_local_piwi_entry) {
        map.remove(LEGACY_ENTRY_KEY);
    }
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

fn status_of(app: &AppHandle, id: &str, info: &ServerInfo) -> McpClientStatus {
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
            Ok(existing) => classify(existing.as_ref(), container_key(id), &entry_for(id, info)),
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
    let info = app
        .try_state::<ServerInfo>()
        .ok_or("server details unavailable")?;
    let (config_path, detect_dir) = paths_of(app, id).ok_or("unknown client")?;
    if !detect_dir.exists() && !config_path.is_file() {
        return Err(format!("{} does not appear to be installed", label_of(id)));
    }
    let existing = read_config(&config_path)?.unwrap_or_else(|| json!({}));
    let entry = if connect {
        Some(entry_for(id, &info))
    } else {
        None
    };
    let doc = merge_piwi_entry(existing, container_key(id), entry);
    write_config(&config_path, &doc)?;
    Ok(status_of(app, id, &info))
}

/// Rewrite the entry of every already-configured client that no longer matches
/// what this app would write — the port is not guaranteed across launches.
/// Quietly skips anything unreadable or manual.
pub fn heal_configured_clients(app: &AppHandle) {
    let Some(info) = app.try_state::<ServerInfo>() else {
        return;
    };
    for id in CLIENT_IDS {
        let status = status_of(app, id, &info);
        if status.status == "stale" {
            let _ = set_entry(app, id, true);
        }
    }
}

#[tauri::command]
pub fn desktop_mcp_clients(app: AppHandle) -> Result<Vec<McpClientStatus>, String> {
    let info = app
        .try_state::<ServerInfo>()
        .ok_or("server details unavailable")?;
    Ok(CLIENT_IDS
        .iter()
        .map(|id| status_of(&app, id, &info))
        .collect())
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

    fn info() -> ServerInfo {
        ServerInfo {
            port: 3000,
            token: "pd_test".into(),
        }
    }

    #[test]
    fn entry_shapes_match_each_client() {
        let i = info();
        assert_eq!(
            entry_for("cursor", &i),
            json!({ "url": "http://127.0.0.1:3000/mcp", "headers": { "Authorization": "Bearer pd_test" } })
        );
        assert_eq!(
            entry_for("windsurf", &i)["serverUrl"],
            "http://127.0.0.1:3000/mcp"
        );
        assert_eq!(
            entry_for("gemini-cli", &i)["httpUrl"],
            "http://127.0.0.1:3000/mcp"
        );
        assert_eq!(
            entry_for("opencode", &i),
            json!({ "type": "remote", "url": "http://127.0.0.1:3000/mcp", "headers": { "Authorization": "Bearer pd_test" } })
        );
        for id in ["claude-code", "vscode"] {
            assert_eq!(entry_for(id, &i)["type"], "http");
        }
    }

    /// Claude Desktop ignores any entry that is not a local command, so it gets
    /// this app in bridge mode — never a URL.
    #[test]
    fn claude_desktop_gets_a_stdio_command_not_a_url() {
        let entry = stdio_bridge_entry(r"C:\Program Files\Piwi Dashboard\piwi-desktop.exe");
        assert_eq!(
            entry,
            json!({
                "command": r"C:\Program Files\Piwi Dashboard\piwi-desktop.exe",
                "args": ["mcp-stdio"],
            })
        );

        let live = entry_for("claude-desktop", &info());
        assert!(live.get("url").is_none());
        assert!(live.get("type").is_none());
        assert!(live["command"].as_str().is_some_and(|c| !c.is_empty()));
    }

    /// The bridge entry carries no port and no token, so it stays correct
    /// whatever port the app lands on — while a URL entry, the shape Claude
    /// Desktop refuses, is classified stale and rewritten on the next launch.
    #[test]
    fn the_claude_desktop_entry_survives_a_port_change() {
        let expected = entry_for("claude-desktop", &info());
        let other_port = entry_for(
            "claude-desktop",
            &ServerInfo {
                port: 51234,
                token: "pd_other".into(),
            },
        );
        assert_eq!(expected, other_port);

        let configured = json!({ "mcpServers": { "piwi-desktop": expected } });
        assert_eq!(
            classify(Some(&configured), "mcpServers", &expected),
            "connected"
        );

        let old_shape = json!({
            "mcpServers": { "piwi-desktop": { "type": "http", "url": "http://127.0.0.1:3000/mcp" } }
        });
        assert_eq!(classify(Some(&old_shape), "mcpServers", &expected), "stale");
    }

    #[test]
    fn classify_distinguishes_missing_current_and_stale() {
        let i = info();
        let expected = entry_for("cursor", &i);
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
        let expected = entry_for("cursor", &info());
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
