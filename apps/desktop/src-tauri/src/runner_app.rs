// Piwi Runner: the shell of the app that runs the tests a team instance asks for on this machine.
//
// It is this crate built with the `runner` feature (`run` in lib.rs hands over to it). On launch it:
//   1. creates a per-user data folder for the folder links, the log and the settings,
//   2. spawns the Runner host (`apps/runner/server`) as a Node sidecar on a free loopback port,
//   3. waits for `GET /api/health` to answer its challenge with the proof of the token,
//   4. points the window at the host through a single-use session code (`/__piwi/session?code=…`).
// There is no database, updater or reporter discovery file: Runner is not a Piwi server, and nothing on this machine
// may take it for one. Everything binds 127.0.0.1. Its tray icon keeps it reachable by the team instance once the
// window closes, while Run in background is on (the default), and Start on login launches it hidden in the tray.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_deep_link::DeepLinkExt as _;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt as _;
use tauri_plugin_window_state::StateFlags;

use crate::mcp_clients::ServerInfo;
use crate::{
    app_menu_action, append_log, background_menu_items, bring_to_front, follow_notifications, hide_to_tray,
    hold_close_for_local_runs, live_sidecar_port, main_window_may_navigate, node_path, private_fs,
    quit_after_confirming, random_hex_32, reapply_splash_status, reveal_log, run_app_menu_action, show_splash_status,
    shut_down, supervise_server, toggle_run_in_background, toggle_start_on_login, LogFile, QuitConfirmed,
    RunInBackground, ServerGaveUp, ServerProcess, ShuttingDown, NODE_SIDECAR, READY_TIMEOUT_SECS, TRAY_RUN_BG_ID,
    TRAY_START_ON_LOGIN_ID,
};
use crate::session::{self, ProofPace, ServerSession, Session, SplashTexts};
use crate::{desktop_bring_to_front, desktop_open_external, run_target, runner};

/// The app's name, in its menu and in the questions it asks.
const APP_NAME: &str = "Piwi Runner";

/// The tray icon's tooltip.
const TRAY_TOOLTIP: &str = "Piwi Runner (click to open)";
/// The argument Start on login launches the app with: it starts in the tray, its window hidden.
const HIDDEN_ARG: &str = "--hidden";

/// Whether this launch starts in the tray: Start on login passes `--hidden` as the only argument, and a link that
/// launched the app is an argument of its own.
fn launched_hidden(args: &[String]) -> bool {
    args.len() == 2 && args[1] == HIDDEN_ARG
}

/// The log of the shell and of the host's output, in the app's data folder.
const LOG_FILE: &str = "runner.log";
/// The splash's status line once the host takes longer than `READY_TIMEOUT_SECS`.
const SPLASH_SLOW: &str =
    "The local host is taking longer than usual to start. Still waiting: the window opens once it is up.";
/// The splash's status line while the host restarts.
const SPLASH_RESTARTING: &str = "The local host stopped. Restarting it: the window opens again once it is up.";
/// How the wait for the host's proof paces itself.
const PROOF_PACE: ProofPace = ProofPace {
    slow_after: Duration::from_secs(READY_TIMEOUT_SECS),
    poll: Duration::from_millis(250),
    slow_poll: Duration::from_millis(1000),
};
/// The splash's status line once the supervisor stopped restarting the host.
const SPLASH_STOPPED: &str =
    "The local host stopped and could not be restarted. Quit and relaunch Piwi Runner.";

/// What the Runner host needs to be spawned again on the same port and token.
struct HostConfig {
    entry: PathBuf,
    token: String,
    port: u16,
    log_path: PathBuf,
}

/// A free loopback port for the host: Runner has no address anyone bookmarks, so it takes whatever is free.
fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .expect("failed to acquire a free loopback port")
}

/// The IPC grants of the window (`runtime-capabilities/runner.json`), scoped to the exact origin of the host this
/// launch spawned.
fn runner_capability(port: u16) -> String {
    let mut capability: serde_json::Value =
        serde_json::from_str(include_str!("../runtime-capabilities/runner.json"))
            .expect("runtime-capabilities/runner.json is valid JSON");
    capability["remote"] = json!({ "urls": [crate::sidecar_origin(port)] });
    capability.to_string()
}

/// The bundled host's entry. Tauri may place the resource at `<res>/resources/runner-host` (keeping the
/// config-relative path) or `<res>/runner-host`: accept either.
fn host_entry_candidates(resource_dir: &Path) -> [PathBuf; 2] {
    [
        resource_dir
            .join("resources")
            .join("runner-host")
            .join("server.cjs"),
        resource_dir.join("runner-host").join("server.cjs"),
    ]
}

