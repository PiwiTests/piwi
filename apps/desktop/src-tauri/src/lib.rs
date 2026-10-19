// Piwi Dashboard desktop shell.
//
// This wraps the *same* Nuxt/Nitro server that ships as the Docker image and the
// `@piwitests/server` npm package. On launch it:
//   1. resolves a per-user data directory (OS app-data dir, survives updates),
//   2. spawns the bundled server as a Node sidecar on a private loopback port,
//   3. waits for `GET /api/health` to return 200 (i.e. the DB has migrated),
//   4. points the window at the local server via a one-time token bootstrap.
// A tray icon offers "run in background" (keep serving after the window closes)
// and "start on login". Everything binds 127.0.0.1 — nothing is exposed to the
// network.

mod ide_launcher;
mod inspect;
mod interrupt;
mod mcp_clients;
mod mcp_stdio;
mod private_fs;
mod repro;
mod runner;
#[cfg(windows)]
mod taskbar_win;
mod updates;
mod worktree;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::async_runtime::Receiver;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Emitter as _, Manager, RunEvent, WindowEvent};

use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::{DialogExt as _, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt as _;
use tauri_plugin_store::StoreExt as _;

use inspect::{desktop_find_importable_runs, desktop_inspect_folder};
use mcp_clients::{
    desktop_mcp_clients, desktop_mcp_connect, desktop_mcp_disconnect, desktop_mcp_reveal, desktop_skills_read,
    desktop_skills_write,
};
use updates::{
    desktop_check_update, desktop_get_update_settings, desktop_install_update, desktop_restart_app,
    desktop_set_update_notification,
};
use runner::{
    desktop_check_local_env, desktop_check_local_specs, desktop_get_project_link,
    desktop_pick_folder, desktop_pick_import_files, desktop_run_local_tests,
    desktop_set_project_link, desktop_set_project_start_command, desktop_stop_local_tests,
};
use repro::desktop_run_repro;
use worktree::{
    desktop_bisect_here, desktop_flake_lab_here, desktop_flake_lab_job, desktop_reproduce_here,
};

pub(crate) const STORE_FILE: &str = "settings.json";
const RUN_BG_KEY: &str = "runInBackground";
/// Persisted maximized state of the main window. Absent on first launch, when
/// the window opens maximized by default.
const WINDOW_MAXIMIZED_KEY: &str = "windowMaximized";
/// How long the splash waits for the server before it says the start is slow; it keeps waiting after.
const READY_TIMEOUT_SECS: u64 = 60;
/// The splash's status line once the server takes longer than `READY_TIMEOUT_SECS`.
const SPLASH_SLOW: &str =
    "The local server is taking longer than usual to start. Still waiting: the window opens the dashboard once it is up.";
/// The splash's status line once the supervisor stopped restarting the server.
const SPLASH_STOPPED: &str =
    "The local server stopped and could not be restarted. Quit and relaunch, or open the logs from the tray.";
/// Backoff before each auto-restart of a crashed server, capped at the last value.
const RESTART_BACKOFFS_SECS: [u64; 4] = [1, 2, 4, 8];
/// Stop auto-restarting once the server has crashed this many times inside
/// `RESTART_WINDOW_SECS` — a tight crash-loop is a real fault, not a transient one.
const MAX_RESTARTS_IN_WINDOW: u32 = 5;
const RESTART_WINDOW_SECS: u64 = 60;
/// Preferred loopback port — stable so the reporter can target it; falls back to
/// a free port if it's already in use (see `pick_port`).
const PREFERRED_PORT: u16 = 3000;
/// Home-relative location of the file the Playwright reporter — and this app's
/// own MCP stdio bridge — read to find this app: `~/.piwi/desktop.json` (see
/// `write_discovery_file`).
pub(crate) const DISCOVERY_DIR: &str = ".piwi";
pub(crate) const DISCOVERY_FILE: &str = "desktop.json";

/// Holds the running Node sidecar so it can be stopped cleanly on quit.
#[derive(Default)]
struct ServerProcess(Mutex<Option<CommandChild>>);

/// Set true when the app is intentionally shutting down, so the server
/// supervisor treats the deliberate `kill()` on quit as expected and does not
/// restart the server it is about to stop.
struct ShuttingDown(Arc<AtomicBool>);

/// Set once the supervisor stopped restarting the server: the readiness wait ends then.
#[derive(Default)]
struct ServerGaveUp(AtomicBool);

/// Shared "keep serving after the window closes" flag (tray toggle + close handler).
struct RunInBackground(Arc<AtomicBool>);

/// Set once the user agrees to quit with local test runs still going. The
/// confirmed close reaches the close handler as a fresh request, and this is
/// what tells it apart from the one the user made.
#[derive(Default)]
struct QuitConfirmed(AtomicBool);

/// The user's data directory — used by the "Open data folder" tray item.
struct DataDir(PathBuf);

/// The reporter discovery file, removed on quit so it never outlives the server.
struct DiscoveryFile(PathBuf);

/// The server log path, shared so the webview error bridge (`desktop_log`) can
/// append to the *same* `logs/server.log` the server sidecar writes to — a
/// webview is a separate process whose console never reaches the sidecar's stdout.
struct LogFile(PathBuf);

/// Whether this launch enabled debug mode (`--devtools` / `PIWI_DEBUG`), so the
/// aux-window opener can mirror the main window and open the inspector too.
struct DebugMode(bool);

/// Archives handed to the app by the OS (drag onto the dock icon, "Open with",
/// a second launch with file arguments) that the dashboard has not collected
/// yet. The shell only ever queues and pokes; the dashboard drains the queue
/// over IPC, so a poke fired before the webview listens is never lost.
#[derive(Default)]
struct PendingOpenFiles(Mutex<Vec<String>>);

/// The files the app opens: Playwright archives (`.zip`) and Piwi Picker's
/// bug reports (`.piwibug`). The dashboard tells them apart by their content.
const OPENED_EXTENSIONS: [&str; 2] = [".zip", ".piwibug"];

fn is_opened_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    OPENED_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Keep only arguments that are real files the app opens; relative paths are
/// resolved against the directory the launching process ran from.
fn collect_open_args<'a>(args: impl Iterator<Item = &'a str>, cwd: Option<&Path>) -> Vec<String> {
    args.filter(|a| is_opened_file(a))
        .filter_map(|a| {
            let p = PathBuf::from(a);
            let abs = if p.is_absolute() { p } else { cwd?.join(p) };
            abs.is_file().then(|| abs.to_string_lossy().to_string())
        })
        .collect()
}

fn queue_open_files(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<PendingOpenFiles>() {
        state.0.lock().unwrap().extend(paths);
        let _ = app.emit("piwi:open-files", ());
    }
}

/// Drain the queue of archives the OS asked this app to open.
#[tauri::command]
fn desktop_take_pending_open_files(app: tauri::AppHandle) -> Vec<String> {
    app.try_state::<PendingOpenFiles>()
        .map(|s| std::mem::take(&mut *s.0.lock().unwrap()))
        .unwrap_or_default()
}

/// Two ambient signals the dashboard drives share the tray tooltip — the unread
/// notification count and the live progress of local test runs — so they are
/// held in one place and composed together instead of overwriting each other.
/// The badge (dock/taskbar) still tracks unread only; run progress goes to the
/// taskbar/Dock progress bar and the window title (see `desktop_set_run_progress`).
#[derive(Default)]
struct TrayStatus(Mutex<TrayStatusInner>);

#[derive(Default)]
struct TrayStatusInner {
    /// Unread notifications raised while the window was hidden/unfocused.
    unread: u32,
    /// The first line of the most recent such notification, shown with the count.
    activity: Option<String>,
    /// Label of the local run(s) currently in flight, e.g. "Running 7/12…".
    progress: Option<String>,
}

const TRAY_TOOLTIP_IDLE: &str = "Piwi Dashboard (click to open)";
/// The window's resting title (matches `tauri.conf.json`); run progress prefixes
/// it while a run is active and it is restored when the run ends.
const MAIN_WINDOW_TITLE: &str = "Piwi Dashboard";

/// Compose the tray tooltip from the ambient signals. An active run leads; the
/// unread count follows; the free-form notification status line shows only
/// alongside an unread count and only when no run is in flight to show instead.
fn compose_tooltip(unread: u32, activity: Option<&str>, progress: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(p) = progress.filter(|s| !s.is_empty()) {
        parts.push(p.to_string());
    }
    if unread > 0 {
        parts.push(format!("{unread} unread"));
        if progress.is_none() {
            if let Some(s) = activity.filter(|s| !s.is_empty()) {
                parts.push(s.to_string());
            }
        }
    }
    if parts.is_empty() {
        TRAY_TOOLTIP_IDLE.to_string()
    } else {
        format!("Piwi Dashboard — {}", parts.join(" — "))
    }
}

/// Re-render the tray tooltip from the current `TrayStatus`. Called on the main
/// thread by whichever signal changed.
fn refresh_tray_tooltip(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<TrayStatus>() else {
        return;
    };
    let tooltip = {
        let inner = state.0.lock().unwrap();
        compose_tooltip(inner.unread, inner.activity.as_deref(), inner.progress.as_deref())
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

/// Ambient unread status while the window is hidden or unfocused: an unread
/// count on the dock/taskbar badge (where the platform supports one) and the
/// tray tooltip. Driven by the dashboard, which knows what fired; the shell only
/// renders. Count 0 clears the unread part (a run's progress, if any, stays).
#[tauri::command]
fn desktop_set_activity(app: tauri::AppHandle, count: u32, status: Option<String>) {
    let handle = app.clone();
    // Badge and tray mutations belong on the main thread on every platform.
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("main") {
            // Unsupported platforms (Windows) reject the call — that's fine,
            // the tray tooltip still carries the count.
            let _ = w.set_badge_count(if count > 0 { Some(count as i64) } else { None });
        }
        if let Some(state) = handle.try_state::<TrayStatus>() {
            let mut inner = state.0.lock().unwrap();
            inner.unread = count;
            inner.activity = status.filter(|s| !s.is_empty());
        }
        refresh_tray_tooltip(&handle);
    });
}

