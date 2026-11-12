//! Start on login across the product's names.
//!
//! The autostart plugin names its entry after the product (`package_info().name`): a Windows `Run` value, a macOS
//! LaunchAgent, a Linux `~/.config/autostart` file. The desktop app's earlier releases were installed as
//! `FORMER_PRODUCT_NAME`, so an entry under that name is theirs: at startup it is moved under the current name, kept
//! on, pointing at the running executable (`move_former_entry`).

use auto_launch::{AutoLaunch, AutoLaunchBuilder};
use tauri::AppHandle;
use tauri_plugin_autostart::{AutoLaunchManager, ManagerExt as _};

/// The product name the desktop app's earlier releases were installed under. The Windows installers remove such an
/// install (`windows/installer-hooks.nsh`, the MSI's pinned `upgradeCode`) and the Linux packages replace
/// `piwi-dashboard` (`tauri.conf.json`).
pub(crate) const FORMER_PRODUCT_NAME: &str = "Piwi Dashboard";

/// A start-on-login entry: the plugin's, under the current name, or one built for another name.
pub(crate) trait LoginEntry {
    fn is_on(&self) -> Result<bool, String>;
    fn turn_on(&self) -> Result<(), String>;
    fn turn_off(&self) -> Result<(), String>;
}

impl LoginEntry for AutoLaunchManager {
    fn is_on(&self) -> Result<bool, String> {
        self.is_enabled().map_err(|e| e.to_string())
    }
    fn turn_on(&self) -> Result<(), String> {
        self.enable().map_err(|e| e.to_string())
    }
    fn turn_off(&self) -> Result<(), String> {
        self.disable().map_err(|e| e.to_string())
    }
}

impl LoginEntry for AutoLaunch {
    fn is_on(&self) -> Result<bool, String> {
        self.is_enabled().map_err(|e| e.to_string())
    }
    fn turn_on(&self) -> Result<(), String> {
        self.enable().map_err(|e| e.to_string())
    }
    fn turn_off(&self) -> Result<(), String> {
        self.disable().map_err(|e| e.to_string())
    }
}

/// Moves an entry that is on under the former name to the current one: the current entry is turned on first, so a
/// failure leaves the former one in place to try again at the next start. Returns whether an entry moved.
pub(crate) fn move_entry(
    former: &impl LoginEntry,
    current: &impl LoginEntry,
) -> Result<bool, String> {
    if !former.is_on()? {
        return Ok(false);
    }
    if !current.is_on()? {
        current.turn_on()?;
    }
    former.turn_off()?;
    Ok(true)
}

/// The entry of the former name, for this executable. Only its name locates it; the path and arguments are the ones
/// the plugin writes (`--hidden`, in `lib.rs`).
fn former_entry() -> Result<AutoLaunch, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut builder = AutoLaunchBuilder::new();
    builder
        .set_app_name(FORMER_PRODUCT_NAME)
        .set_app_path(&exe.display().to_string())
        .set_args(&["--hidden"]);
    #[cfg(target_os = "macos")]
    builder.set_macos_launch_mode(auto_launch::MacOSLaunchMode::LaunchAgent);
    builder.build().map_err(|e| e.to_string())
}

/// Moves the former name's start-on-login entry under the current name, once per start of an installed build. A
/// development build leaves both alone, so it never takes over the installed app's entry. Returns what to log.
pub(crate) fn move_former_entry(app: &AppHandle) -> Option<String> {
    if tauri::is_dev() || app.package_info().name == FORMER_PRODUCT_NAME {
        return None;
    }
    let moved = former_entry().and_then(|former| move_entry(&former, app.autolaunch().inner()));
    match moved {
        Ok(true) => Some(format!(
            "start on login moved from {FORMER_PRODUCT_NAME} to {}",
            app.package_info().name
        )),
        Ok(false) => None,
        Err(e) => Some(format!(
            "start on login of {FORMER_PRODUCT_NAME} could not be moved: {e}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[derive(Default)]
    struct Entry {
        on: Cell<bool>,
        fails: bool,
    }

    impl LoginEntry for Entry {
        fn is_on(&self) -> Result<bool, String> {
            Ok(self.on.get())
        }
        fn turn_on(&self) -> Result<(), String> {
            if self.fails {
                return Err("refused".into());
            }
            self.on.set(true);
            Ok(())
        }
        fn turn_off(&self) -> Result<(), String> {
            self.on.set(false);
            Ok(())
        }
    }

    fn entry(on: bool) -> Entry {
        Entry {
            on: Cell::new(on),
            fails: false,
        }
    }

    #[test]
    fn an_entry_on_under_the_former_name_moves_to_the_current_one() {
        let (former, current) = (entry(true), entry(false));
        assert_eq!(move_entry(&former, &current), Ok(true));
        assert!(!former.on.get());
        assert!(current.on.get());
    }

    #[test]
    fn a_current_entry_already_on_stays_on_and_the_former_one_goes() {
        let (former, current) = (entry(true), entry(true));
        assert_eq!(move_entry(&former, &current), Ok(true));
        assert!(!former.on.get());
        assert!(current.on.get());
    }

    #[test]
    fn no_former_entry_changes_nothing() {
        for on in [false, true] {
            let (former, current) = (entry(false), entry(on));
            assert_eq!(move_entry(&former, &current), Ok(false));
            assert_eq!(current.on.get(), on);
        }
    }

    #[test]
    fn a_current_entry_that_cannot_be_written_keeps_the_former_one() {
        let former = entry(true);
        let current = Entry {
            fails: true,
            ..entry(false)
        };
        assert!(move_entry(&former, &current).is_err());
        assert!(former.on.get());
    }

    /// The Windows installers, the Linux packages and this module name the same former product.
    #[test]
    fn the_installers_and_packages_name_the_same_former_product() {
        let hooks = include_str!("../windows/installer-hooks.nsh");
        assert!(hooks.contains(&format!(
            "!define PIWI_FORMER_NAME \"{FORMER_PRODUCT_NAME}\""
        )));
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let package = FORMER_PRODUCT_NAME.to_lowercase().replace(' ', "-");
        let linux = &conf["bundle"]["linux"];
        for list in [
            &linux["deb"]["conflicts"],
            &linux["deb"]["replaces"],
            &linux["rpm"]["obsoletes"],
        ] {
            assert!(
                list.as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v == package.as_str()),
                "{list}"
            );
        }
    }
}
