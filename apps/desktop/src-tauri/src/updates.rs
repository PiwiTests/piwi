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
// state; `desktop_get_release_notes` reads the notes of every release between
// the installed and the found version from GitHub's releases API (anonymous,
// cached per found version); `desktop_install_update` downloads + installs it, streaming progress
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

use semver::Version;
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

/// The releases of the repository, newest first, as the releases page lists them.
const RELEASES_API: &str = "https://api.github.com/repos/PiwiTests/piwi/releases";
const RELEASES_PER_PAGE: usize = 30;
/// At most this many pages are read: the notes of the 120 newest releases.
const MAX_RELEASE_PAGES: usize = 4;
const NOTES_TIMEOUT: Duration = Duration::from_secs(15);

/// Whether this build carries updater config (set at startup from the
/// compiled Tauri config).
pub struct UpdaterSupport(pub bool);

/// The update found by the last successful check, awaiting installation.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

/// The version the last check found, and its release notes once read.
#[derive(Default)]
pub struct ReleaseNotesState(Mutex<Option<(Version, Option<ReleaseNotes>)>>);

/// One release between the installed and the offered version.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ReleaseNote {
    /// `0.67.0`
    version: String,
    /// When it was published (ISO 8601).
    date: Option<String>,
    /// Its release page.
    url: String,
    /// Its notes as Markdown, empty when it has none.
    body: String,
}

#[derive(Clone, serde::Serialize)]
pub struct ReleaseNotes {
    installed: String,
    offered: String,
    /// Newest first.
    releases: Vec<ReleaseNote>,
    /// False when the page limit was reached before the installed version.
    complete: bool,
}

/// A release as the GitHub API lists it, with only the fields read here.
#[derive(serde::Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    published_at: Option<String>,
    html_url: String,
    body: Option<String>,
}

/// The releases of one API page newer than `installed` and up to `offered`
/// (drafts, prereleases and tags that are not `v<semver>` left out), and
/// whether the page reaches the installed version or an older one, so no
/// further page is needed.
fn select_releases(
    page: &[GithubRelease],
    installed: &Version,
    offered: &Version,
) -> (Vec<ReleaseNote>, bool) {
    let mut selected = Vec::new();
    let mut reached = false;
    for release in page {
        if release.draft || release.prerelease {
            continue;
        }
        let Some(version) = release
            .tag_name
            .strip_prefix('v')
            .and_then(|v| Version::parse(v).ok())
            .filter(|v| v.pre.is_empty())
        else {
            continue;
        };
        if version <= *installed {
            reached = true;
        } else if version <= *offered {
            selected.push(ReleaseNote {
                version: version.to_string(),
                date: release.published_at.clone(),
                url: release.html_url.clone(),
                body: release.body.clone().unwrap_or_default(),
            });
        }
    }
    (selected, reached)
}