/// Map the dashboard's run state to a taskbar/Dock progress-bar status. Any
/// unrecognised value (including "none") clears the bar.
fn progress_bar_status(state: &str) -> Option<ProgressBarStatus> {
    match state {
        "normal" => Some(ProgressBarStatus::Normal),
        "indeterminate" => Some(ProgressBarStatus::Indeterminate),
        "paused" => Some(ProgressBarStatus::Paused),
        "error" => Some(ProgressBarStatus::Error),
        _ => None,
    }
}

/// The colour of the status dot drawn on the tray icon (all platforms) and the
/// taskbar overlay icon (Windows) for a run state, or `None` when the run is
/// idle and the app's own icon should show instead. A determinate `normal` at
/// 100% is the finished-pass flash (green); a running `normal` is blue, or red
/// while `failing` (a test has failed so far).
fn status_dot_color(state: &str, fraction: Option<f64>, failing: bool) -> Option<(u8, u8, u8)> {
    const RED: (u8, u8, u8) = (220, 38, 38); // red-600 — failed / failing
    match state {
        "error" => Some(RED),
        "paused" => Some((217, 119, 6)), // amber-600 — paused / interrupted
        "normal" | "indeterminate" if failing => Some(RED),
        "normal" if fraction.is_some_and(|f| f >= 1.0) => Some((22, 163, 74)), // green-600 — passed
        "normal" | "indeterminate" => Some((37, 99, 235)), // blue-600 — running
        _ => None, // none / unknown — restore the app icon
    }
}

/// Draw a filled, 1px anti-aliased circle in `color` on a transparent square as
/// raw RGBA — a small status dot for the tray/overlay icon. Kept dependency-free
/// (no image crate) since the shape is trivial; the taskbar/Dock bar and the
/// tooltip carry the exact fraction, so the dot only needs to convey state.
fn render_status_dot(color: (u8, u8, u8), size: u32) -> Vec<u8> {
    let (r, g, b) = color;
    let n = size as f32;
    let center = n / 2.0;
    // A small margin so the dot is not clipped at the icon's edge.
    let radius = center - n * 0.08;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 + 0.5 - center;
            let dy = y as f32 + 0.5 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            let alpha = if dist <= radius - 0.5 {
                255.0
            } else if dist >= radius + 0.5 {
                0.0
            } else {
                (radius + 0.5 - dist) * 255.0
            };
            rgba.extend_from_slice(&[r, g, b, alpha.round().clamp(0.0, 255.0) as u8]);
        }
    }
    rgba
}

/// Live progress of the local test run(s), rendered on the OS shell so a run can
/// be watched with the window minimised or in the tray: the taskbar/Dock progress
/// bar, the window title (which the Windows taskbar shows on hover) and the tray
/// tooltip. Driven by the dashboard, which aggregates its active runs into one
/// `state` (`normal`/`indeterminate`/`paused`/`error`/`none`), an optional 0–1
/// `fraction`, a `label` and whether any of them is `failing`, which turns the
/// status dot red. `state = "none"` clears the bar and restores the resting
/// title; run progress leaves the tooltip while the unread count (if any) stays.
#[tauri::command]
fn desktop_set_run_progress(
    app: tauri::AppHandle,
    state: String,
    fraction: Option<f64>,
    label: Option<String>,
    failing: Option<bool>,
) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let status = progress_bar_status(&state);
        let active = status.is_some();
        let glyph = status_dot_color(&state, fraction, failing.unwrap_or(false));
        if let Some(w) = handle.get_webview_window("main") {
            // A determinate bar carries the fraction as 0–100; an indeterminate
            // one (a countless phase such as install/checkout) carries none.
            let progress = match &status {
                Some(ProgressBarStatus::Indeterminate) | None => None,
                Some(_) => fraction.map(|f| (f.clamp(0.0, 1.0) * 100.0).round() as u64),
            };
            let _ = w.set_progress_bar(ProgressBarState {
                status: Some(status.unwrap_or(ProgressBarStatus::None)),
                progress,
            });
            let title = match label.as_deref().filter(|s| active && !s.is_empty()) {
                Some(l) => format!("▶ {l} · {MAIN_WINDOW_TITLE}"),
                None => MAIN_WINDOW_TITLE.to_string(),
            };
            let _ = w.set_title(&title);
            // Windows only: a small state dot in the corner of the taskbar button
            // (the overlay-icon API is Windows-specific).
            #[cfg(windows)]
            {
                let overlay =
                    glyph.map(|c| tauri::image::Image::new_owned(render_status_dot(c, 16), 16, 16));
                let _ = w.set_overlay_icon(overlay);
            }
        }
        // Tray icon: a state dot while a run is active, the app's own icon when
        // idle — an at-a-glance status when the window is closed to the tray.
        if let Some(tray) = handle.tray_by_id("main") {
            let icon = match glyph {
                Some(c) => Some(tauri::image::Image::new_owned(render_status_dot(c, 32), 32, 32)),
                None => handle.default_window_icon().cloned(),
            };
            let _ = tray.set_icon(icon);
        }
        if let Some(tray_state) = handle.try_state::<TrayStatus>() {
            let mut inner = tray_state.0.lock().unwrap();
            inner.progress = if active { label.filter(|s| !s.is_empty()) } else { None };
        }
        refresh_tray_tooltip(&handle);
    });
}

pub(crate) fn random_hex_32() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Prefer a stable port (so the address is bookmarkable and the reporter can
/// target it) and fall back to any free loopback port if it's taken. A small
/// TOCTOU window remains between picking and the server binding; if the port is
/// lost in between the server fails to boot, surfacing as a readiness timeout.
fn pick_port() -> u16 {
    if std::net::TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).is_ok() {
        return PREFERRED_PORT;
    }
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .expect("failed to acquire a free loopback port")
}

/// The response header the sidecar's `/api/health` echoes the launch nonce in.
const LAUNCH_NONCE_HEADER: &str = "x-piwi-desktop-nonce";

/// Dependency-free readiness probe. `/api/health` returns 200 only after the
/// database has migrated, so a 200 means the app is ready to load — when it
/// also carries this launch's nonce, which only the sidecar this app spawned
/// knows. Another process that took the port first never gets the session
/// bootstrap and its token.
fn health_ok(port: u16, nonce: &str) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let req =
        format!("GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    // The headers fit well within this; a read cut short by the timeout keeps what arrived.
    let mut buf = Vec::new();
    let _ = stream.take(16 * 1024).read_to_end(&mut buf);
    health_response_proves(&String::from_utf8_lossy(&buf), nonce)
}

/// Whether a raw `/api/health` response is a 200 carrying `nonce` in
/// [`LAUNCH_NONCE_HEADER`].
fn health_response_proves(response: &str, nonce: &str) -> bool {
    let head = response.split("\r\n\r\n").next().unwrap_or("");
    let mut lines = head.split("\r\n");
    let ok = lines
        .next()
        .is_some_and(|status| status.split_whitespace().nth(1) == Some("200"));
    ok && !nonce.is_empty()
        && lines.any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.trim().eq_ignore_ascii_case(LAUNCH_NONCE_HEADER) && value.trim() == nonce
            })
        })
}

/// The origin the bundled server is served from: the only web origin the
/// dashboard window may show, and the only one granted the app's IPC.
fn sidecar_origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Whether `url` is on the sidecar's origin: plain `http` to `127.0.0.1` on its
/// port, with no credentials (`http://127.0.0.1:3000@evil.example` is not).
fn is_sidecar_url(url: &tauri::Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}

/// Where the dashboard window may navigate: the app's own bundled pages (the
/// splash), the sidecar's origin once its port is known, and the non-web
/// schemes a page uses (`about:`, `blob:`, `data:`, an IDE's URL scheme). Any
/// other web origin, and a local file, is refused.
fn main_window_may_navigate(url: &tauri::Url, sidecar_port: Option<u16>) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || sidecar_port.is_some_and(|port| is_sidecar_url(url, port))
        }
        "file" => false,
        _ => true,
    }
}

/// The IPC grants of the dashboard (`runtime-capabilities/remote.json`), scoped
/// to the exact origin of the sidecar this launch spawned.
fn remote_capability(port: u16) -> String {
    let mut capability: serde_json::Value =
        serde_json::from_str(include_str!("../runtime-capabilities/remote.json"))
            .expect("runtime-capabilities/remote.json is valid JSON");
    capability["remote"] = json!({ "urls": [sidecar_origin(port)] });
    capability.to_string()
}