/// Spawn the bundled Node sidecar running the Runner host. Returns its event stream and child handle, or `None` when
/// the sidecar is missing or the spawn fails (both logged; the readiness probe then times out).
fn spawn_host(
    app: &AppHandle,
    cfg: &HostConfig,
) -> Option<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild)> {
    let cmd = match app.shell().sidecar(NODE_SIDECAR) {
        Ok(cmd) => cmd,
        Err(e) => {
            append_log(&cfg.log_path, &format!("sidecar '{NODE_SIDECAR}' not found: {e}"));
            return None;
        }
    };
    let cmd = cmd
        .args([node_path(&cfg.entry)])
        .env("NODE_ENV", "production")
        .env("PIWI_RUNNER_PORT", cfg.port.to_string())
        .env("PIWI_DESKTOP_TOKEN", cfg.token.clone());
    match cmd.spawn() {
        Ok(pair) => Some(pair),
        Err(e) => {
            append_log(&cfg.log_path, &format!("failed to spawn the host: {e}"));
            None
        }
    }
}

/// The scheme of Runner's links. The desktop app keeps `piwi`, so a `piwi:` link never reaches Runner.
const RUNNER_LINK_SCHEME: &str = "piwi-runner";

/// The identifier of the Piwi Runner bundle (`runner.conf.json`).
const RUNNER_IDENTIFIER: &str = "io.piwitests.runner";

/// Why this build may not start as Piwi Runner, or `None` when it may: it starts only with Runner's own bundle
/// identifier (`runner.conf.json`).
fn identifier_refusal(identifier: &str) -> Option<String> {
    if identifier == RUNNER_IDENTIFIER {
        return None;
    }
    Some(format!(
        "Piwi Runner starts only with the identifier {RUNNER_IDENTIFIER}, and this build has {identifier}: \
         build it with --config src-tauri/runner.conf.json."
    ))
}

/// Whether `url` is the `piwi-runner://connect` link: the one link Runner answers. It carries nothing to act on, so
/// the link only brings the window forward; connecting an instance and every run stay a click in the window.
fn is_connect_link(url: &tauri::Url) -> bool {
    url.scheme() == RUNNER_LINK_SCHEME
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("connect"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
}

/// Bring the window forward for a `piwi-runner://connect` link; any other `piwi-runner://` link is ignored, and logged.
fn open_links(app: &AppHandle, urls: &[tauri::Url]) {
    // On macOS the files the app opens come through here too, as `file:` URLs.
    if !urls.iter().any(|url| url.scheme() == RUNNER_LINK_SCHEME) {
        return;
    }
    if urls.iter().any(is_connect_link) {
        if let Some(w) = app.get_webview_window("main") {
            bring_to_front(&w);
        }
        return;
    }
    if let Some(log) = app.try_state::<LogFile>() {
        append_log(
            &log.0,
            &format!("ignored a {RUNNER_LINK_SCHEME}:// link that Piwi Runner does not answer"),
        );
    }
}

/// The macOS menu bar: Tauri's default menu, with its Quit swapped for the one that asks before it stops runs that
/// are going, so About, Hide, Window and Edit stay as macOS applications have them.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn menu<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::MenuItemKind;

    let menu = tauri::menu::Menu::default(app)?;
    let default_name = app.package_info().name.clone();
    for entry in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = entry {
            if submenu.text()? == default_name {
                crate::replace_quit(app, &submenu, APP_NAME)?;
            }
        }
    }
    Ok(menu)
}