async fn fetch_release_page(
    client: &reqwest::Client,
    page: usize,
) -> Result<Vec<GithubRelease>, String> {
    let response = client
        .get(format!(
            "{RELEASES_API}?per_page={RELEASES_PER_PAGE}&page={page}"
        ))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "piwi-desktop")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return Err("GitHub limits anonymous requests; try again later".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub answered {status}"));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

async fn fetch_release_notes(
    installed: &Version,
    offered: &Version,
) -> Result<ReleaseNotes, String> {
    let client = reqwest::Client::builder()
        .timeout(NOTES_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut releases = Vec::new();
    let mut complete = false;
    for page in 1..=MAX_RELEASE_PAGES {
        let listed = fetch_release_page(&client, page).await?;
        let (selected, reached) = select_releases(&listed, installed, offered);
        releases.extend(selected);
        if reached || listed.len() < RELEASES_PER_PAGE {
            complete = true;
            break;
        }
    }
    releases.sort_by(|a, b| {
        let key = |r: &ReleaseNote| Version::parse(&r.version).ok();
        key(b).cmp(&key(a))
    });
    Ok(ReleaseNotes {
        installed: installed.to_string(),
        offered: offered.to_string(),
        releases,
        complete,
    })
}

/// The notes of every release after the installed version, up to the one the
/// last check found. Read once per found version, then answered from memory.
#[tauri::command]
pub async fn desktop_get_release_notes(app: AppHandle) -> Result<ReleaseNotes, String> {
    let state = app.state::<ReleaseNotesState>();
    let offered = {
        let held = state.0.lock().unwrap();
        match held.as_ref() {
            Some((_, Some(notes))) => return Ok(notes.clone()),
            Some((offered, None)) if is_supported(&app) => offered.clone(),
            _ => return Err("no update found, run a check first".into()),
        }
    };
    let installed = app.package_info().version.clone();
    match fetch_release_notes(&installed, &offered).await {
        Ok(notes) => {
            if let Some((version, cached)) = state.0.lock().unwrap().as_mut() {
                if *version == offered {
                    cached.replace(notes.clone());
                }
            }
            Ok(notes)
        }
        Err(e) => {
            if let Some(log) = app.try_state::<crate::LogFile>() {
                crate::append_log(&log.0, &format!("reading the release notes failed: {e}"));
            }
            Err(e)
        }
    }
}

/// Remember the version a check found, dropping the notes read for another one.
fn remember_offered(app: &AppHandle, version: &str) {
    let Ok(version) = Version::parse(version) else {
        return;
    };
    let mut held = app.state::<ReleaseNotesState>().0.lock().unwrap();
    if held.as_ref().map(|(v, _)| v) != Some(&version) {
        held.replace((version, None));
    }
}

fn is_supported(app: &AppHandle) -> bool {
    app.try_state::<UpdaterSupport>().is_some_and(|s| s.0)
}

#[derive(Clone, serde::Serialize)]
pub struct UpdateStatus {
    /// `unsupported` | `uptodate` | `available`
    state: &'static str,
    version: Option<String>,
    date: Option<String>,
}

impl UpdateStatus {
    fn bare(state: &'static str) -> Self {
        Self {
            state,
            version: None,
            date: None,
        }
    }

    fn available(update: &tauri_plugin_updater::Update) -> Self {
        Self {
            state: "available",
            version: Some(update.version.clone()),
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
            remember_offered(app, &update.version);
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
    use super::{select_releases, GithubRelease};
    use semver::Version;

    /// A page of the releases API, reduced to the fields the shell reads.
    fn page(json: &str) -> Vec<GithubRelease> {
        serde_json::from_str(json).unwrap()
    }

    fn release(tag: &str, draft: bool, prerelease: bool) -> String {
        format!(
            r#"{{"tag_name":"{tag}","draft":{draft},"prerelease":{prerelease},"published_at":"2026-11-05T10:00:00Z","html_url":"https://github.com/PiwiTests/piwi/releases/tag/{tag}","body":"notes of {tag}","id":1}}"#
        )
    }

    fn versions(page: &[GithubRelease], installed: &str, offered: &str) -> (Vec<String>, bool) {
        let (selected, reached) = select_releases(
            page,
            &Version::parse(installed).unwrap(),
            &Version::parse(offered).unwrap(),
        );
        (selected.into_iter().map(|r| r.version).collect(), reached)
    }

    #[test]
    fn keeps_the_releases_after_the_installed_version_up_to_the_offered_one() {
        let listed = page(&format!(
            "[{},{},{},{}]",
            release("v0.67.0", false, false),
            release("v0.66.0", false, false),
            release("v0.65.0", false, false),
            release("v0.64.0", false, false),
        ));
        let (selected, reached) = versions(&listed, "0.64.0", "0.67.0");
        assert_eq!(selected, ["0.67.0", "0.66.0", "0.65.0"]);
        assert!(reached);
        let first =
            &select_releases(&listed, &Version::new(0, 66, 0), &Version::new(0, 67, 0)).0[0];
        assert_eq!(first.body, "notes of v0.67.0");
        assert_eq!(
            first.url,
            "https://github.com/PiwiTests/piwi/releases/tag/v0.67.0"
        );
        assert_eq!(first.date.as_deref(), Some("2026-11-05T10:00:00Z"));
    }

    #[test]
    fn leaves_out_drafts_prereleases_and_other_tags() {
        let listed = page(&format!(
            "[{},{},{},{},{}]",
            release("v0.68.0", true, false),
            release("v0.67.0-rc.1", false, false),
            release("v0.67.0", false, true),
            release("reporter-v1.2.0", false, false),
            release("v0.66.0", false, false),
        ));
        assert_eq!(
            versions(&listed, "0.64.0", "0.68.0"),
            (vec!["0.66.0".to_string()], false)
        );
    }

    #[test]
    fn leaves_out_a_release_newer_than_the_offered_one() {
        let listed = page(&format!(
            "[{},{}]",
            release("v0.68.0", false, false),
            release("v0.67.0", false, false),
        ));
        assert_eq!(
            versions(&listed, "0.64.0", "0.67.0"),
            (vec!["0.67.0".to_string()], false)
        );
    }

    #[test]
    fn says_when_a_page_reaches_the_installed_version() {
        let older = page(&format!("[{}]", release("v0.63.0", false, false)));
        assert_eq!(versions(&older, "0.64.0", "0.67.0"), (vec![], true));
        let newer = page(&format!("[{}]", release("v0.65.0", false, false)));
        assert_eq!(
            versions(&newer, "0.64.0", "0.67.0"),
            (vec!["0.65.0".to_string()], false)
        );
    }

    #[test]
    fn reads_a_release_without_notes_as_empty() {
        let listed = page(
            r#"[{"tag_name":"v0.65.0","draft":false,"prerelease":false,"published_at":null,"html_url":"https://github.com/PiwiTests/piwi/releases/tag/v0.65.0","body":null}]"#,
        );
        let (selected, _) =
            select_releases(&listed, &Version::new(0, 64, 0), &Version::new(0, 65, 0));
        assert_eq!(selected[0].body, "");
        assert_eq!(selected[0].date, None);
    }

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