/// Read the persisted master encryption key, or generate + persist one on first
/// run. Kept stable so secrets stored in the DB (AI keys, SCM tokens) stay
/// readable across launches. Lives in the user-scoped app-data dir.
fn load_or_create_secret(app_data_dir: &PathBuf) -> String {
    let key_path = app_data_dir.join("secret.key");
    if let Ok(existing) = std::fs::read_to_string(&key_path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let secret = random_hex_32();
    let _ = private_fs::write_private(&key_path, secret.as_bytes());
    secret
}

/// Read the persisted access token, or generate one on first run. Stable (not
/// per-launch) so the Playwright reporter can be configured once, and prefixed
/// `pd_` so the reporter's existing API-key path sends it as `Authorization:
/// Bearer`. Both the window (via cookie) and the reporter (via bearer) present
/// this same token; only someone who can open this app can read it.
fn load_or_create_token(app_data_dir: &PathBuf) -> String {
    let path = app_data_dir.join("reporter-token");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let token = format!("pd_{}", random_hex_32());
    let _ = private_fs::write_private(&path, token.as_bytes());
    token
}

/// Publish the loopback URL and access token to `~/.piwi/desktop.json` so the
/// Playwright reporter can find this app with no configuration at all — it reads
/// this file only when nothing else sets a server URL or API key.
///
/// Written on every launch because the port is not guaranteed (`pick_port` falls
/// back when 3000 is taken) and removed on quit, so the file's presence means
/// "this app is up at this address". Mode 0600: the token is a full-access local
/// credential, and `$HOME` itself is world-readable on most systems.
fn write_discovery_file(
    home: &Path,
    port: u16,
    token: &str,
    links: &HashMap<String, runner::LinkRecord>,
) -> std::io::Result<PathBuf> {
    let dir = home.join(DISCOVERY_DIR);
    private_fs::create_private_dir(&dir)?;
    let path = dir.join(DISCOVERY_FILE);
    private_fs::write_private(&path, discovery_body(port, token, links).to_string().as_bytes())?;
    Ok(path)
}

/// The discovery file's content: the address and token, and the projects linked
/// to a folder on this machine, so an editor opened on one of those folders
/// connects to its project with no setup, and the bundled server reads a
/// project's git history from its folder. Readers ignore fields they do not know.
fn discovery_body(port: u16, token: &str, links: &HashMap<String, runner::LinkRecord>) -> serde_json::Value {
    let mut projects: Vec<(i64, &str)> = links
        .iter()
        .filter_map(|(id, link)| id.parse::<i64>().ok().map(|id| (id, link.path.as_str())))
        .collect();
    projects.sort();
    // 127.0.0.1 rather than localhost: the server binds v4 loopback only, and
    // localhost resolves to ::1 first on some systems.
    json!({
        "url": format!("http://127.0.0.1:{port}"),
        "token": token,
        "projects": projects.iter().map(|(id, path)| json!({ "id": id, "path": path })).collect::<Vec<_>>(),
    })
}

/// Rewrite the discovery file after a folder link changes, while this app
/// publishes one.
pub(crate) fn refresh_discovery_file(app: &AppHandle) {
    let (Some(file), Some(info)) = (
        app.try_state::<DiscoveryFile>(),
        app.try_state::<mcp_clients::ServerInfo>(),
    ) else {
        return;
    };
    // Removed on quit: never bring it back for a server that is going away.
    if !file.0.exists() {
        return;
    }
    let body = discovery_body(info.port, &info.token, &runner::read_links(app));
    let _ = private_fs::write_private(&file.0, body.to_string().as_bytes());
}

/// Convert a path to a string Node can consume as a CLI arg / env value. On
/// Windows, Tauri's resource + app-data paths come back with the `\\?\` verbatim
/// prefix, which Node's module resolver mishandles (it splits `\\?\C:\...` wrong
/// and dies with `EISDIR: lstat 'C:'`) — strip it. No-op on other platforms.
pub(crate) fn node_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// Append a line to the server log. A release build is a windowed app with no
/// console, so the sidecar's output and any startup errors would otherwise be
/// invisible — this makes them readable via the data folder's `logs/server.log`.
fn append_log(path: &std::path::Path, line: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// A `PIWI_DEBUG`-style value counts as "on" unless it is empty or an explicit
/// off word — so `PIWI_DEBUG=1`, `=true`, or even a bare `PIWI_DEBUG=` set to
/// `on` all enable it, while `=0`/`false`/`off`/`no` (and unset) do not.
fn is_truthy_flag(value: &str) -> bool {
    !matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "" | "0" | "false" | "off" | "no"
    )
}

/// Whether this launch asked for debug mode: the `--devtools` argument, or a
/// truthy `PIWI_DEBUG` environment value. Split out from `run()` so it is unit
/// testable without a real process environment.
fn debug_mode_requested<'a>(mut args: impl Iterator<Item = &'a str>, piwi_debug: Option<&str>) -> bool {
    args.any(|a| a == "--devtools" || a == "--debug") || piwi_debug.is_some_and(is_truthy_flag)
}

/// Prepare a webview log line for `logs/server.log`: collapse newlines to keep
/// one event on one line, and cap the length so a runaway error loop in the
/// webview cannot grow the log without bound. Truncation lands on a char
/// boundary so a multi-byte character is never split (`String::truncate` would
/// otherwise panic, and this build aborts on panic).
fn clamp_log_line(message: &str) -> String {
    const MAX: usize = 4000;
    let mut msg = message.replace(['\n', '\r'], " ");
    if msg.len() > MAX {
        let mut end = MAX;
        while end > 0 && !msg.is_char_boundary(end) {
            end -= 1;
        }
        msg.truncate(end);
        msg.push('…');
    }
    msg
}

/// Everything needed to (re)spawn the bundled Node server on the *same* loopback
/// port and desktop token, so a restart reconnects the already-loaded window
/// transparently — no re-navigation, and the reporter's discovery file stays valid.
struct ServerConfig {
    server_entry: PathBuf,
    db_path: PathBuf,
    storage_dir: PathBuf,
    secret: String,
    token: String,
    /// Random per launch: `/api/health` echoes it, so `health_ok` knows its own server.
    launch_nonce: String,
    port: u16,
    log_path: PathBuf,
}

/// Spawn the bundled Node sidecar running the Nitro server. Returns its event
/// stream and child handle, or `None` when the sidecar is missing or the spawn
/// fails (both logged to the server log; the readiness probe then times out).
fn spawn_server_process(app: &AppHandle, cfg: &ServerConfig) -> Option<(Receiver<CommandEvent>, CommandChild)> {
    let cmd = match app.shell().sidecar("node") {
        Ok(cmd) => cmd,
        Err(e) => {
            append_log(&cfg.log_path, &format!("sidecar 'node' not found: {e}"));
            return None;
        }
    };
    let cmd = cmd
        .args([node_path(&cfg.server_entry)])
        .env("NODE_ENV", "production")
        .env("NITRO_HOST", "127.0.0.1")
        .env("NITRO_PORT", cfg.port.to_string())
        .env("PIWI_DATABASE_PATH", node_path(&cfg.db_path))
        .env("PIWI_STORAGE_PATH", node_path(&cfg.storage_dir))
        .env("PIWI_SECRET_KEY", cfg.secret.clone())
        .env("PIWI_DESKTOP_TOKEN", cfg.token.clone())
        .env("PIWI_DESKTOP_LAUNCH_NONCE", cfg.launch_nonce.clone())
        // Tell the bundled Nuxt app it is running in the desktop shell so it hides
        // account/user management (single-user, auth off) and surfaces the local
        // connection details (data location, reporter token, MCP endpoint).
        .env("NUXT_PUBLIC_DESKTOP", "true");

    match cmd.spawn() {
        Ok(pair) => Some(pair),
        Err(e) => {
            append_log(&cfg.log_path, &format!("failed to spawn server: {e}"));
            None
        }
    }
}

/// Own the sidecar for the life of the app: tee its output to the log and, when
/// it exits without a deliberate quit (an OOM crash, say), restart it on the same
/// port and token with a capped backoff so the window is never left pointed at a
/// dead port. A tight crash-loop (`MAX_RESTARTS_IN_WINDOW` inside
/// `RESTART_WINDOW_SECS`) stops the loop rather than hammering. Runs on its own
/// thread and keeps `ServerProcess` pointing at the live child.
fn supervise_server(
    app: AppHandle,
    cfg: ServerConfig,
    initial: (Receiver<CommandEvent>, CommandChild),
    shutting_down: Arc<AtomicBool>,
) {
    let (mut rx, child) = initial;
    app.state::<ServerProcess>().0.lock().unwrap().replace(child);

    std::thread::spawn(move || {
        let mut restarts: u32 = 0;
        let mut window_start = Instant::now();

        loop {
            // Drain the sidecar's output (no console in a release build) until it
            // exits or the channel closes.
            while let Some(event) = rx.blocking_recv() {
                match event {
                    CommandEvent::Stdout(line) => append_log(
                        &cfg.log_path,
                        &format!("[server] {}", String::from_utf8_lossy(&line).trim_end()),
                    ),
                    CommandEvent::Stderr(line) => append_log(
                        &cfg.log_path,
                        &format!("[server:err] {}", String::from_utf8_lossy(&line).trim_end()),
                    ),
                    CommandEvent::Error(err) => append_log(&cfg.log_path, &format!("[server:proc] {err}")),
                    CommandEvent::Terminated(payload) => {
                        append_log(
                            &cfg.log_path,
                            &format!("[server] exited: code={:?} signal={:?}", payload.code, payload.signal),
                        );
                        break;
                    }
                    _ => {}
                }
            }

            // A deliberate quit killed the server — do not resurrect it.
            if shutting_down.load(Ordering::SeqCst) {
                break;
            }

            // A server that stayed up past the window has recovered; forget older
            // crashes so a much later, isolated crash still gets the full budget.
            if window_start.elapsed() > Duration::from_secs(RESTART_WINDOW_SECS) {
                restarts = 0;
                window_start = Instant::now();
            }
            if restarts >= MAX_RESTARTS_IN_WINDOW {
                append_log(
                    &cfg.log_path,
                    "[server] crashed repeatedly — stopping auto-restart; relaunch the app or check the logs.",
                );
                give_up_server(&app);
                break;
            }

            let backoff = RESTART_BACKOFFS_SECS[(restarts as usize).min(RESTART_BACKOFFS_SECS.len() - 1)];
            restarts += 1;
            append_log(&cfg.log_path, &format!("[server] restarting in {backoff}s (attempt {restarts})"));
            let _ = app.emit("server-status", "restarting");
            std::thread::sleep(Duration::from_secs(backoff));

            if shutting_down.load(Ordering::SeqCst) {
                break;
            }

            match spawn_server_process(&app, &cfg) {
                Some((new_rx, new_child)) => {
                    app.state::<ServerProcess>().0.lock().unwrap().replace(new_child);
                    rx = new_rx;
                    let _ = app.emit("server-status", "ready");
                }
                None => {
                    give_up_server(&app);
                    break;
                }
            }
        }
    });
}