/// The tray icon: a click opens the window, and its menu holds Open, Show logs, Run in background, Start on login and
/// Quit.
fn tray(app: &tauri::App) -> tauri::Result<()> {
    let open_i = MenuItemBuilder::with_id("open", format!("Open {APP_NAME}")).build(app)?;
    let logs_i = MenuItemBuilder::with_id("show_logs", "Show logs").build(app)?;
    let (bg_i, login_i) = background_menu_items(app)?;
    let quit_i = MenuItemBuilder::with_id("quit", format!("Quit {APP_NAME}")).build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open_i)
        .item(&logs_i)
        .separator()
        .item(&bg_i)
        .item(&login_i)
        .separator()
        .item(&quit_i)
        .build()?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(TRAY_TOOLTIP)
        .menu(&menu)
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
            "show_logs" => reveal_log(app),
            TRAY_RUN_BG_ID => toggle_run_in_background(app, &bg_i),
            TRAY_START_ON_LOGIN_ID => toggle_start_on_login(app, &login_i),
            "quit" => quit_after_confirming(app, APP_NAME),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub(crate) fn run(context: tauri::Context<tauri::Wry>) {
    if let Some(refusal) = identifier_refusal(&context.config().identifier) {
        eprintln!("{refusal}");
        std::process::exit(2);
    }
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch focuses the running window and starts no second host.
            if let Some(w) = app.get_webview_window("main") {
                bring_to_front(&w);
            }
        }))
        // `piwi-runner://connect` links (`open_links`). Registered after single-instance, which hands it a second launch's
        // link.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    StateFlags::all().difference(StateFlags::VISIBLE.union(StateFlags::FULLSCREEN)),
                )
                .build(),
        )
        // The window stays on the app's own pages and the host's exact origin.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("piwi-navigation")
                .on_navigation(|webview, url| {
                    let dev_url = if tauri::is_dev() {
                        webview.config().build.dev_url.as_ref()
                    } else {
                        None
                    };
                    webview.label() != "main"
                        || main_window_may_navigate(url, live_sidecar_port(webview.app_handle()), dev_url)
                })
                .on_page_load(|webview, payload| {
                    if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Finished {
                        reapply_splash_status(webview);
                    }
                })
                .build(),
        );
    #[cfg(feature = "e2e-testing")]
    {
        builder = builder.plugin(tauri_plugin_playwright::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            desktop_bring_to_front,
            desktop_open_external,
            runner::desktop_stop_local_tests,
            run_target::desktop_keep_run_target_key,
            run_target::desktop_forget_run_target,
            run_target::desktop_request_folders,
            run_target::desktop_link_request_folder,
            run_target::desktop_unlink_request_folder,
            run_target::desktop_run_requested_tests
        ])
        .manage(ServerProcess::default())
        .manage(ServerGaveUp::default())
        .manage(runner::LocalRuns::default())
        .manage(run_target::KeptKey::default())
        .manage(run_target::RequestedRuns::default())
        .manage(QuitConfirmed::default())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            private_fs::create_private_dir(&app_data_dir)?;
            let log_dir = app_data_dir.join("logs");
            let _ = std::fs::create_dir_all(&log_dir);
            let log_path = log_dir.join(LOG_FILE);
            append_log(&log_path, "----- launch -----");
            app.manage(LogFile(log_path.clone()));
            run_target::sweep_leftover_request_dirs(app.handle());
            app.manage(Session::new(
                app.get_webview_window("main").and_then(|w| w.url().ok()),
                app.config().build.dev_url.as_ref().filter(|_| tauri::is_dev()),
            ));

            // Nothing outlives this launch: the token is made now and kept nowhere.
            let token = random_hex_32();
            let port = free_port();
            app.handle().add_capability(runner_capability(port))?;
            app.manage(ServerInfo {
                port,
                token: token.clone(),
            });

            let shutting_down = Arc::new(AtomicBool::new(false));
            app.manage(ShuttingDown(shutting_down.clone()));

            let resource_dir = app.path().resource_dir()?;
            let candidates = host_entry_candidates(&resource_dir);
            let entry = candidates
                .iter()
                .find(|p| p.exists())
                .cloned()
                .unwrap_or_else(|| candidates[0].clone());
            append_log(
                &log_path,
                &format!(
                    "host entry: {} (exists: {}), port: {}",
                    entry.display(),
                    entry.exists(),
                    port
                ),
            );

            let host = HostConfig {
                entry,
                token: token.clone(),
                port,
                log_path: log_path.clone(),
            };
            if let Some(initial) = spawn_host(app.handle(), &host) {
                supervise_server(
                    app.handle().clone(),
                    log_path.clone(),
                    move |app| spawn_host(app, &host),
                    initial,
                    shutting_down.clone(),
                    ServerSession {
                        port,
                        token: token.clone(),
                        texts: SplashTexts {
                            restarting: SPLASH_RESTARTING,
                            slow: SPLASH_SLOW,
                            stopped: SPLASH_STOPPED,
                        },
                        pace: &PROOF_PACE,
                    },
                );
            } else {
                crate::give_up_server(app.handle());
            }

            // When the host is ready, follow its notifications (the stop of a run, asked in the dashboard) and
            // navigate the window to it. The wait goes on past `READY_TIMEOUT_SECS`, which only changes what the
            // splash says, and ends when the supervisor gives up or the app quits.
            let nav_handle = app.handle().clone();
            let quitting = shutting_down.clone();
            std::thread::spawn(move || {
                let proved = session::await_first_proof(
                    port,
                    &token,
                    &PROOF_PACE,
                    || session::generation_of(&nav_handle),
                    || {
                        if let Some(session) = nav_handle.try_state::<Session>() {
                            session.mark_opened();
                        }
                    },
                    || nav_handle.state::<ServerGaveUp>().0.load(Ordering::SeqCst) || quitting.load(Ordering::SeqCst),
                    || {
                        append_log(&log_path, "host not ready yet, still waiting");
                        show_splash_status(&nav_handle, SPLASH_SLOW, true);
                    },
                );
                let ready = proved.is_some();
                append_log(
                    &log_path,
                    if ready {
                        "host ready"
                    } else {
                        "host never became ready"
                    },
                );
                if !ready {
                    if !quitting.load(Ordering::SeqCst) {
                        show_splash_status(&nav_handle, SPLASH_STOPPED, true);
                    }
                    return;
                }
                let holds = session::proof_holds(&nav_handle, proved.unwrap_or_default(), quitting.clone());
                follow_notifications(nav_handle.clone(), port, token.clone(), quitting.clone());
                let server = ServerSession {
                    port,
                    token: token.clone(),
                    texts: SplashTexts {
                        restarting: SPLASH_RESTARTING,
                        slow: SPLASH_SLOW,
                        stopped: SPLASH_STOPPED,
                    },
                    pace: &PROOF_PACE,
                };
                if let Err(error) = session::open_first_session(&nav_handle, &server, None, holds) {
                    append_log(&log_path, &format!("no session code: {error}"));
                }
            });

            // Runner is how the team instance reaches this machine, so closing its window leaves it in the tray
            // until the person turns Run in background off.
            app.manage(RunInBackground::from_saved(app.handle(), true));
            tray(app)?;
            if launched_hidden(&std::env::args().collect::<Vec<_>>()) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            #[cfg(target_os = "macos")]
            {
                app.set_menu(menu(app.handle())?)?;
                app.on_menu_event(|app, event| {
                    if let Some(action) = app_menu_action(event.id().as_ref()) {
                        run_app_menu_action(app, APP_NAME, action);
                    }
                });
            }

            // Links into the app: the one that launched it (Windows and Linux pass it as the argument), then each
            // one that comes while it runs.
            #[cfg(target_os = "linux")]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(e) = handle.deep_link().register_all() {
                        if let Some(log) = handle.try_state::<LogFile>() {
                            append_log(
                                &log.0,
                                &format!("could not register {RUNNER_LINK_SCHEME}:// links: {e}"),
                            );
                        }
                    }
                });
            }
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                open_links(app.handle(), &urls);
            }
            let link_handle = app.handle().clone();
            app.deep_link()
                .on_open_url(move |event| open_links(&link_handle, &event.urls()));

            #[cfg(feature = "e2e-testing")]
            {
                let _ = app
                    .handle()
                    .add_capability(crate::E2E_PLAYWRIGHT_CAPABILITY);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it to the tray while Run in background is on, and otherwise quits, once the
            // user agrees to stop the runs still going.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && (hide_to_tray(window) || hold_close_for_local_runs(window, APP_NAME)) {
                    api.prevent_close();
                }
            }
        })
        .build(context)
        .expect("error while building the Piwi Runner app")
        .run(|app_handle, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => shut_down(app_handle, None),
            // macOS: a click on the Dock icon brings back the window Run in background hid.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                if let Some(w) = app_handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false) {
                        bring_to_front(&w);
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> tauri::Url {
        tauri::Url::parse(text).expect("a valid URL")
    }

    #[test]
    fn only_the_connect_link_is_answered() {
        assert!(is_connect_link(&url("piwi-runner://connect")));
        assert!(is_connect_link(&url("piwi-runner://CONNECT/")));
        // Anything it carries is not read.
        assert!(is_connect_link(&url(
            "piwi-runner://connect?instance=https://evil.example"
        )));
        assert!(!is_connect_link(&url("piwi-runner://open/runs")));
        assert!(!is_connect_link(&url("piwi-runner://connect.evil.example")));
        assert!(!is_connect_link(&url("piwi-runner://user@connect")));
        assert!(!is_connect_link(&url("piwi-runner://connect:80")));
        assert!(!is_connect_link(&url("https://connect")));
        assert!(!is_connect_link(&url("piwi-runner:///connect")));
    }

    #[test]
    fn the_desktop_apps_links_are_not_answered() {
        assert!(!is_connect_link(&url("piwi://connect")));
        assert!(!is_connect_link(&url("piwi://open/runs")));
    }

    #[test]
    fn only_start_on_logins_launch_starts_in_the_tray() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert!(launched_hidden(&args(&["piwi-runner", "--hidden"])));
        assert!(!launched_hidden(&args(&["piwi-runner"])));
        assert!(!launched_hidden(&args(&["piwi-runner", "piwi-runner://connect"])));
        assert!(!launched_hidden(&args(&["piwi-runner", "piwi-runner://connect", "--hidden"])));
        assert!(!launched_hidden(&args(&["piwi-runner", "--hidden", "--hidden"])));
    }

    #[test]
    fn only_runners_own_identifier_starts_it() {
        assert_eq!(identifier_refusal("io.piwitests.runner"), None);
        let refusal =
            identifier_refusal("io.piwitests.dashboard").expect("the desktop app's identifier");
        assert!(refusal.contains("io.piwitests.runner"), "{refusal}");
        assert!(refusal.contains("io.piwitests.dashboard"), "{refusal}");
        assert!(refusal.contains("runner.conf.json"), "{refusal}");
        assert!(identifier_refusal("").is_some());
        assert!(identifier_refusal("io.piwitests.runner.other").is_some());
        assert!(identifier_refusal("IO.PIWITESTS.RUNNER").is_some());
    }

    #[test]
    fn the_bundle_config_names_runner_alone() {
        let patch: serde_json::Value =
            serde_json::from_str(include_str!("../runner.conf.json")).unwrap();
        assert_eq!(patch["identifier"], RUNNER_IDENTIFIER);
        assert_eq!(
            patch["plugins"]["deep-link"]["desktop"]["schemes"],
            serde_json::json!([RUNNER_LINK_SCHEME])
        );
    }

    #[test]
    fn the_menus_quit_is_the_one_that_asks_before_stopping_runs() {
        assert_eq!(
            crate::app_menu_action(crate::APP_MENU_QUIT_ID),
            Some(crate::AppMenuAction::Quit)
        );
    }

    #[test]
    fn the_quit_question_names_the_app() {
        assert_eq!(crate::quit_question(APP_NAME), "Quit Piwi Runner?");
        assert_eq!(crate::quit_question(crate::DESKTOP_APP_NAME), "Quit Piwi Desktop?");
    }

    #[test]
    fn the_host_is_found_in_either_resource_layout() {
        let [nested, flat] = host_entry_candidates(Path::new("/res"));
        assert_eq!(nested, Path::new("/res/resources/runner-host/server.cjs"));
        assert_eq!(flat, Path::new("/res/runner-host/server.cjs"));
    }

    #[test]
    fn the_free_port_can_be_bound() {
        let port = free_port();
        assert!(port > 0);
        assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
    }

    #[test]
    fn the_capability_is_scoped_to_the_hosts_origin_and_the_main_window() {
        let capability: serde_json::Value = serde_json::from_str(&runner_capability(4321)).unwrap();
        assert_eq!(
            capability["remote"]["urls"],
            json!(["http://127.0.0.1:4321"])
        );
        assert_eq!(capability["windows"], json!(["main"]));
    }

    #[test]
    fn the_capability_grants_the_commands_the_window_is_registered_with() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../runtime-capabilities/runner.json")).unwrap();
        let mut granted: Vec<String> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .filter_map(|p| p.strip_prefix("allow-"))
            .map(|p| p.replace('-', "_"))
            .collect();
        granted.sort();
        let source = include_str!("runner_app.rs");
        let block = source
            .split("generate_handler![")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .unwrap();
        let mut registered: Vec<String> = block
            .split(',')
            .map(|name| name.trim().rsplit("::").next().unwrap().to_string())
            .filter(|name| !name.is_empty())
            .collect();
        registered.sort();
        assert_eq!(granted, registered);
    }

    #[test]
    fn the_app_never_publishes_the_discovery_file() {
        // The reporter, the MCP bridge and the editor take `~/.piwi/desktop.json` for a Piwi server: Runner is not one.
        let source = include_str!("runner_app.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        assert!(!code.contains("write_discovery_file"));
        assert!(!code.contains("DiscoveryFile"));
        assert!(!code.contains("DISCOVERY_FILE"));
    }
}
