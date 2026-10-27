// In-app updates via the Tauri updater.
//
// Only release builds made with the signing key support updates: CI applies an
// updater overlay (`tauri.updater.conf.json` for the .msi channel,
// `tauri.updater.nsis.conf.json` for the per-user .exe channel) when the key
// secret is configured, and that config is what compiles the updater plugin
// config into the app. Everything here degrades to `unsupported` when the
// config is absent, so dev builds and unsigned releases keep working with the
// whole update surface hidden.
//
// Flow: `desktop_check_update` asks the endpoint and parks the found update in
// state; `desktop_install_update` downloads + installs it, streaming progress
// as `piwi:update-progress` events; the dashboard then calls
// `desktop_restart_app` to relaunch into the new version. On Windows the
// install step never returns: the plugin launches the installer and exits the
// app itself (see `SERVER_STOP_WAIT`). The per-user .exe channel runs its
// installer quietly (`installMode: quiet` in `tauri.updater.nsis.conf.json`):
// no window, then the installer relaunches the app. The .msi channel stays
// passive — a progress bar — since its per-machine install needs the UAC
// prompt a quiet msiexec cannot raise.
//
// At startup `notify_if_update_available` runs the same check once and
// announces a found update with a native notification, unless the user turned
// that off (`desktop_set_update_notification`, stored in the settings file).

use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter as _, Manager as _};
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_store::StoreExt as _;
use tauri_plugin_updater::UpdaterExt as _;

use crate::STORE_FILE;

/// Settings key: announce an available update with a notification at startup.
/// Absent means on.
const NOTIFY_ON_STARTUP_KEY: &str = "notifyUpdateOnStartup";

/// How long the Windows install waits for the server sidecar to be gone.
///
/// There the plugin hands over to the installer and leaves through
/// `std::process::exit`, which skips `RunEvent::ExitRequested` and with it the
/// quit cleanup — so the updater's pre-exit hook runs it instead. Left running,
/// the Node sidecar outlives the app with the bundled native modules loaded
/// (sharp's libvips DLLs), and the installer fails on them with "Error opening
/// file for writing". The installer stops a stray sidecar as well
/// (`windows/installer-hooks.nsh`), for updates started by builds without this.
const SERVER_STOP_WAIT: Duration = Duration::from_secs(5);

/// Whether this build carries updater config (set at startup from the
/// compiled Tauri config).
pub struct UpdaterSupport(pub bool);

/// The update found by the last successful check, awaiting installation.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

fn is_supported(app: &AppHandle) -> bool {
    app.try_state::<UpdaterSupport>().is_some_and(|s| s.0)
}

#[derive(Clone, serde::Serialize)]
pub struct UpdateStatus {
    /// `unsupported` | `uptodate` | `available`
    state: &'static str,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
}

impl UpdateStatus {
    fn bare(state: &'static str) -> Self {
        Self {
            state,
            version: None,
            notes: None,
            date: None,
        }
    }

    fn available(update: &tauri_plugin_updater::Update) -> Self {
        Self {
            state: "available",
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        }
    }
}

#[derive(serde::Serialize)]
pub struct UpdateSettings {
    /// Whether this build can update itself at all.
    supported: bool,
    notify_on_startup: bool,
    /// The update found by an earlier check (the startup one included) and
    /// not installed yet.
    pending: Option<UpdateStatus>,
}

fn notify_on_startup(app: &AppHandle) -> bool {
    app.store(STORE_FILE)
        .ok()
        .and_then(|s| s.get(NOTIFY_ON_STARTUP_KEY))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

#[tauri::command]
pub fn desktop_get_update_settings(app: AppHandle) -> UpdateSettings {
    let pending = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(UpdateStatus::available);
    UpdateSettings {
        supported: is_supported(&app),
        notify_on_startup: notify_on_startup(&app),
        pending,
    }
}

#[tauri::command]
pub fn desktop_set_update_notification(app: AppHandle, enabled: bool) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(NOTIFY_ON_STARTUP_KEY, json!(enabled));
    store.save().map_err(|e| e.to_string())
}

/// Check once at startup and show a native notification when an update is
/// available. Silent when the build cannot update, the user turned the
/// notification off, or the check fails (offline, endpoint down) — a failure
/// only goes to the log.
pub async fn notify_if_update_available(app: AppHandle) {
    if !is_supported(&app) || !notify_on_startup(&app) {
        return;
    }
    match check(&app).await {
        Ok(UpdateStatus {
            state: "available",
            version: Some(version),
            ..
        }) => {
            let _ = app
                .notification()
                .builder()
                .title(format!("Piwi Dashboard {version} is available"))
                .body("Install it from Settings → About → Updates.")
                .show();
        }
        Ok(_) => {}
        Err(e) => {
            if let Some(log) = app.try_state::<crate::LogFile>() {
                crate::append_log(&log.0, &format!("startup update check failed: {e}"));
            }
        }
    }
}

#[tauri::command]
pub async fn desktop_check_update(app: AppHandle) -> Result<UpdateStatus, String> {
    check(&app).await
}

/// Ask the endpoint for a newer version and park a found one for
/// `desktop_install_update`.
async fn check(app: &AppHandle) -> Result<UpdateStatus, String> {
    if !is_supported(app) {
        return Ok(UpdateStatus::bare("unsupported"));
    }

    let hook_app = app.clone();
    let updater = app
        .updater_builder()
        // Setting a hook drops the plugin's default one (`cleanup_before_exit`),
        // so this calls it too.
        .on_before_exit(move || {
            crate::shut_down(&hook_app, Some(SERVER_STOP_WAIT));
            hook_app.cleanup_before_exit();
        })
        .build()
        .map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => {
            let status = UpdateStatus::available(&update);
            app.state::<PendingUpdate>()
                .0
                .lock()
                .unwrap()
                .replace(update);
            Ok(status)
        }
        None => Ok(UpdateStatus::bare("uptodate")),
    }
}

/// Download and install the update found by the last check. Progress streams
/// as `piwi:update-progress` events; on macOS and Linux the app keeps running
/// until the dashboard asks for the restart, on Windows it quits into the
/// installer.
#[tauri::command]
pub async fn desktop_install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or("no update pending — run a check first")?;

    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit(
                    "piwi:update-progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_restart_app(app: AppHandle) {
    let handle = app.clone();
    crate::confirm_stopping_local_runs(&app, "Restart Piwi?", "restarting", "Restart", move || {
        handle.restart();
    });
}

#[cfg(test)]
mod tests {
    /// The updater section of an overlay, read the way the plugin reads it.
    fn overlay_updater(json: &str) -> tauri_plugin_updater::Config {
        let overlay: serde_json::Value = serde_json::from_str(json).unwrap();
        serde_json::from_value(overlay["plugins"]["updater"].clone()).unwrap()
    }

    /// `/S` is the silent install. The relaunch (`/R`) is not part of the install mode: the plugin adds it to every
    /// install that is not built with `restart_after_install(false)`, which `desktop_install_update` never asks for.
    #[test]
    fn the_exe_channel_installs_quietly() {
        let config = overlay_updater(include_str!("../tauri.updater.nsis.conf.json"));
        let windows = config
            .windows
            .expect("the .exe overlay sets the Windows install mode");
        assert_eq!(windows.install_mode.nsis_args(), ["/S"]);
    }

    #[test]
    fn the_msi_channel_keeps_its_progress_bar() {
        let config = overlay_updater(include_str!("../tauri.updater.conf.json"));
        let windows = config.windows.unwrap_or_default();
        assert_eq!(windows.install_mode.msiexec_args(), ["/passive"]);
    }
}