/// The server is down for good: end the readiness wait, which says so on the
/// splash, and tell the dashboard (`server-status`).
fn give_up_server(app: &AppHandle) {
    app.state::<ServerGaveUp>().0.store(true, Ordering::SeqCst);
    let _ = app.emit("server-status", "crashed");
}

/// The script writing `text` in the splash page's status line: a no-op on any
/// other page, such as the dashboard once the window loaded it.
fn splash_status_script(text: &str) -> String {
    format!(
        "var s=document.getElementById('splash-status');if(s){{s.textContent={};}}",
        serde_json::to_string(text).unwrap_or_else(|_| "''".into())
    )
}

/// Write `text` in the splash's status line and bring the window up: a launch
/// to the tray hides it.
fn show_splash_status(app: &AppHandle, text: &'static str) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("main") {
            let _ = w.eval(&splash_status_script(text));
            let _ = w.show();
        }
    });
}

/// Everything leaving the app must undo: remember the window state, stop the
/// bundled server and the local test runs, and withdraw the reporter discovery
/// file. Runs on every quit (`RunEvent::ExitRequested`) and from the updater's
/// pre-exit hook, since the Windows updater leaves through
/// `std::process::exit` without that event (see updates.rs). Idempotent.
///
/// With `server_wait`, blocks until the server process is really gone (at most
/// that long): a kill only starts the termination, and until it completes the
/// files the server has loaded — the bundled native modules — stay locked.
pub(crate) fn shut_down(app_handle: &AppHandle, server_wait: Option<Duration>) {
    // Remember whether the window was maximized so the next launch
    // restores it (first launch, with no stored value, maximizes).
    if let Some(w) = app_handle.get_webview_window("main") {
        if let Ok(store) = app_handle.store(STORE_FILE) {
            store.set(WINDOW_MAXIMIZED_KEY, json!(w.is_maximized().unwrap_or(false)));
            let _ = store.save();
        }
    }
    // Tell the supervisor this stop is deliberate so it doesn't restart
    // the server we are about to kill.
    if let Some(flag) = app_handle.try_state::<ShuttingDown>() {
        flag.0.store(true, Ordering::SeqCst);
    }
    // Best-effort: stop the bundled server so no orphan process lingers.
    if let Some(child) = app_handle.state::<ServerProcess>().0.lock().unwrap().take() {
        kill_server(child, server_wait);
    }
    // Local test runs die with the shell — never orphan a browser fleet.
    if let Some(runs) = app_handle.try_state::<runner::LocalRuns>() {
        runs.kill_all();
    }
    // Withdraw the reporter discovery file with the server it points
    // at, so a later test run does not try a dead port.
    if let Some(discovery) = app_handle.try_state::<DiscoveryFile>() {
        let _ = std::fs::remove_file(&discovery.0);
    }
}

/// Kill the server sidecar, waiting up to `wait` for it to exit. Only the
/// Windows updater asks to wait — its installer overwrites the files next — so
/// the wait is Windows-only.
fn kill_server(child: CommandChild, wait: Option<Duration>) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

        // Opened before the kill, while the live child still pins its pid, so
        // the handle cannot belong to a later process reusing the number.
        let process = wait.and_then(|_| unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, child.pid()) }.ok());
        let _ = child.kill();
        if let (Some(process), Some(wait)) = (process, wait) {
            let millis = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX);
            unsafe {
                WaitForSingleObject(process, millis);
                let _ = CloseHandle(process);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = wait;
        let _ = child.kill();
    }
}

// ── Desktop service settings, exposed to the in-app Settings UI over IPC ───────
// The bundled dashboard webview drives the same "run in background" and "start on
// login" options as the tray. window.__TAURI__ is injected into the desktop
// webview (withGlobalTauri) and reachable only there — a plain browser at the
// same loopback URL has no native IPC bridge — and the `remote` capability grants
// the loopback origin access. The webview feature-detects the bridge and falls
// back to pointing at the tray when it is absent.

#[derive(serde::Serialize)]
struct ServiceSettings {
    run_in_background: bool,
    start_on_login: bool,
}

#[tauri::command]
fn desktop_get_service_settings(app: tauri::AppHandle) -> ServiceSettings {
    let run_in_background = app
        .try_state::<RunInBackground>()
        .map(|s| s.0.load(Ordering::SeqCst))
        .unwrap_or(false);
    let start_on_login = app.autolaunch().is_enabled().unwrap_or(false);
    ServiceSettings {
        run_in_background,
        start_on_login,
    }
}

#[tauri::command]
fn desktop_set_run_in_background(app: tauri::AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<RunInBackground>() {
        state.0.store(enabled, Ordering::SeqCst);
    }
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(RUN_BG_KEY, json!(enabled));
        let _ = store.save();
    }
}

