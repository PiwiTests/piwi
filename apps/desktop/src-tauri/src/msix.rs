// The MSIX package, the Microsoft Store build: whether this process runs from it, and what differs when it does.
//
// The package is installed under `WindowsApps`, in a folder named after its version, so another app starts it
// through the app execution alias the manifest declares (`piwi-desktop.exe` in `%LOCALAPPDATA%\Microsoft\WindowsApps`),
// never by the executable's own path. Start on login is the package's startup task (`PiwiStartup`, started with
// `--hidden`), which the user also sees in Settings → Apps → Startup. The Store updates the package, so the build
// carries no updater. All three are declared in `windows/AppxManifest.xml`.

use std::path::{Path, PathBuf};

/// The app execution alias `windows/AppxManifest.xml` declares.
pub const ALIAS: &str = "piwi-desktop.exe";

/// The startup task `windows/AppxManifest.xml` declares.
#[cfg(windows)]
const STARTUP_TASK_ID: &str = "PiwiStartup";

/// Whether this process runs from an MSIX package.
pub fn is_packaged() -> bool {
    static PACKAGED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *PACKAGED.get_or_init(current_package_exists)
}

#[cfg(windows)]
fn current_package_exists() -> bool {
    use windows::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    let mut length = 0u32;
    // With no buffer, a packaged process is told the buffer is too small for its package's name; any other process
    // is told it has no package (APPMODEL_ERROR_NO_PACKAGE).
    unsafe { GetCurrentPackageFullName(&mut length, None) == ERROR_INSUFFICIENT_BUFFER }
}

#[cfg(not(windows))]
fn current_package_exists() -> bool {
    false
}

/// The alias's path under `local_app_data` (`%LOCALAPPDATA%`).
pub fn alias_path(local_app_data: &Path) -> PathBuf {
    local_app_data
        .join("Microsoft")
        .join("WindowsApps")
        .join(ALIAS)
}

#[cfg(windows)]
fn startup_task() -> windows::core::Result<windows::ApplicationModel::StartupTask> {
    windows::ApplicationModel::StartupTask::GetAsync(&windows::core::HSTRING::from(
        STARTUP_TASK_ID,
    ))?
    .join()
}

/// Whether the package's startup task is on.
#[cfg(windows)]
pub fn startup_task_enabled() -> bool {
    use windows::ApplicationModel::StartupTaskState;
    startup_task()
        .and_then(|task| task.State())
        .is_ok_and(|state| {
            state == StartupTaskState::Enabled || state == StartupTaskState::EnabledByPolicy
        })
}

#[cfg(not(windows))]
pub fn startup_task_enabled() -> bool {
    false
}

/// Turn the package's startup task on or off. Windows keeps it off when the user turned it off in Settings, or a
/// policy did: the error says where to turn it back on.
#[cfg(windows)]
pub fn set_startup_task(enabled: bool) -> Result<(), String> {
    use windows::ApplicationModel::StartupTaskState;
    let task = startup_task().map_err(|e| e.to_string())?;
    if !enabled {
        return task.Disable().map_err(|e| e.to_string());
    }
    let state = task
        .RequestEnableAsync()
        .and_then(|op| op.join())
        .map_err(|e| e.to_string())?;
    match state {
        StartupTaskState::Enabled | StartupTaskState::EnabledByPolicy => Ok(()),
        StartupTaskState::DisabledByUser => Err(
            "Start on login is turned off for Piwi Dashboard in Windows Settings → Apps → Startup; turn it on there."
                .to_string(),
        ),
        StartupTaskState::DisabledByPolicy => {
            Err("A policy on this computer keeps Piwi Dashboard from starting on login.".to_string())
        }
        _ => Err("Windows did not turn on start on login.".to_string()),
    }
}

#[cfg(not(windows))]
pub fn set_startup_task(_enabled: bool) -> Result<(), String> {
    Err("Only the Windows package has a startup task.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_alias_is_in_the_folder_windows_puts_on_path() {
        let local = Path::new("/Users/dev/AppData/Local");
        assert_eq!(
            alias_path(local),
            local
                .join("Microsoft")
                .join("WindowsApps")
                .join("piwi-desktop.exe")
        );
    }

    #[test]
    fn the_manifest_declares_the_alias_and_the_startup_task_the_shell_uses() {
        let manifest = include_str!("../windows/AppxManifest.xml");
        assert!(manifest.contains(&format!(r#"Alias="{ALIAS}""#)));
        assert!(manifest.contains(r#"TaskId="PiwiStartup""#));
        assert!(manifest.contains(r#"uap10:Parameters="--hidden""#));
    }

    #[test]
    fn a_test_process_is_not_packaged() {
        assert!(!is_packaged());
    }
}