#[tauri::command]
fn desktop_set_start_on_login(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

// ── Webview-shell affordances the loopback dashboard drives over IPC ────────────
// A webview has no browser chrome, so external links, native notifications, and
// file downloads have to go through the shell. The bundled dashboard calls these
// (only in the desktop build) instead of relying on `target="_blank"`, the Web
// Notification API, or `download` links, none of which work inside the webview.

/// Open a web/mail link in the user's default browser. Scheme-restricted so a
/// stray call can't reveal a file path or launch an app URL.
#[tauri::command]
fn desktop_open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let allowed = url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:");
    if !allowed {
        return Err("unsupported url scheme".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Argv (after the launcher command) that opens `path` at an optional
/// line/column through an IDE's command-line launcher.
///
///  - VS Code family: `--goto <path>:<line>:<col>` — the flag makes the trailing
///    `:line:col` a caret position rather than part of the file name.
///  - JetBrains: `--line <n> --column <c> <path>` — the flags precede the path.
///
/// Line and column are included only when present.
fn ide_launcher_args(
    family: &str,
    path: &str,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<Vec<String>, String> {
    match family {
        "vscode" => {
            let mut target = path.to_string();
            if let Some(l) = line {
                target.push_str(&format!(":{l}"));
                if let Some(c) = column {
                    target.push_str(&format!(":{c}"));
                }
            }
            Ok(vec!["--goto".to_string(), target])
        }
        "jetbrains" => {
            let mut args: Vec<String> = Vec::new();
            if let Some(l) = line {
                args.push("--line".to_string());
                args.push(l.to_string());
                if let Some(c) = column {
                    args.push("--column".to_string());
                    args.push(c.to_string());
                }
            }
            args.push(path.to_string());
            Ok(args)
        }
        other => Err(format!("unknown IDE family: {other}")),
    }
}

/// The launchers the VS Code flavors put on the PATH.
const VSCODE_LAUNCHERS: &[&str] = &["code", "code-insiders", "codium", "cursor"];

/// The JetBrains IDEs' launchers: the names Toolbox gives its shell scripts and
/// an install's `bin` folder uses.
const JETBRAINS_LAUNCHERS: &[&str] = &[
    "idea",
    "webstorm",
    "pycharm",
    "phpstorm",
    "goland",
    "rubymine",
    "clion",
    "rider",
    "rustrover",
    "datagrip",
    "dataspell",
    "aqua",
    "fleet",
    "studio",
    "writerside",
];

/// Whether the webview may have `command` spawned for `family`: only a known
/// IDE launcher of that family, looked up on the PATH and in the IDEs' install
/// folders. Any other name, a path or an interpreter (`sh`, `python3`) never is.
fn is_known_launcher(family: &str, command: &str) -> bool {
    match family {
        "vscode" => VSCODE_LAUNCHERS.contains(&command),
        "jetbrains" => JETBRAINS_LAUNCHERS.contains(&command),
        _ => false,
    }
}

/// Open a source file in a local IDE by spawning its command-line launcher
/// (`code --goto …`, `rider --line …`). The desktop shell does this natively, so
/// it needs no `vscode://`/`jetbrains://` protocol handler, JetBrains Toolbox,
/// open-project name to match or "allow unsigned requests", which the URL
/// schemes depend on.
///
/// Resolves `true` when the launcher started, `false` when the command is not
/// a known IDE launcher or no IDE installed it where the shell looks (so the
/// webview can fall back to a URL scheme), and errors on a non-absolute path or
/// a file that does not exist. The command must be one of the known launchers
/// (`is_known_launcher`), found on the PATH or in the folders the IDEs install
/// their launchers to (`ide_launcher`); the path must be an existing file.
#[tauri::command]
fn desktop_open_in_ide(
    app: tauri::AppHandle,
    command: String,
    family: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<bool, String> {
    if !is_known_launcher(&family, &command) {
        return Ok(false);
    }
    let file = std::path::Path::new(&path);
    if !file.is_absolute() {
        return Err("the file path must be absolute".into());
    }
    if !file.is_file() {
        return Err(format!("file not found: {path}"));
    }
    let args = ide_launcher_args(&family, &path, line, column)?;

    // A missing launcher is reported as `false`, not raised, so the caller can
    // still try a URL scheme. On a successful spawn the child is held on a
    // background task until it exits: the launcher hands the file off to the
    // running IDE and returns in well under a second, but dropping the handle
    // immediately could cut that handoff short.
    let roots = ide_launcher::SearchRoots::from_env(app.path().home_dir().ok());
    let Some(launcher) =
        ide_launcher::resolve_launcher(&roots, ide_launcher::Os::current(), &family, &command)
    else {
        return Ok(false);
    };
    match app.shell().command(launcher).args(args).spawn() {
        Ok((mut rx, child)) => {
            tauri::async_runtime::spawn(async move {
                let _child = child;
                while rx.recv().await.is_some() {}
            });
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

/// Restore, show and focus `window`. Focusing alone does nothing on a minimized
/// or hidden window. On Windows, `set_focus` gets past the focus-stealing
/// prevention that refuses a background app the foreground (tao simulates a key
/// press when `SetForegroundWindow` is refused).
fn bring_to_front(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Bring the dashboard window to the front. The dashboard calls it once it has
/// navigated to a page the user opened in the system browser (a dashboard link
/// clicked in a terminal), so the page shows up where they are looking.
#[tauri::command]
fn desktop_bring_to_front(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        bring_to_front(&w);
    }
}

/// Unique label for each runtime-created auxiliary window (Tauri requires labels
/// to be distinct for the life of the app).
static AUX_WINDOW_SEQ: AtomicU32 = AtomicU32::new(0);

/// Open a dashboard URL in a new app window. `target="_blank"` and `window.open`
/// are dropped inside the webview, so a link that should open a standalone
/// window — the Playwright trace viewer, a captured attachment — does nothing
/// there without this. Restricted to the bundled server's exact origin
/// (`is_sidecar_url`) so a stray call can't point a window at an external site
/// or another local server; because the new window
/// belongs to this app it shares the webview's cookie jar, so the desktop
/// access-token cookie rides along and the guarded file routes it loads
/// (`/api/files/...`, and the trace the viewer fetches) are authorized.
#[tauri::command]
async fn desktop_open_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    let port = app.state::<mcp_clients::ServerInfo>().port;
    if !is_sidecar_url(&parsed, port) {
        return Err("unsupported url".into());
    }
    let label = format!("aux-{}", AUX_WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
    let window = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(parsed))
        .title("Piwi Dashboard")
        .inner_size(1200.0, 820.0)
        .build()
        .map_err(|e| e.to_string())?;
    // In debug mode, open the inspector on the new window too (the trace viewer,
    // an attachment) so it can be debugged like the main window.
    if app.try_state::<DebugMode>().is_some_and(|d| d.0) {
        window.open_devtools();
    }
    Ok(())
}

/// Show a native OS notification (the webview's own Notification API is
/// unavailable / permission-denied there).
#[tauri::command]
fn desktop_notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// Append a line reported by the webview to the server log. The dashboard runs
/// in a separate webview process whose console never reaches the Node sidecar's
/// stdout, so front-end runtime errors — uncaught exceptions, promise
/// rejections, CSP violations, `console.error` — are invisible in a shipped
/// build. The desktop error bridge (`app/plugins/desktop.client.ts`) routes them
/// here so they land in the same `logs/server.log` a user can already open from
/// the tray, leaving a trace on disk for a reported issue. `level` tags the line
/// (`error`/`warn`/other); the message is length-capped (see `clamp_log_line`).
#[tauri::command]
fn desktop_log(app: tauri::AppHandle, level: String, message: String) {
    let Some(log) = app.try_state::<LogFile>() else {
        return;
    };
    let tag = match level.as_str() {
        "error" => "[webview:err]",
        "warn" => "[webview:warn]",
        _ => "[webview]",
    };
    append_log(&log.0, &format!("{tag} {}", clamp_log_line(&message)));
}

/// Decode standard base64 (with or without `=` padding) into raw bytes.
///
/// Binary downloads cross the IPC boundary as base64 because a `Vec<u8>` is
/// serialized as a JSON array of numbers, which costs several times the payload
/// size for an archive of any real weight.
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    fn sextet(c: u8) -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok((c - b'a') as u32 + 26),
            b'0'..=b'9' => Ok((c - b'0') as u32 + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("invalid base64 character".to_string()),
        }
    }

    let cleaned: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();

    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    for chunk in cleaned.chunks(4) {
        if chunk.len() == 1 {
            return Err("truncated base64 input".to_string());
        }
        let mut acc: u32 = 0;
        for (i, byte) in chunk.iter().enumerate() {
            acc |= sextet(*byte)? << (18 - 6 * i);
        }
        let produced = chunk.len() - 1;
        for i in 0..produced {
            out.push(((acc >> (16 - 8 * i)) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// Write `bytes` into `dir` under `name` without ever overwriting an existing
/// file. Tries the plain name first, then inserts a ` (n)` counter before the
/// extension — the disambiguation a browser applies — retrying on collision.
/// `create_new` makes each attempt atomic (no check-then-write race), so the
/// caller-controlled bytes of a download can never replace a file already on
/// disk, e.g. clobber or trojan an installer/DLL the user already trusts.
fn write_new_download(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    use std::io::Write as _;
    let as_path = Path::new(name);
    let stem = as_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let ext = as_path.extension().map(|e| e.to_string_lossy().to_string());
    for n in 0..=1000 {
        let candidate_name = if n == 0 {
            name.to_string()
        } else if let Some(ext) = &ext {
            format!("{stem} ({n}).{ext}")
        } else {
            format!("{stem} ({n})")
        };
        let candidate = dir.join(&candidate_name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut file) => {
                file.write_all(bytes).map_err(|e| e.to_string())?;
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("could not find an unused download filename".to_string())
}

/// Write a file the webview fetched to the user's Downloads folder and reveal it.
/// Returns the saved path. The name is reduced to its base component so a caller
/// can't traverse out of the Downloads directory, and an existing file is never
/// overwritten — a name collision is disambiguated with a ` (n)` suffix.
///
/// `encoding` selects how `contents` is interpreted: omitted or `"utf8"` writes
/// the string as-is, `"base64"` decodes it first so archives, PDFs and images
/// land on disk intact.
#[tauri::command]
fn desktop_save_download(
    app: tauri::AppHandle,
    filename: String,
    contents: String,
    encoding: Option<String>,
) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let name = std::path::Path::new(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "download".to_string());

    let bytes = match encoding.as_deref() {
        Some("base64") => decode_base64(&contents)?,
        _ => contents.into_bytes(),
    };
    let target = write_new_download(&dir, &name, &bytes)?;

    let _ = app.opener().reveal_item_in_dir(&target);
    Ok(node_path(&target))
}

// ── Leaving the app while local test runs are in flight ───────────────────────

/// Every way out of the app kills the local test runs (see
/// `LocalRuns::kill_all`), so each exit path asks first while any is going:
/// `proceed` runs at once when nothing is active, and only on confirmation
/// otherwise. `verb` fills the question ("quitting" / "restarting"), and
/// `confirm_label` names its confirm button.
///
/// The callback form keeps the event loop free — a blocking dialog here would
/// freeze the very window the question is about.
pub(crate) fn confirm_stopping_local_runs(
    app: &AppHandle,
    title: &str,
    verb: &str,
    confirm_label: &str,
    proceed: impl FnOnce() + Send + 'static,
) {
    let active = app
        .try_state::<runner::LocalRuns>()
        .map(|runs| runs.active_count())
        .unwrap_or(0);
    if active == 0 {
        proceed();
        return;
    }
    app.dialog()
        .message(format!(
            "{active} local test run(s) are still running — {verb} stops them."
        ))
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            confirm_label.into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            if confirmed {
                proceed();
            }
        });
}

/// The window-close variant of the question above.
///
/// Reports whether the close has to be held back: `true` once the question is on
/// screen, `false` when the close may proceed — nothing is running, or the user
/// has already agreed to stop it. Confirming closes the window again, which runs
/// the normal exit path; `QuitConfirmed` is what tells that close apart from the
/// one the user made.
fn hold_close_for_local_runs(window: &tauri::Window) -> bool {
    let confirmed = window
        .try_state::<QuitConfirmed>()
        .is_some_and(|s| s.0.load(Ordering::SeqCst));
    if confirmed {
        return false;
    }
    let active = window
        .try_state::<runner::LocalRuns>()
        .map(|runs| runs.active_count())
        .unwrap_or(0);
    if active == 0 {
        return false;
    }

    let target = window.clone();
    confirm_stopping_local_runs(
        window.app_handle(),
        "Quit Piwi?",
        "quitting",
        "Quit",
        move || {
            if let Some(state) = target.try_state::<QuitConfirmed>() {
                state.0.store(true, Ordering::SeqCst);
            }
            let _ = target.close();
        },
    );
    true
}

/// e2e-only capability granting the Playwright plugin's `pw_result` callback
/// command to the loopback origin the dashboard is served from. Added at runtime
/// (see `add_capability`) so it never ships in production installers.
#[cfg(feature = "e2e-testing")]
const E2E_PLAYWRIGHT_CAPABILITY: &str = r#"{
  "identifier": "e2e-playwright",
  "description": "e2e test builds only: let the Playwright-driven dashboard post results back to the control plugin.",
  "windows": ["main"],
  "remote": { "urls": ["http://localhost:*", "http://127.0.0.1:*"] },
  "permissions": ["playwright:default"]
}"#;

pub fn run() {
    // Windows: a stop request for a local run starts a short-lived copy of this
    // binary to deliver the Ctrl+C (see interrupt.rs). Handled first — it never
    // opens a window or reaches the running instance.
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.first().map(String::as_str) == Some(interrupt::HELPER_ARG) {
            interrupt::run_helper(args.get(1).map(String::as_str));
        }
    }

    // Claude Desktop only loads stdio MCP servers, so its one-click setup points
    // it at this same binary in bridge mode: it proxies MCP over stdin/stdout to
    // the running app's /mcp endpoint. Handled before the app starts — no window,
    // no tray icon, no second server, and no hand-off to the running instance.
    if std::env::args().skip(1).any(|a| mcp_stdio::is_bridge_arg(&a)) {
        mcp_stdio::run_bridge();
        return;
    }

    let launched_hidden = std::env::args().any(|a| a == "--hidden");

    // Debug mode: `--devtools` (or `--debug`) on the command line, or a truthy
    // `PIWI_DEBUG` env value. Opens the webview inspector so web runtime errors
    // can be inspected live in a shipped build (see the setup hook and
    // `desktop_open_window`). Off by default — a normal launch is unchanged.
    let all_args: Vec<String> = std::env::args().collect();
    let debug_mode = debug_mode_requested(
        all_args.iter().map(String::as_str),
        std::env::var("PIWI_DEBUG").ok().as_deref(),
    );

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A second launch just focuses the running window (never a 2nd
            // server) — and forwards any archives it was asked to open.
            queue_open_files(app, collect_open_args(args.iter().skip(1).map(String::as_str), Some(Path::new(&cwd))));
            if let Some(w) = app.get_webview_window("main") {
                bring_to_front(&w);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_notification::init())
        // The dashboard window, which holds the IPC bridge, stays on the app's
        // own pages and the sidecar's origin (`main_window_may_navigate`).
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("piwi-navigation")
                .on_navigation(|webview, url| {
                    webview.label() != "main"
                        || main_window_may_navigate(
                            url,
                            webview.try_state::<mcp_clients::ServerInfo>().map(|s| s.port),
                        )
                })
                .build(),
        );

    // e2e builds embed the Playwright control plugin so a test runner can drive
    // the real webview over a local socket. Gated behind the `e2e-testing`
    // feature so it is never present in shipped installers.
    #[cfg(feature = "e2e-testing")]
    {
        builder = builder.plugin(tauri_plugin_playwright::init());
    }

    let context = tauri::generate_context!();

    // Update support exists only in builds made with the signing key: CI then
    // applies an updater overlay (tauri.updater.conf.json for .msi,
    // tauri.updater.nsis.conf.json for the per-user .exe), which is what puts an
    // `updater` entry in the compiled config. Without it the plugin stays out
    // entirely and the update commands report "unsupported".
    let updater_supported = context.config().plugins.0.contains_key("updater");
    if updater_supported {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            desktop_get_service_settings,
            desktop_set_run_in_background,
            desktop_set_start_on_login,
            desktop_open_external,
            desktop_open_in_ide,
            desktop_open_window,
            desktop_bring_to_front,
            desktop_notify,
            desktop_log,
            desktop_save_download,
            desktop_pick_folder,
            desktop_pick_import_files,
            desktop_inspect_folder,
            desktop_find_importable_runs,
            desktop_get_project_link,
            desktop_set_project_link,
            desktop_run_local_tests,
            desktop_stop_local_tests,
            desktop_run_repro,
            desktop_set_project_start_command,
            desktop_reproduce_here,
            desktop_bisect_here,
            desktop_flake_lab_here,
            desktop_flake_lab_job,
            desktop_check_local_specs,
            desktop_check_local_env,
            desktop_take_pending_open_files,
            desktop_mcp_clients,
            desktop_mcp_connect,
            desktop_mcp_disconnect,
            desktop_mcp_reveal,
            desktop_skills_read,
            desktop_skills_write,
            desktop_check_update,
            desktop_install_update,
            desktop_restart_app,
            desktop_get_update_settings,
            desktop_set_update_notification,
            desktop_set_activity,
            desktop_set_run_progress
        ])
        .manage(ServerProcess::default())
        .manage(ServerGaveUp::default())
        .manage(runner::LocalRuns::default())
        .manage(TrayStatus::default())
        .manage(QuitConfirmed::default())
        .manage(PendingOpenFiles::default())
        .manage(updates::UpdaterSupport(updater_supported))
        .manage(updates::PendingUpdate::default())
        .setup(move |app| {
            // --- data locations (survive app updates; outside the read-only bundle) ---
            let app_data_dir = app.path().app_data_dir()?;
            // Holds the encryption key, the access token and the database.
            private_fs::create_private_dir(&app_data_dir)?;
            worktree::discard_leftover_worktrees(&app_data_dir);
            let data_dir = app_data_dir.join(".data");
            let storage_dir = data_dir.join("storage");
            // Setting PIWI_DATABASE_PATH disables the server's own auto-mkdir, and
            // libSQL will not create the DB's parent dir — so create it here.
            std::fs::create_dir_all(&storage_dir)?;
            let db_path = data_dir.join("piwi.db");

            // Server logs go to a file so failures are visible in a windowed
            // (console-less) release build — read it via the "Open data folder"
            // tray item, under logs/server.log.
            let log_dir = app_data_dir.join("logs");
            let _ = std::fs::create_dir_all(&log_dir);
            let log_path = log_dir.join("server.log");
            append_log(&log_path, "----- launch -----");

            // Share the log path with the webview error bridge (`desktop_log`)
            // and record whether this is a debug launch (for the aux-window opener).
            app.manage(LogFile(log_path.clone()));
            app.manage(DebugMode(debug_mode));

            let secret = load_or_create_secret(&app_data_dir);
            let token = load_or_create_token(&app_data_dir);
            let port = pick_port();
            let launch_nonce = random_hex_32();

            // The dashboard's IPC grants, for this sidecar's exact origin only.
            app.handle().add_capability(remote_capability(port))?;

            app.manage(DataDir(data_dir.clone()));
            app.manage(mcp_clients::ServerInfo { port, token: token.clone() });

            // MCP client configs written on earlier launches embed the URL and
            // token — bring any that drifted (a different port this launch)
            // back in line before a client tries the dead address.
            mcp_clients::heal_configured_clients(app.handle());

            // --- publish connection details for the Playwright reporter ---
            match app.path().home_dir().map_err(|e| e.to_string()).and_then(|home| {
                write_discovery_file(&home, port, &token, &runner::read_links(app.handle())).map_err(|e| e.to_string())
            }) {
                Ok(path) => {
                    append_log(&log_path, &format!("reporter discovery file: {}", path.display()));
                    app.manage(DiscoveryFile(path));
                }
                // Not fatal: the reporter can still be pointed here by hand with
                // the URL and token shown in Settings.
                Err(e) => append_log(&log_path, &format!("failed to write reporter discovery file: {e}")),
            }

            // --- run-in-background flag (persisted across launches) ---
            let run_bg_initial = app
                .store(STORE_FILE)
                .ok()
                .and_then(|s| s.get(RUN_BG_KEY))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let run_bg = Arc::new(AtomicBool::new(run_bg_initial));
            app.manage(RunInBackground(run_bg.clone()));

            // Flipped on a deliberate quit so the server supervisor tells an
            // intentional shutdown apart from a crash worth restarting.
            let shutting_down = Arc::new(AtomicBool::new(false));
            app.manage(ShuttingDown(shutting_down.clone()));

            // --- resolve the bundled server entry (shipped unpacked via resources) ---
            // Tauri may place the resource at <res>/resources/app-server (preserving
            // the config-relative path) or <res>/app-server — accept either.
            let resource_dir = app.path().resource_dir()?;
            let candidates = [
                resource_dir
                    .join("resources")
                    .join("app-server")
                    .join(".output")
                    .join("server")
                    .join("index.mjs"),
                resource_dir
                    .join("app-server")
                    .join(".output")
                    .join("server")
                    .join("index.mjs"),
            ];
            let server_entry = candidates
                .iter()
                .find(|p| p.exists())
                .cloned()
                .unwrap_or_else(|| candidates[0].clone());
            append_log(
                &log_path,
                &format!(
                    "server entry: {} (exists: {}), port: {}",
                    server_entry.display(),
                    server_entry.exists(),
                    port
                ),
            );

            // --- spawn and supervise the Node sidecar running the Nitro server ---
            // A spawn failure is logged and surfaces as a readiness timeout (the
            // splash shows an error) instead of a silent panic. Once running, the
            // supervisor restarts the server if it exits unexpectedly (e.g. an OOM
            // crash) so the window is never left pointed at a dead port.
            let server_config = ServerConfig {
                server_entry: server_entry.clone(),
                db_path: db_path.clone(),
                storage_dir: storage_dir.clone(),
                secret,
                token: token.clone(),
                launch_nonce: launch_nonce.clone(),
                port,
                log_path: log_path.clone(),
            };
            if let Some(initial) = spawn_server_process(app.handle(), &server_config) {
                supervise_server(app.handle().clone(), server_config, initial, shutting_down.clone());
            } else {
                give_up_server(app.handle());
            }

            // --- when the server is ready, navigate the window to it ---
            // The wait goes on past READY_TIMEOUT_SECS, which only changes what the
            // splash says, and ends when the supervisor gives up or the app quits.
            let nav_handle = app.handle().clone();
            let ready_log = log_path.clone();
            let bootstrap_url = format!("http://127.0.0.1:{port}/__piwi/session?token={token}");
            let quitting = shutting_down.clone();
            std::thread::spawn(move || {
                let started = Instant::now();
                let mut slow = false;
                let ready = loop {
                    if health_ok(port, &launch_nonce) {
                        break true;
                    }
                    let gave_up = nav_handle.state::<ServerGaveUp>().0.load(Ordering::SeqCst);
                    if gave_up || quitting.load(Ordering::SeqCst) {
                        break false;
                    }
                    if !slow && started.elapsed() >= Duration::from_secs(READY_TIMEOUT_SECS) {
                        slow = true;
                        append_log(&ready_log, "server not ready yet, still waiting");
                        show_splash_status(&nav_handle, SPLASH_SLOW);
                    }
                    std::thread::sleep(Duration::from_millis(if slow { 1000 } else { 250 }));
                };
                append_log(&ready_log, if ready { "server ready" } else { "server never became ready" });
                // Startup has settled: look for an update and announce one
                // (a no-op when the build cannot update or the user opted out).
                tauri::async_runtime::spawn(updates::notify_if_update_available(nav_handle.clone()));
                if !ready {
                    if !quitting.load(Ordering::SeqCst) {
                        show_splash_status(&nav_handle, SPLASH_STOPPED);
                    }
                    return;
                }
                let inner = nav_handle.clone();
                let _ = nav_handle.run_on_main_thread(move || {
                    if let Some(w) = inner.get_webview_window("main") {
                        let _ = w.eval(&format!("window.location.replace('{bootstrap_url}')"));
                    }
                });
            });

            // --- tray ---
            let open_i = MenuItemBuilder::with_id("open", "Open Piwi Dashboard").build(app)?;
            let folder_i = MenuItemBuilder::with_id("open_folder", "Open data folder").build(app)?;
            let bg_i = CheckMenuItemBuilder::with_id("run_bg", "Run in background")
                .checked(run_bg_initial)
                .build(app)?;
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let login_i = CheckMenuItemBuilder::with_id("autostart", "Start on login")
                .checked(autostart_enabled)
                .build(app)?;
            let quit_i = MenuItemBuilder::with_id("quit", "Quit Piwi Dashboard").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&open_i)
                .item(&folder_i)
                .separator()
                .item(&bg_i)
                .item(&login_i)
                .separator()
                .item(&quit_i)
                .build()?;

            let menu_run_bg = run_bg.clone();
            let _tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Piwi Dashboard (click to open)")
                .menu(&menu)
                // Left-click opens the window; right-click shows the menu.
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            bring_to_front(&w);
                        }
                    }
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            bring_to_front(&w);
                        }
                    }
                    "open_folder" => {
                        let dir = app.state::<DataDir>().0.clone();
                        let _ = app
                            .opener()
                            .open_path(dir.to_string_lossy().to_string(), None::<&str>);
                    }
                    "run_bg" => {
                        let next = !menu_run_bg.load(Ordering::SeqCst);
                        menu_run_bg.store(next, Ordering::SeqCst);
                        let _ = bg_i.set_checked(next);
                        if let Ok(store) = app.store(STORE_FILE) {
                            store.set(RUN_BG_KEY, json!(next));
                            let _ = store.save();
                        }
                    }
                    "autostart" => {
                        let mgr = app.autolaunch();
                        let enabled = mgr.is_enabled().unwrap_or(false);
                        let _ = if enabled { mgr.disable() } else { mgr.enable() };
                        let _ = login_i.set_checked(!enabled);
                    }
                    "quit" => {
                        let handle = app.clone();
                        confirm_stopping_local_runs(app, "Quit Piwi?", "quitting", "Quit", move || {
                            handle.exit(0);
                        });
                    }
                    _ => {}
                })
                .build(app)?;

            // Window size: maximized on first launch (no stored preference), and
            // thereafter whatever the user last left it as — persisted on quit
            // (see the ExitRequested handler). Applied while the window is still
            // visible, before the --hidden case may hide it.
            let start_maximized = app
                .store(STORE_FILE)
                .ok()
                .and_then(|s| s.get(WINDOW_MAXIMIZED_KEY))
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            if start_maximized {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.maximize();
                }
            }

            // If autostarted with --hidden, stay in the tray instead of popping up.
            if launched_hidden {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            // Debug mode: open the webview inspector so front-end runtime errors
            // are visible in a shipped, console-less build. Compiled in via the
            // `devtools` cargo feature; dormant unless this launch asked for it.
            if debug_mode {
                append_log(&log_path, "debug mode enabled (--devtools/PIWI_DEBUG): opening devtools");
                if let Some(w) = app.get_webview_window("main") {
                    w.open_devtools();
                }
            }

            // Archives passed on the very first launch ("Open with" while the
            // app was closed) — queued now, drained once the dashboard boots.
            let argv: Vec<String> = std::env::args().skip(1).collect();
            let launch_cwd = std::env::current_dir().ok();
            queue_open_files(
                app.handle(),
                collect_open_args(argv.iter().map(String::as_str), launch_cwd.as_deref()),
            );

            // e2e builds: grant the Playwright plugin's result-callback command to
            // the loopback (remote) origin the dashboard runs at, so the driven
            // page can post results back. Added at runtime so the permission only
            // exists in test builds — the shipped ACL never references it.
            #[cfg(feature = "e2e-testing")]
            {
                let _ = app.handle().add_capability(E2E_PLAYWRIGHT_CAPABILITY);
            }

            // Windows: add the Stop/Open buttons to the main window's taskbar
            // thumbnail toolbar (no-op on other platforms).
            #[cfg(windows)]
            if let Some(main) = app.get_webview_window("main") {
                taskbar_win::install(&main);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // The dashboard window is the one whose close ends the app.
                if window.label() != "main" {
                    return;
                }
                let keep = window
                    .try_state::<RunInBackground>()
                    .map(|s| s.0.load(Ordering::SeqCst))
                    .unwrap_or(false);
                if keep {
                    // Hide to tray and keep the server running.
                    let _ = window.hide();
                    api.prevent_close();
                    return;
                }
                if hold_close_for_local_runs(window) {
                    api.prevent_close();
                }
            }
        })
        .build(context)
        .expect("error while building the Piwi Dashboard app")
        .run(|app_handle, event| match event {
            RunEvent::ExitRequested { .. } => shut_down(app_handle, None),
            // macOS delivers file-association opens as an event, not argv.
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .filter(|p| is_opened_file(p))
                    .collect();
                queue_open_files(app_handle, paths);
                if let Some(w) = app_handle.get_webview_window("main") {
                    bring_to_front(&w);
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_log_line, collect_open_args, compose_tooltip, debug_mode_requested, discovery_body,
        health_response_proves, ide_launcher_args, is_known_launcher, is_sidecar_url,
        is_truthy_flag, main_window_may_navigate, progress_bar_status, remote_capability,
        render_status_dot, splash_status_script, status_dot_color, write_new_download,
    };
    use std::fs;
    use tauri::window::ProgressBarStatus;

    #[test]
    fn discovery_lists_the_linked_projects_by_id() {
        let mut links = std::collections::HashMap::new();
        let link = |path: &str| crate::runner::LinkRecord { path: path.into(), ..Default::default() };
        links.insert("12".to_string(), link("/work/shop"));
        links.insert("3".to_string(), link("/work/admin"));
        links.insert("not-an-id".to_string(), link("/work/other"));
        assert_eq!(
            discovery_body(3001, "pd_x", &links),
            serde_json::json!({
                "url": "http://127.0.0.1:3001",
                "token": "pd_x",
                "projects": [{ "id": 3, "path": "/work/admin" }, { "id": 12, "path": "/work/shop" }],
            })
        );
    }

    #[test]
    fn tooltip_composes_run_progress_unread_and_idle() {
        // Idle: nothing to say.
        assert_eq!(compose_tooltip(0, None, None), "Piwi Dashboard (click to open)");
        // Unread only, no run in flight.
        assert_eq!(compose_tooltip(2, None, None), "Piwi Dashboard — 2 unread");
        assert_eq!(
            compose_tooltip(2, Some("acme-web: failure"), None),
            "Piwi Dashboard — 2 unread — acme-web: failure"
        );
        // A run in flight leads and its label is what shows.
        assert_eq!(
            compose_tooltip(0, None, Some("Running 7/12…")),
            "Piwi Dashboard — Running 7/12…"
        );
        // Both signals: the run leads, the count follows, the notification status
        // line is dropped (the run is the more useful thing to surface).
        assert_eq!(
            compose_tooltip(3, Some("acme-web: failure"), Some("Running 7/12…")),
            "Piwi Dashboard — Running 7/12… — 3 unread"
        );
        // Empty strings are treated as absent, not shown as blanks.
        assert_eq!(compose_tooltip(0, Some(""), Some("")), "Piwi Dashboard (click to open)");
    }

    #[test]
    fn progress_state_maps_to_a_bar_status_and_none_clears() {
        assert!(matches!(progress_bar_status("normal"), Some(ProgressBarStatus::Normal)));
        assert!(matches!(
            progress_bar_status("indeterminate"),
            Some(ProgressBarStatus::Indeterminate)
        ));
        assert!(matches!(progress_bar_status("paused"), Some(ProgressBarStatus::Paused)));
        assert!(matches!(progress_bar_status("error"), Some(ProgressBarStatus::Error)));
        // "none" and anything unrecognised clear the bar.
        assert!(progress_bar_status("none").is_none());
        assert!(progress_bar_status("").is_none());
        assert!(progress_bar_status("bogus").is_none());
    }

    #[test]
    fn status_dot_color_maps_states_to_colours() {
        assert_eq!(status_dot_color("error", None, false), Some((220, 38, 38)));
        assert_eq!(status_dot_color("paused", None, false), Some((217, 119, 6)));
        // Running is blue; the finished-pass flash (normal at 100%) is green.
        assert_eq!(status_dot_color("normal", Some(0.5), false), Some((37, 99, 235)));
        assert_eq!(status_dot_color("indeterminate", None, false), Some((37, 99, 235)));
        assert_eq!(status_dot_color("normal", Some(1.0), false), Some((22, 163, 74)));
        // Idle / unknown clears the dot so the app icon shows through.
        assert_eq!(status_dot_color("none", None, false), None);
        assert_eq!(status_dot_color("bogus", Some(1.0), false), None);
    }

    #[test]
    fn a_run_with_failures_shows_a_red_dot_while_it_runs() {
        let red = Some((220, 38, 38));
        assert_eq!(status_dot_color("normal", Some(0.5), true), red);
        assert_eq!(status_dot_color("indeterminate", None, true), red);
        assert_eq!(status_dot_color("normal", Some(1.0), true), red);
        // Failing never lights up an idle icon or recolours an interrupted run.
        assert_eq!(status_dot_color("none", None, true), None);
        assert_eq!(
            status_dot_color("paused", Some(1.0), true),
            Some((217, 119, 6))
        );
    }

    #[test]
    fn status_dot_is_opaque_at_the_centre_and_clear_at_the_corners() {
        let size = 32u32;
        let rgba = render_status_dot((10, 20, 30), size);
        assert_eq!(rgba.len(), (size * size * 4) as usize);
        let px = |x: u32, y: u32| {
            let i = ((y * size + x) * 4) as usize;
            (rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3])
        };
        // Centre: fully opaque, in the requested colour.
        assert_eq!(px(size / 2, size / 2), (10, 20, 30, 255));
        // Corner: fully transparent.
        assert_eq!(px(0, 0).3, 0);
    }

    #[test]
    fn truthy_flag_treats_only_off_words_and_empty_as_false() {
        for on in ["1", "true", "TRUE", "on", "yes", "anything"] {
            assert!(is_truthy_flag(on), "{on} should be truthy");
        }
        for off in ["", "  ", "0", "false", "False", "off", "no"] {
            assert!(!is_truthy_flag(off), "{off:?} should be falsy");
        }
    }

    #[test]
    fn debug_mode_is_requested_by_the_flag_or_a_truthy_env() {
        // The flag, in either spelling.
        assert!(debug_mode_requested(["piwi-desktop", "--devtools"].into_iter(), None));
        assert!(debug_mode_requested(["piwi-desktop", "--debug"].into_iter(), None));
        // A truthy env value, with no flag.
        assert!(debug_mode_requested(["piwi-desktop"].into_iter(), Some("1")));
        // Neither.
        assert!(!debug_mode_requested(["piwi-desktop"].into_iter(), None));
        assert!(!debug_mode_requested(["piwi-desktop", "--hidden"].into_iter(), Some("0")));
    }

    #[test]
    fn log_lines_collapse_newlines_and_cap_length_on_a_char_boundary() {
        assert_eq!(clamp_log_line("a\nb\r\nc"), "a b  c");
        // A multi-byte character straddling the cap must not panic or be split:
        // the result is valid UTF-8 and ends with the ellipsis marker.
        let long = "é".repeat(5000); // 2 bytes each → 10_000 bytes
        let clamped = clamp_log_line(&long);
        assert!(clamped.len() <= 4000 + "…".len());
        assert!(clamped.ends_with('…'));
        // A short line is returned unchanged (aside from newline collapsing).
        assert_eq!(clamp_log_line("short"), "short");
    }

    #[test]
    fn vscode_launcher_args_put_the_position_after_the_path() {
        assert_eq!(
            ide_launcher_args("vscode", "/repo/a.ts", Some(12), Some(3)).unwrap(),
            vec!["--goto".to_string(), "/repo/a.ts:12:3".to_string()]
        );
        // Line only, then no position at all.
        assert_eq!(
            ide_launcher_args("vscode", "/repo/a.ts", Some(9), None).unwrap(),
            vec!["--goto".to_string(), "/repo/a.ts:9".to_string()]
        );
        assert_eq!(
            ide_launcher_args("vscode", "/repo/a.ts", None, None).unwrap(),
            vec!["--goto".to_string(), "/repo/a.ts".to_string()]
        );
    }

    #[test]
    fn jetbrains_launcher_args_put_the_flags_before_the_path() {
        assert_eq!(
            ide_launcher_args("jetbrains", "/repo/a.ts", Some(12), Some(3)).unwrap(),
            vec![
                "--line".to_string(),
                "12".to_string(),
                "--column".to_string(),
                "3".to_string(),
                "/repo/a.ts".to_string()
            ]
        );
        // A column without a line is dropped — the launcher needs the line first.
        assert_eq!(
            ide_launcher_args("jetbrains", "/repo/a.ts", None, Some(3)).unwrap(),
            vec!["/repo/a.ts".to_string()]
        );
    }

    #[test]
    fn unknown_ide_family_is_rejected() {
        assert!(ide_launcher_args("emacs", "/repo/a.ts", None, None).is_err());
    }

    #[test]
    fn only_known_ide_launchers_of_the_family_are_spawned() {
        for (family, ok) in [
            ("vscode", "code"),
            ("vscode", "cursor"),
            ("jetbrains", "rider"),
            ("jetbrains", "idea"),
        ] {
            assert!(is_known_launcher(family, ok), "{family} {ok} should be allowed");
        }
        for (family, bad) in [
            ("jetbrains", "sh"),
            ("jetbrains", "python3"),
            ("vscode", "rm"),
            ("jetbrains", "wscript"),
            ("vscode", "rider"),
            ("jetbrains", "code"),
            ("emacs", "code"),
            ("vscode", "/usr/bin/code"),
            ("vscode", "code;rm -rf /"),
            ("vscode", ""),
        ] {
            assert!(!is_known_launcher(family, bad), "{family} {bad:?} should be rejected");
        }
    }

    #[test]
    fn the_splash_status_script_writes_the_text_as_a_string_literal() {
        let script = splash_status_script("It's \"slow\"</div>\n");
        assert!(script.contains(r#"s.textContent="It's \"slow\"</div>\n";"#), "{script}");
        assert!(script.starts_with("var s=document.getElementById('splash-status');"));
    }

    #[test]
    fn the_readiness_probe_needs_a_200_carrying_the_launch_nonce() {
        let ok = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                  X-Piwi-Desktop-Nonce: abc123\r\n\r\n{}";
        assert!(health_response_proves(ok, "abc123"));
        // Another server on the port: a 200 without the nonce, or with another one.
        assert!(!health_response_proves("HTTP/1.1 200 OK\r\n\r\n{}", "abc123"));
        assert!(!health_response_proves(&ok.replace("abc123", "zzz"), "abc123"));
        // The nonce in the body, not a header, proves nothing.
        let in_body = "HTTP/1.1 200 OK\r\n\r\nx-piwi-desktop-nonce: abc123";
        assert!(!health_response_proves(in_body, "abc123"));
        let unavailable = ok.replace(" 200 OK", " 503 Service Unavailable");
        assert!(!health_response_proves(&unavailable, "abc123"));
        assert!(!health_response_proves(ok, ""));
    }

    #[test]
    fn the_sidecar_origin_is_matched_exactly() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(is_sidecar_url(&url("http://127.0.0.1:3000/projects/1?x=1"), 3000));
        for bad in [
            "http://127.0.0.1:3001/",
            "http://localhost:3000/",
            "https://127.0.0.1:3000/",
            "http://localhost:@evil.example/",
            "http://127.0.0.1:3000@evil.example/",
            "http://user:pw@127.0.0.1:3000/",
        ] {
            assert!(!is_sidecar_url(&url(bad), 3000), "{bad} should be rejected");
        }
    }

    #[test]
    fn the_dashboard_window_stays_on_the_app_and_its_sidecar() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(main_window_may_navigate(&url("tauri://localhost/index.html"), None));
        assert!(main_window_may_navigate(&url("http://tauri.localhost/index.html"), None));
        assert!(main_window_may_navigate(&url("http://127.0.0.1:3000/__piwi/session"), Some(3000)));
        assert!(main_window_may_navigate(&url("about:blank"), Some(3000)));
        assert!(!main_window_may_navigate(&url("http://127.0.0.1:3000/"), None));
        assert!(!main_window_may_navigate(&url("http://127.0.0.1:8080/"), Some(3000)));
        assert!(!main_window_may_navigate(&url("https://evil.example/"), Some(3000)));
        assert!(!main_window_may_navigate(&url("file:///etc/passwd"), Some(3000)));
    }

    #[test]
    fn the_remote_capability_grants_only_the_sidecar_origin() {
        let capability: serde_json::Value =
            serde_json::from_str(&remote_capability(41234)).unwrap();
        assert_eq!(capability["remote"]["urls"], serde_json::json!(["http://127.0.0.1:41234"]));
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(capability["permissions"].as_array().is_some_and(|p| !p.is_empty()));
        // `add_capability` panics on a capability it cannot parse.
        assert!(remote_capability(41234)
            .parse::<tauri::utils::acl::capability::CapabilityFile>()
            .is_ok());
    }

    #[test]
    fn does_not_overwrite_an_existing_download() {
        let dir = std::env::temp_dir().join(format!("piwi-dl-a-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p1 = write_new_download(&dir, "report.zip", b"one").unwrap();
        assert_eq!(p1.file_name().unwrap(), "report.zip");
        // A second download of the same name must not overwrite the first.
        let p2 = write_new_download(&dir, "report.zip", b"two").unwrap();
        assert_ne!(p1, p2);
        assert_eq!(p2.file_name().unwrap(), "report (1).zip");
        assert_eq!(fs::read(&p1).unwrap(), b"one"); // original bytes intact
        assert_eq!(fs::read(&p2).unwrap(), b"two");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn disambiguates_extensionless_names() {
        let dir = std::env::temp_dir().join(format!("piwi-dl-b-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p1 = write_new_download(&dir, "LICENSE", b"a").unwrap();
        let p2 = write_new_download(&dir, "LICENSE", b"b").unwrap();
        assert_eq!(p1.file_name().unwrap(), "LICENSE");
        assert_eq!(p2.file_name().unwrap(), "LICENSE (1)");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn increments_counter_on_repeated_collisions() {
        let dir = std::env::temp_dir().join(format!("piwi-dl-c-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let _ = write_new_download(&dir, "a.txt", b"1").unwrap();
        let _ = write_new_download(&dir, "a.txt", b"2").unwrap();
        let p3 = write_new_download(&dir, "a.txt", b"3").unwrap();
        assert_eq!(p3.file_name().unwrap(), "a (2).txt");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opens_archives_and_bug_reports_that_exist() {
        let dir = std::env::temp_dir().join(format!("piwi-open-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for name in ["run.zip", "bug.PIWIBUG", "notes.txt"] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        let args = [
            "--devtools",
            "run.zip",
            "bug.PIWIBUG",
            "notes.txt",
            "missing.piwibug",
        ];
        let opened = collect_open_args(args.into_iter(), Some(dir.as_path()));
        assert_eq!(
            opened,
            [
                dir.join("run.zip").to_string_lossy().to_string(),
                dir.join("bug.PIWIBUG").to_string_lossy().to_string(),
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
